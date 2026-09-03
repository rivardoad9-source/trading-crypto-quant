import { env } from "../config/env.js";
import { liveMicroCapital } from "../config/liveConfig.js";
import { fetchSolPriceUsd } from "./marketData.js";
import { getWalletBalanceSol } from "./solana.js";

/**
 * The live on-chain wallet balance behind `GET /api/wallet`.
 *
 * This is the REAL account, read from the chain. It is deliberately a different number
 * from `/api/overview`'s `currentBalanceUSD`, which is `STARTING_BALANCE_USD` plus
 * realised paper PnL — a simulation baseline, not custody. Anything rendering both must
 * label which is which; presenting a paper equity figure as a wallet balance is the
 * fabricated-balance problem the cohort rules already warn about.
 *
 * Three things here are load-bearing, and all three mirror the RPC health probe for the
 * same reasons:
 *
 *  - The reading is CACHED and SINGLE-FLIGHTED. The dashboard polls once per interval
 *    per open tab; a chain read per request would rate-limit the endpoint the widget is
 *    reporting on.
 *  - An unavailable balance is `null`, never `0`. A wallet that could not be read is not
 *    an empty wallet, and "0.00 SOL" on a portfolio card is a lie with consequences.
 *  - Only the RPC endpoint's HOST is ever published. The configured URL carries the
 *    provider API key in its query string on Helius, and this payload is served to a
 *    browser.
 */

/** How long one reading may answer for. Longer than the RPC probe: a balance moves slowly. */
export const WALLET_BALANCE_TTL_MS = 30_000;

export type WalletStatus = "ok" | "unavailable" | "unconfigured";

export interface WalletSnapshot {
  status: WalletStatus;
  /**
   * Whether the live micro-capital profile is armed.
   *
   * Reported rather than used as a gate. An earlier version of this route 404'd when
   * unarmed, reasoning that inventing a wallet would be a fake figure — correct
   * instinct, wrong mechanism: the refusal to invent is already carried by `sol: null`,
   * and a 404 forces every typed client to treat "not armed yet" as a transport error.
   * Callers that care read this flag; callers that only want a number read the nulls.
   */
  armed: boolean;
  /** LIVE_MIN_WALLET_SOL — the startup floor, so a UI can show how close it is. */
  floorSol: number;
  /** The public address being watched, or null when none is configured. */
  address: string | null;
  /** Display name for the wallet. Never derived from the address. */
  label: string;
  /** Balance in SOL, or null when it could not be read. NEVER 0 as a stand-in. */
  sol: number | null;
  lamports: number | null;
  /** sol x solPriceUsd, or null when either half is missing. */
  usd: number | null;
  solPriceUsd: number | null;
  /** RPC host only — never the full URL, which can embed an API key. */
  endpoint: string;
  checkedAt: string;
  /** Why the reading failed, when it did. */
  detail: string | null;
}

function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable-url";
  }
}

/**
 * The wallet's display name.
 *
 * Configurable rather than derived: an address is not a name, and truncating one into
 * a label produces something the operator cannot recognise at a glance. Defaults to a
 * neutral string so an unconfigured deployment does not display someone's personal
 * handle it inferred from a machine account.
 */
export function walletLabel(): string {
  const raw = process.env.WALLET_LABEL?.trim();
  return raw && raw.length > 0 ? raw.slice(0, 32) : "Main Wallet";
}

export async function measureWalletBalance(): Promise<WalletSnapshot> {
  const base = {
    label: walletLabel(),
    endpoint: endpointHost(env.SOLANA_RPC_URL),
    checkedAt: new Date().toISOString(),
    armed: liveMicroCapital.enabled,
    floorSol: liveMicroCapital.minWalletSol,
  };

  const address = liveMicroCapital.walletAddress ?? null;
  if (!address) {
    return {
      ...base,
      status: "unconfigured",
      address: null,
      sol: null,
      lamports: null,
      usd: null,
      solPriceUsd: null,
      detail: "SOLANA_WALLET_ADDRESS is not set",
    };
  }

  /*
   * The price is fetched alongside, and its failure is NOT the balance's failure. A SOL
   * figure with no USD conversion is still a true, useful reading; suppressing it
   * because CoinGecko rate-limited would throw away the number that actually matters.
   */
  const [balance, price] = await Promise.allSettled([
    getWalletBalanceSol(address),
    fetchSolPriceUsd(),
  ]);

  const solPriceUsd =
    price.status === "fulfilled" && typeof price.value === "number" && price.value > 0
      ? price.value
      : null;

  if (balance.status === "rejected") {
    return {
      ...base,
      status: "unavailable",
      address,
      sol: null,
      lamports: null,
      usd: null,
      solPriceUsd,
      detail:
        balance.reason instanceof Error ? balance.reason.message : String(balance.reason),
    };
  }

  const sol = balance.value.sol;
  return {
    ...base,
    status: "ok",
    address,
    sol,
    lamports: balance.value.lamports,
    usd: solPriceUsd === null ? null : sol * solPriceUsd,
    solPriceUsd,
    detail: null,
  };
}

export type WalletProbe = () => Promise<WalletSnapshot>;

let cache: WalletSnapshot | null = null;
let inFlight: Promise<WalletSnapshot> | null = null;

function startProbe(probe: WalletProbe): Promise<WalletSnapshot> {
  inFlight ??= probe()
    .then((result) => {
      cache = result;
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Cached read. Only the first call after boot waits on the network; later reads serve a
 * stale snapshot immediately and refresh in the background, so a slow RPC cannot stall
 * a dashboard poll.
 *
 * Never throws. A portfolio card that 500s because a third party timed out is worse
 * than one showing a stale figure with its own timestamp — the caller can see how old
 * `checkedAt` is and decide for itself.
 */
export async function readWalletBalance(
  probe: WalletProbe = measureWalletBalance,
): Promise<WalletSnapshot> {
  const cached = cache;
  const fresh =
    cached !== null && Date.now() - Date.parse(cached.checkedAt) <= WALLET_BALANCE_TTL_MS;
  if (fresh) return cached;

  const running = startProbe(probe);
  if (cached !== null) {
    running.catch(() => undefined);
    return cached;
  }

  try {
    return await running;
  } catch (err) {
    return {
      status: "unavailable",
      armed: liveMicroCapital.enabled,
      floorSol: liveMicroCapital.minWalletSol,
      address: liveMicroCapital.walletAddress ?? null,
      label: walletLabel(),
      sol: null,
      lamports: null,
      usd: null,
      solPriceUsd: null,
      endpoint: endpointHost(env.SOLANA_RPC_URL),
      checkedAt: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Drops the cached reading. Used by the manual refresh button and by tests. */
export function resetWalletBalanceCache(): void {
  cache = null;
  inFlight = null;
}
