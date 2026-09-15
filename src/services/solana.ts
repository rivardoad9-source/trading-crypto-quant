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

/**
 * ONE request, no retry. Used directly only by the calls that must not be retried — see
 * `RPC_READ_RETRY_METHODS` for why each exclusion exists.
 */
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
/* Read retry (15 Sep 2026)                                            */
/* ------------------------------------------------------------------ */

/**
 * Why this exists: on 15 Sep 2026 the engine logged
 * `[antirug] rejected LEVERCAT-SOL (UNKNOWN): authority check unavailable: AxiosError … 429`.
 * One candidate lost to a rate limit — the Helius key was shared with a backtest ingest —
 * not to anything about the token. `rpc()` was a single POST, so one 429 was a verdict.
 *
 * The fail-closed rule is untouched: a read that is still failing after its retries throws,
 * and `screenTokenSafety` still turns that into UNKNOWN, never PASS. Retry only changes
 * how much evidence "could not run" needs before it is believed.
 *
 * ALLOWLIST, not a denylist: a method nobody reviewed gets one attempt. Retried:
 * idempotent reads whose failure costs a candidate or a gate reading. Deliberately NOT:
 *  - `sendTransaction` / `sendRawTransaction` / `simulateTransaction` and anything that
 *    signs: not issued from this module at all (the executor sends through web3.js
 *    `Connection` under `sendAndConfirm`'s rebroadcast rule), and a retry here would be a
 *    second, unreviewed resend path. Listed so `readRpc` refuses to retry them by name.
 *  - `getSlot`: the health probe. Retrying would hide the 429 the widget exists to report,
 *    and its 2.5 s budget is part of `/api/health` not hanging.
 *  - `getRecentPrioritizationFees`: called by the executor INSIDE the send/rebuild loop,
 *    where seconds of backoff are spent from a blockhash lifetime, and whose `Safe` wrapper
 *    already prices a failure at the configured floor.
 */
export const RPC_READ_RETRY_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getBalance",
  "getTransaction",
]);

export const RPC_NEVER_RETRY_METHODS: ReadonlySet<string> = new Set([
  "sendTransaction",
  "sendRawTransaction",
  "simulateTransaction",
  "requestAirdrop",
  "getSlot",
  "getRecentPrioritizationFees",
]);

export const RPC_READ_RETRY_POLICY = {
  maxAttempts: 3,
  /** Wait before attempt 2, 3, … (only the first two are reachable at 3 attempts). */
  backoffMs: [500, 1500, 4000] as const,
  /** ± fraction applied to each wait, so concurrent callers do not retry in lockstep. */
  jitter: 0.2,
  /**
   * Wall-clock budget for the RETRIES of one call, measured from its first attempt: no retry
   * starts past it, and a retry's own timeout is clamped to what is left. The FIRST attempt
   * keeps the caller's timeout unchanged, so a call that succeeds today behaves identically.
   */
  budgetMs: 6_000,
  /** A retry with less than this left is not worth starting. */
  minAttemptMs: 250,
  /** Consecutive calls of one method exhausting on 429 before retries pause for it. */
  persistentAfter: 3,
  /** How long a paused method stays on single attempts before retries are tried again. */
  pauseMs: 10 * 60_000,
};

/** Test seam: the clock, the sleep and the jitter source. Production never reassigns it. */
export const rpcRetryClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  random: (): number => Math.random(),
};

export type RpcFailureKind = "rate_limited" | "server" | "timeout" | "network" | "rpc_error" | "http" | "other";

const TRANSIENT_KINDS: ReadonlySet<RpcFailureKind> = new Set(["rate_limited", "server", "timeout", "network"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ERR_NETWORK"]);

/** What went wrong, in a form a log line and a funnel bucket can both use. Same split as `http.ts`. */
export function classifyRpcFailure(err: unknown): { kind: RpcFailureKind; transient: boolean; label: string } {
  const out = (kind: RpcFailureKind, label: string) => ({ kind, transient: TRANSIENT_KINDS.has(kind), label });
  if (err instanceof RpcReadError) return out(err.kind, err.lastLabel);
  if (err instanceof SolanaRpcError) {
    // Some providers answer HTTP 200 with a JSON-RPC rate-limit code instead of a 429.
    return err.code === -32429 ? out("rate_limited", `RPC error ${err.code}`) : out("rpc_error", `RPC error ${err.code}`);
  }
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 429) return out("rate_limited", "HTTP 429");
    if (status !== undefined && status >= 500) return out("server", `HTTP ${status}`);
    if (status !== undefined) return out("http", `HTTP ${status}`);
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || /timeout/i.test(err.message)) return out("timeout", "timeout");
    return out("network", err.code ?? "network error");
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code && NETWORK_CODES.has(code)) return out("network", code);
  if (code === "ETIMEDOUT") return out("timeout", "timeout");
  return out("other", err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80));
}

/** A read that was still failing TRANSIENTLY after its retries. Carries the evidence. */
export class RpcReadError extends Error {
  constructor(
    readonly method: string,
    readonly attempts: number,
    readonly kind: RpcFailureKind,
    readonly lastLabel: string,
    readonly paused: boolean,
  ) {
    super(
      `${attempts} ${attempts === 1 ? "attempt" : "attempts"}` +
        (paused ? ` (retries paused: ${lastLabel} persisted across calls)` : "") +
        `, last ${lastLabel} (${method})`,
    );
    this.name = "RpcReadError";
  }
}

interface MethodLimitState {
  exhausted429: number;
  pausedUntil: number | null;
}
const methodLimits = new Map<string, MethodLimitState>();

/** Test seam, and a way to drop limit state that no longer describes this endpoint. */
export function resetRpcReadState(): void {
  methodLimits.clear();
}

/** Methods currently on single attempts because 429 persisted. Diagnostic only. */
export function pausedRpcMethods(): string[] {
  const now = rpcRetryClock.now();
  return [...methodLimits.entries()].filter(([, s]) => s.pausedUntil !== null && s.pausedUntil > now).map(([m]) => m);
}

function limitState(method: string): MethodLimitState {
  let s = methodLimits.get(method);
  if (!s) methodLimits.set(method, (s = { exhausted429: 0, pausedUntil: null }));
  return s;
}

/**
 * `rpc()` with bounded retry for TRANSIENT failures (429, 5xx, timeout, network) on the
 * allowlisted read methods. Anything else — a non-transient error, a method off the list,
 * a method in `RPC_NEVER_RETRY_METHODS` — gets exactly one attempt and its original error.
 *
 * Persistent rejection is told apart from a passing burst: when one method's calls keep
 * exhausting on 429 (the public node refuses `getTokenLargestAccounts` permanently), that
 * method drops to single attempts for `pauseMs` and it is logged ONCE, instead of every
 * candidate paying the full backoff for a refusal that will not change.
 */
export async function readRpc<T>(method: string, params: unknown[], timeoutMs: number = HTTP_TIMEOUT_MS): Promise<T> {
  const policy = RPC_READ_RETRY_POLICY;
  const retryable = RPC_READ_RETRY_METHODS.has(method) && !RPC_NEVER_RETRY_METHODS.has(method);
  if (!retryable) return rpc<T>(method, params, timeoutMs);

  const state = limitState(method);
  const startedAt = rpcRetryClock.now();
  const paused = state.pausedUntil !== null && state.pausedUntil > startedAt;
  if (state.pausedUntil !== null && !paused) {
    state.pausedUntil = null;
    state.exhausted429 = 0;
  }
  const maxAttempts = paused ? 1 : policy.maxAttempts;

  let attempts = 0;
  let last: ReturnType<typeof classifyRpcFailure> | null = null;
  for (;;) {
    const elapsed = rpcRetryClock.now() - startedAt;
    const attemptTimeout = attempts === 0 ? timeoutMs : Math.max(1, Math.min(timeoutMs, policy.budgetMs - elapsed));
    attempts++;
    try {
      const result = await rpc<T>(method, params, attemptTimeout);
      if (state.exhausted429 > 0 || state.pausedUntil !== null) {
        if (state.pausedUntil !== null) console.warn(`[solana] ${method}: answered again — retries resumed`);
        state.exhausted429 = 0;
        state.pausedUntil = null;
      }
      return result;
    } catch (err) {
      last = classifyRpcFailure(err);
      if (!last.transient) {
        if (attempts === 1) throw err; // non-transient: one attempt, original error, as before
        throw new RpcReadError(method, attempts, last.kind, last.label, paused);
      }
      const base = policy.backoffMs[Math.min(attempts - 1, policy.backoffMs.length - 1)]!;
      const wait = Math.max(0, Math.round(base * (1 + policy.jitter * (2 * rpcRetryClock.random() - 1))));
      const remaining = policy.budgetMs - (rpcRetryClock.now() - startedAt);
      if (attempts >= maxAttempts || remaining - wait < policy.minAttemptMs) break;
      await rpcRetryClock.sleep(wait);
    }
  }

  const final = last!;
  if (final.kind === "rate_limited" && !paused) {
    state.exhausted429++;
    if (state.exhausted429 >= policy.persistentAfter) {
      state.pausedUntil = rpcRetryClock.now() + policy.pauseMs;
      console.warn(
        `[solana] ${method}: ${final.label} on ${state.exhausted429} consecutive calls after ${attempts} attempts each — ` +
          `treating it as a persistent endpoint limit, single attempts for ${Math.round(policy.pauseMs / 60_000)} min (logged once)`,
      );
    }
  } else if (final.kind !== "rate_limited") {
    state.exhausted429 = 0;
  }
  throw new RpcReadError(method, attempts, final.kind, final.label, paused);
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
  const res = await readRpc<ParsedMintAccount>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);

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
/* Raw account bytes                                                   */
/* ------------------------------------------------------------------ */

export interface RawAccount {
  /** The program that owns the account — for a mint, its token program. */
  owner: string;
  data: Uint8Array;
  lamports: number;
}

/**
 * An account's raw bytes and owning program, or null when it does not exist.
 *
 * The RAW view, not `jsonParsed`, is what the Token-2022 extension screen reads: the
 * mint's extension layout is fixed by the token program rather than by the provider's
 * parser, so decoding it here keeps the answer ours. See `services/tokenExtensions.ts`
 * for why the entry path needs it at all (13 Sep 2026, a 3% transfer-fee mint elected
 * and the round trip costing 8.77%).
 *
 * Null means "no such account", which is a different fact from a thrown error: a mint
 * that does not exist and a node that did not answer must not read the same.
 */
export async function getRawAccount(address: string): Promise<RawAccount | null> {
  const res = await readRpc<{
    value: { owner: string; lamports: number; data: [string, string] } | null;
  }>("getAccountInfo", [address, { encoding: "base64" }]);

  const value = res.value;
  if (!value) return null;

  return {
    owner: value.owner,
    lamports: value.lamports,
    data: Buffer.from(value.data[0], "base64"),
  };
}

/** The parts of a confirmed transaction's meta the exit-economics ledger reads. */
export interface TransactionMetaReading {
  /** Account keys in message order, static keys first; index 0 is the fee payer. */
  accountKeys: string[];
  fee: number;
  err: unknown;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }>;
  postTokenBalances: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }>;
}

/**
 * Reads a transaction's meta, or null when the node has no record of the signature.
 * Throws on a transport or RPC error — "not found" and "could not ask" are different facts.
 * Read-only; signs nothing.
 */
export async function getTransactionMeta(signature: string): Promise<TransactionMetaReading | null> {
  const res = await readRpc<{
    transaction: { message: { accountKeys: Array<string | { pubkey: string }> } };
    meta: {
      fee: number;
      err: unknown;
      preBalances: number[];
      postBalances: number[];
      preTokenBalances?: TransactionMetaReading["preTokenBalances"];
      postTokenBalances?: TransactionMetaReading["postTokenBalances"];
      loadedAddresses?: { writable?: string[]; readonly?: string[] };
    } | null;
  } | null>("getTransaction", [
    signature,
    { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!res || !res.meta) return null;
  const staticKeys = res.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  return {
    accountKeys: [
      ...staticKeys,
      ...(res.meta.loadedAddresses?.writable ?? []),
      ...(res.meta.loadedAddresses?.readonly ?? []),
    ],
    fee: res.meta.fee,
    err: res.meta.err,
    preBalances: res.meta.preBalances,
    postBalances: res.meta.postBalances,
    preTokenBalances: res.meta.preTokenBalances ?? [],
    postTokenBalances: res.meta.postTokenBalances ?? [],
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
    readRpc<{ value: TokenAccountBalance[] }>("getTokenLargestAccounts", [mint]),
    readRpc<{ value: { amount: string; decimals: number } }>("getTokenSupply", [mint]),
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
  /**
   * Why an UNKNOWN is unknown (15 Sep 2026). Null/absent on PASS and FAIL.
   *  - "rpc_unavailable": the endpoint did not answer usefully after retries — 429, 5xx,
   *    timeout, network. A fact about the RPC, not the token; the funnel counts it apart.
   *  - "unreadable": the endpoint answered and the answer was unusable — not a parsable
   *    mint, a JSON-RPC error, a non-positive supply. A fact about the data.
   * When both checks failed for different causes, "rpc_unavailable" wins: the token may be
   * fine, and naming the data would send the operator after the wrong thing.
   */
  unknownCause?: SafetyUnknownCause | null;
}

export type SafetyUnknownCause = "rpc_unavailable" | "unreadable";

/** Maps a failed check's error to the funnel's two UNKNOWN buckets. */
export function safetyUnknownCause(err: unknown): SafetyUnknownCause {
  return classifyRpcFailure(err).transient ? "rpc_unavailable" : "unreadable";
}

/** An RpcReadError already reads "3 attempts, last HTTP 429 (method)"; anything else as before. */
function unavailableDetail(err: unknown): string {
  return err instanceof RpcReadError ? err.message : String(err);
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
  const causes: SafetyUnknownCause[] = [];

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
    causes.push(safetyUnknownCause(authorities.reason));
    report.reasons.push(`authority check unavailable: ${unavailableDetail(authorities.reason)}`);
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
    causes.push(safetyUnknownCause(concentration.reason));
    report.reasons.push(`holder concentration unavailable: ${unavailableDetail(concentration.reason)}`);
  }

  // A real breach outranks a missing check: a token that definitively failed one rule
  // is FAIL even if the other rule could not be evaluated.
  const hasRealBreach = report.reasons.some((r) => !r.includes("unavailable"));

  report.verdict = hasRealBreach ? "FAIL" : unknown ? "UNKNOWN" : "PASS";
  if (report.verdict === "UNKNOWN") {
    report.unknownCause = causes.includes("rpc_unavailable") ? "rpc_unavailable" : "unreadable";
  }

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
 *
 * `commitment` defaults to the PROVIDER's default, which on every mainstream RPC is
 * `finalized` — ~13 seconds behind a transaction the engine has just seen confirm. That
 * is harmless for the dashboard and the boot gate and wrong for a balance read taken
 * immediately after a confirmation: on 11 Sep 2026 the MANLET-SOL close recorded a
 * `wallet_lamports_after` of 1.700338862 SOL, which is exactly the balance BEFORE the
 * final close transaction (+0.415963 SOL) had finalized. Callers measuring the effect of
 * a transaction they just confirmed pass `"confirmed"`, the same level the executor
 * confirms at and `readTokenBalance` already reads at.
 */
export async function getWalletBalanceSol(
  address: string,
  options: { commitment?: "processed" | "confirmed" | "finalized" } = {},
): Promise<WalletBalance> {
  const result = await readRpc<{ value: number } | number>(
    "getBalance",
    options.commitment ? [address, { commitment: options.commitment }] : [address],
  );

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
