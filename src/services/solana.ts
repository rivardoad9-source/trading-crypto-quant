import axios from "axios";
import { env } from "../config/env.js";
import { HTTP_TIMEOUT_MS } from "../config/constants.js";

/**
 * Thin JSON-RPC helper for the Solana mainnet endpoint.
 *
 * Method availability differs by provider. The public `api.mainnet-beta.solana.com`
 * endpoint permanently rejects `getTokenLargestAccounts` with HTTP 429
 * ("Too many requests for a specific RPC call"), so holder-concentration screening
 * needs a real provider (Helius, Triton, QuickNode). `getAccountInfo`,
 * `getTokenSupply` and `getRecentPrioritizationFees` do work on the public node.
 */

interface RpcError {
  code: number;
  message: string;
}

export class SolanaRpcError extends Error {
  readonly code: number;

  constructor(method: string, error: RpcError) {
    super(`[solana] ${method} failed (${error.code}): ${error.message}`);
    this.name = "SolanaRpcError";
    this.code = error.code;
  }
}

let requestId = 0;

async function rpc<T>(
  method: string,
  params: unknown[],
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<T> {
  const res = await axios.post(
    env.SOLANA_RPC_URL,
    { jsonrpc: "2.0", id: ++requestId, method, params },
    { timeout: timeoutMs, headers: { "Content-Type": "application/json" } },
  );

  const body = res.data as { result?: T; error?: RpcError };
  if (body.error) throw new SolanaRpcError(method, body.error);
  if (body.result === undefined) throw new Error(`[solana] ${method} returned no result`);
  return body.result;
}

/* ------------------------------------------------------------------ */
/* RPC health probe                                                    */
/* ------------------------------------------------------------------ */

/**
 * "ok"          the node answered and reported a slot.
 * "degraded"    the node ANSWERED but refused — a JSON-RPC error, or an HTTP status
 *               such as 429. Reachable and unusable is a different fact from
 *               unreachable, and the dashboard shows it differently.
 * "unreachable" nothing came back: DNS, connection, or timeout.
 */
export type RpcHealthStatus = "ok" | "degraded" | "unreachable";

export interface RpcHealth {
  status: RpcHealthStatus;
  /**
   * Round-trip in milliseconds, or null when the call never completed. Never 0 —
   * an unmeasured latency reported as zero would render as an impossibly fast node,
   * the same reason est_gas_cost_usd stays null rather than becoming 0.
   */
  latencyMs: number | null;
  /** The slot the node served, which is what makes this a liveness check and not a ping. */
  slot: number | null;
  /**
   * HOST ONLY. `SOLANA_RPC_URL` carries the provider API key in its path or query on
   * Helius, Triton and QuickNode, and this value is served over HTTP to a browser.
   */
  endpoint: string;
  method: "getSlot";
  checkedAt: string;
  /** Why it is not ok; null when it is. */
  detail: string | null;
}

/**
 * `getSlot`, not `getHealth`.
 *
 * `getHealth` is the method named for this job, but a provider that does not expose it
 * answers with a JSON-RPC error that is indistinguishable from an unhealthy node — the
 * widget would read "degraded" forever against a perfectly good endpoint. `getSlot` is
 * universally supported, just as cheap, and its answer additionally proves the node is
 * following the chain rather than merely accepting connections.
 */
const RPC_PROBE_METHOD = "getSlot" as const;

/** Short on purpose: /api/health must not be able to hang behind a slow provider. */
const RPC_PROBE_TIMEOUT_MS = 2500;

/** How long one measurement is allowed to answer for. */
export const RPC_PROBE_TTL_MS = 15_000;

/** The configured URL can embed an API key, so only the host ever leaves this process. */
function rpcEndpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable-url";
  }
}

/**
 * True when the endpoint answered us, whatever it said.
 *
 * A 429 is not "unreachable" — it is a node that replied, quickly, to say no. Filing
 * rate limiting under "unreachable" would hide the single most likely thing to be wrong
 * with the default public endpoint, which already refuses getTokenLargestAccounts.
 */
function endpointAnswered(err: unknown): boolean {
  if (err instanceof SolanaRpcError) return true;
  return axios.isAxiosError(err) && err.response !== undefined;
}

export async function measureRpcHealth(): Promise<RpcHealth> {
  const startedAt = Date.now();
  const base = {
    endpoint: rpcEndpointHost(env.SOLANA_RPC_URL),
    method: RPC_PROBE_METHOD,
    checkedAt: new Date().toISOString(),
  };

  try {
    const slot = await rpc<number>(
      RPC_PROBE_METHOD,
      [{ commitment: "processed" }],
      RPC_PROBE_TIMEOUT_MS,
    );
    return {
      ...base,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      slot: typeof slot === "number" ? slot : null,
      detail: null,
    };
  } catch (err) {
    const answered = endpointAnswered(err);
    return {
      ...base,
      status: answered ? "degraded" : "unreachable",
      // A refusal was still timed. A timeout was not, and stays null.
      latencyMs: answered ? Date.now() - startedAt : null,
      slot: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export type RpcProbe = () => Promise<RpcHealth>;

let rpcHealthCache: RpcHealth | null = null;
let rpcHealthInFlight: Promise<RpcHealth> | null = null;

/** Single-flight: concurrent readers share one measurement instead of racing the node. */
function startProbe(probe: RpcProbe): Promise<RpcHealth> {
  rpcHealthInFlight ??= probe()
    .then((result) => {
      rpcHealthCache = result;
      return result;
    })
    .finally(() => {
      rpcHealthInFlight = null;
    });
  return rpcHealthInFlight;
}

/**
 * The RPC health behind /api/health, cached and refreshed lazily.
 *
 * The dashboard polls that route once a minute PER OPEN TAB, and the default public
 * endpoint rate-limits hard, so probing on every request would turn a status widget into
 * a generator of 429s — it would report the outage it caused. Reads come from a
 * short-lived cache instead.
 *
 * Only the very first read waits for the network. After that a stale cache is served
 * immediately and the refresh lands in the background, because a liveness endpoint must
 * not block on a third party. Nothing here schedules a timer: an interval would be a
 * live handle for the smoke test to drain, and a node nobody is watching is not worth
 * probing.
 */
export async function readRpcHealth(probe: RpcProbe = measureRpcHealth): Promise<RpcHealth> {
  const cached = rpcHealthCache;
  const fresh = cached !== null && Date.now() - Date.parse(cached.checkedAt) <= RPC_PROBE_TTL_MS;
  if (fresh) return cached;

  const running = startProbe(probe);
  if (cached !== null) {
    // measureRpcHealth resolves on failure rather than rejecting, but a caller-supplied
    // probe might not, and an unhandled rejection must not come out of a health read.
    running.catch(() => undefined);
    return cached;
  }

  // Nothing has been measured yet, so this one read waits. It still cannot fail: a
  // liveness route that 500s because a third-party probe threw would announce an outage
  // of the wrong system. The reading is deliberately not cached, so the next read retries.
  try {
    return await running;
  } catch (err) {
    return {
      status: "unreachable",
      latencyMs: null,
      slot: null,
      endpoint: rpcEndpointHost(env.SOLANA_RPC_URL),
      method: RPC_PROBE_METHOD,
      checkedAt: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Test seam, and the honest way to drop a measurement that is no longer about this process. */
export function resetRpcHealthCache(): void {
  rpcHealthCache = null;
  rpcHealthInFlight = null;
}

/* ------------------------------------------------------------------ */
/* Priority fees                                                       */
/* ------------------------------------------------------------------ */

const LAMPORTS_PER_SOL = 1_000_000_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;
/** Base network fee, 5000 lamports per signature. */
const BASE_FEE_LAMPORTS = 5_000;

export interface PriorityFeeEstimate {
  /** Percentile used across the sampled slots. */
  percentile: number;
  /** Micro-lamports per compute unit. */
  microLamportsPerCu: number;
  /** Priority portion only, in lamports. */
  priorityLamports: number;
  /** Priority + base signature fee, in lamports. */
  totalLamports: number;
  totalSol: number;
  /** null when no SOL price was supplied. */
  totalUsd: number | null;
  computeUnits: number;
  samples: number;
  sampledAt: string;
}

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Estimates the priority fee for one transaction from recent on-chain samples.
 *
 * `getRecentPrioritizationFees` returns roughly the last 150 slots. Most slots
 * report 0, so a mean would collapse to zero and a max would chase outliers; a high
 * percentile is the usual compromise.
 *
 * @param solPriceUsd pass the live SOL price to get a USD figure, otherwise null.
 * @param lockedAccounts optionally scope the sample to accounts the transaction writes.
 */
export async function getPriorityFeeEstimate(options: {
  solPriceUsd?: number | null;
  lockedAccounts?: string[];
  computeUnits?: number;
  percentile?: number;
} = {}): Promise<PriorityFeeEstimate> {
  const percentile = options.percentile ?? env.PRIORITY_FEE_PERCENTILE;
  const computeUnits = options.computeUnits ?? env.PRIORITY_FEE_COMPUTE_UNITS;

  const samples = await rpc<Array<{ prioritizationFee: number; slot: number }>>(
    "getRecentPrioritizationFees",
    [options.lockedAccounts ?? []],
  );

  const fees = samples
    .map((s) => s.prioritizationFee)
    .filter((f) => Number.isFinite(f) && f >= 0)
    .sort((a, b) => a - b);

  const microLamportsPerCu = percentileOf(fees, percentile);

  // priority lamports = (microLamports/CU * CU) / 1e6
  const priorityLamports = (microLamportsPerCu * computeUnits) / MICRO_LAMPORTS_PER_LAMPORT;
  const totalLamports = priorityLamports + BASE_FEE_LAMPORTS;
  const totalSol = totalLamports / LAMPORTS_PER_SOL;

  return {
    percentile,
    microLamportsPerCu,
    priorityLamports,
    totalLamports,
    totalSol,
    totalUsd:
      options.solPriceUsd && options.solPriceUsd > 0 ? totalSol * options.solPriceUsd : null,
    computeUnits,
    samples: fees.length,
    sampledAt: new Date().toISOString(),
  };
}

/**
 * Never throws. Returns null when the RPC is unreachable, so a fee estimate cannot
 * block a cycle — but callers must then treat the cost as unknown, not as zero.
 */
export async function getPriorityFeeEstimateSafe(
  options: Parameters<typeof getPriorityFeeEstimate>[0] = {},
): Promise<PriorityFeeEstimate | null> {
  try {
    return await getPriorityFeeEstimate(options);
  } catch (err) {
    console.warn(`[solana] priority fee estimate unavailable: ${(err as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Mint authorities                                                    */
/* ------------------------------------------------------------------ */

export interface MintAuthorities {
  mint: string;
  /** Nobody can mint new supply. */
  mintAuthorityRevoked: boolean;
  /** Nobody can freeze holder accounts. */
  freezeAuthorityRevoked: boolean;
  decimals: number;
  supplyRaw: string;
}

interface ParsedMintAccount {
  value: {
    data: {
      parsed: {
        type: string;
        info: {
          decimals: number;
          freezeAuthority: string | null;
          mintAuthority: string | null;
          supply: string;
        };
      };
    };
  } | null;
}

export async function getMintAuthorities(mint: string): Promise<MintAuthorities> {
  const res = await rpc<ParsedMintAccount>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);

  const parsed = res.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint") {
    throw new Error(`[solana] ${mint} is not a parsable SPL mint account`);
  }

  return {
    mint,
    mintAuthorityRevoked: parsed.info.mintAuthority === null,
    freezeAuthorityRevoked: parsed.info.freezeAuthority === null,
    decimals: parsed.info.decimals,
    supplyRaw: parsed.info.supply,
  };
}

/* ------------------------------------------------------------------ */
/* Holder concentration                                                */
/* ------------------------------------------------------------------ */

export interface HolderConcentration {
  mint: string;
  /** Share of circulating supply held by the largest 10 accounts, as a percentage. */
  top10Pct: number;
  top1Pct: number;
  accountsSampled: number;
}

interface TokenAccountBalance {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
}

/**
 * Top-10 holder concentration.
 *
 * Caveat worth knowing before trusting the number: `getTokenLargestAccounts` returns
 * raw SPL token accounts, so a pool vault, a CEX omnibus wallet or a locked-vesting
 * contract each count as one "holder". A high reading is therefore evidence to
 * investigate, not proof of a rug.
 *
 * Requires an RPC provider that serves this method — the public mainnet-beta node
 * rejects it with HTTP 429.
 */
export async function getHolderConcentration(mint: string): Promise<HolderConcentration> {
  const [largest, supply] = await Promise.all([
    rpc<{ value: TokenAccountBalance[] }>("getTokenLargestAccounts", [mint]),
    rpc<{ value: { amount: string; decimals: number } }>("getTokenSupply", [mint]),
  ]);

  const totalSupply = Number(supply.value.amount);
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) {
    throw new Error(`[solana] ${mint} reported a non-positive supply`);
  }

  const amounts = largest.value
    .map((a) => Number(a.amount))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a);

  const top10 = amounts.slice(0, 10).reduce((sum, n) => sum + n, 0);

  return {
    mint,
    top10Pct: (top10 / totalSupply) * 100,
    top1Pct: ((amounts[0] ?? 0) / totalSupply) * 100,
    accountsSampled: amounts.length,
  };
}

/* ------------------------------------------------------------------ */
/* Combined token safety screen                                        */
/* ------------------------------------------------------------------ */

export type SafetyVerdict = "PASS" | "FAIL" | "UNKNOWN";

export interface TokenSafetyReport {
  mint: string;
  verdict: SafetyVerdict;
  /** Human-readable reasons the token failed, or why the check could not run. */
  reasons: string[];
  top10Pct: number | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  checkedAt: string;
}

/**
 * Runs the anti-rug checks for one mint.
 *
 * Returns UNKNOWN (never PASS) when a check could not be executed. Deciding what
 * UNKNOWN means is the caller's job — see ANTIRUG_ON_ERROR. Silently treating an
 * unavailable check as a pass would turn this filter into false confidence.
 */
export async function screenTokenSafety(mint: string): Promise<TokenSafetyReport> {
  const report: TokenSafetyReport = {
    mint,
    verdict: "PASS",
    reasons: [],
    top10Pct: null,
    mintAuthorityRevoked: null,
    freezeAuthorityRevoked: null,
    checkedAt: new Date().toISOString(),
  };

  const [authorities, concentration] = await Promise.allSettled([
    getMintAuthorities(mint),
    getHolderConcentration(mint),
  ]);

  let unknown = false;

  if (authorities.status === "fulfilled") {
    report.mintAuthorityRevoked = authorities.value.mintAuthorityRevoked;
    report.freezeAuthorityRevoked = authorities.value.freezeAuthorityRevoked;

    if (env.ANTIRUG_REQUIRE_MINT_REVOKED && !authorities.value.mintAuthorityRevoked) {
      report.reasons.push("mint authority is not revoked (supply can still be inflated)");
    }
    if (env.ANTIRUG_REQUIRE_FREEZE_REVOKED && !authorities.value.freezeAuthorityRevoked) {
      report.reasons.push("freeze authority is not revoked (holder accounts can be frozen)");
    }
  } else {
    unknown = true;
    report.reasons.push(`authority check unavailable: ${authorities.reason}`);
  }

  if (concentration.status === "fulfilled") {
    report.top10Pct = concentration.value.top10Pct;

    if (concentration.value.top10Pct >= env.ANTIRUG_MAX_TOP10_HOLDER_PCT) {
      report.reasons.push(
        `top 10 holders control ${concentration.value.top10Pct.toFixed(1)}% ` +
          `(limit ${env.ANTIRUG_MAX_TOP10_HOLDER_PCT}%)`,
      );
    }
  } else {
    unknown = true;
    report.reasons.push(`holder concentration unavailable: ${concentration.reason}`);
  }

  // A real breach outranks a missing check: a token that definitively failed one rule
  // is FAIL even if the other rule could not be evaluated.
  const hasRealBreach = report.reasons.some((r) => !r.includes("unavailable"));

  report.verdict = hasRealBreach ? "FAIL" : unknown ? "UNKNOWN" : "PASS";

  return report;
}

/* ------------------------------------------------------------------ */
/* Wallet balance                                                      */
/* ------------------------------------------------------------------ */

export interface WalletBalance {
  address: string;
  lamports: number;
  sol: number;
  readAt: string;
}

/**
 * Reads a wallet's SOL balance. PUBLIC address only — this never sees, needs or
 * derives the signing key.
 *
 * Throws rather than returning a fallback. Every caller is a safety gate, and a
 * balance that could not be read is not a balance of zero, nor of "enough": the
 * three-state rule this codebase applies to authority flags and gas estimates applies
 * here too. `runLivePreflight` turns the throw into a refusal to start.
 */
export async function getWalletBalanceSol(address: string): Promise<WalletBalance> {
  const result = await rpc<{ value: number } | number>("getBalance", [address]);

  // Every mainstream provider returns the RpcResponse envelope { context, value }.
  // A bare number is tolerated so an unusual provider degrades to working, not to
  // NaN — which would silently read as "balance unknown" downstream.
  const lamports = typeof result === "number" ? result : result?.value;

  if (typeof lamports !== "number" || !Number.isFinite(lamports) || lamports < 0) {
    throw new Error(`[solana] getBalance returned no usable value for ${address}`);
  }

  return {
    address,
    lamports,
    sol: lamports / LAMPORTS_PER_SOL,
    readAt: new Date().toISOString(),
  };
}
