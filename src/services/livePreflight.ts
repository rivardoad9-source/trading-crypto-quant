import { env } from "../config/env.js";
import {
  describeLiveEnvelope,
  hasLiveSigningKey,
  liveMicroCapital,
  type LiveMicroCapitalConfig,
} from "../config/liveConfig.js";
import { getWalletBalanceSol, type WalletBalance } from "./solana.js";
import { sendMessage } from "./telegram.js";
import {
  describePinSuggestion,
  describeStartingBalance,
  seedStartingBalanceFromWallet,
} from "../config/startingBalance.js";

/**
 * Startup gate for the live micro-capital profile.
 *
 * The engine must not start with a wallet that cannot fund its own exits. A DLMM
 * position is opened and closed by two separate transactions; a wallet that can afford
 * the first but not the second turns the fast monitor's stop-loss into a suggestion,
 * because there is no gas left to act on it. Refusing to start is the only outcome
 * that leaves the operator's capital where they can still reach it.
 *
 * The whole module is inert unless `LIVE_MICRO_CAPITAL=true`. With the flag off,
 * `runLivePreflight` returns `{ status: "skipped" }` without touching the network,
 * so the paper engine's boot is unchanged.
 */

/** The alert code the operator's Telegram runbook keys on. Do not reword it. */
export const INSUFFICIENT_GAS_RESERVE = "INSUFFICIENT_GAS_RESERVE" as const;

export class InsufficientGasReserveError extends Error {
  readonly code = INSUFFICIENT_GAS_RESERVE;
  /** null when the balance could not be read at all. */
  readonly balanceSol: number | null;
  readonly requiredSol: number;

  constructor(message: string, balanceSol: number | null, requiredSol: number) {
    super(message);
    this.name = "InsufficientGasReserveError";
    this.balanceSol = balanceSol;
    this.requiredSol = requiredSol;
  }
}

export type PreflightStatus = "skipped" | "ok";

export interface PreflightResult {
  status: PreflightStatus;
  /** Present only when a balance was actually read. */
  balance?: WalletBalance;
  /** Lines describing the armed envelope, already logged. */
  envelope: string[];
}

export interface PreflightDeps {
  config?: LiveMicroCapitalConfig;
  /**
   * Closed trades already in the database. The baseline is seeded from the wallet only
   * on a genuinely clean slate — rebasing under existing trades would re-scale every
   * percentage already reported against the old number.
   */
  existingTrades?: number;
  /**
   * Realised PnL already booked by those trades.
   *
   * Only used to derive the baseline the operator would have to pin BY HAND once the
   * seed has refused. It is not an input to any gate: a wallet that passes the reserve
   * floor passes it regardless of what the book says.
   */
  realisedPnlUsd?: number;
  /** Injected for tests; defaults to the real RPC read. */
  readBalance?: (address: string) => Promise<WalletBalance>;
  /** Injected for tests; defaults to the real Telegram dispatch. */
  alert?: (text: string) => Promise<unknown>;
  /** SOL/USD, used only to render the envelope summary. */
  solPriceUsd?: number | null;
  log?: (line: string) => void;
}

/**
 * Fires the operator alert. Never throws: a Telegram outage must not mask the
 * underlying refusal, which the caller is about to surface anyway.
 */
async function raiseAlert(
  alert: (text: string) => Promise<unknown>,
  detail: string,
): Promise<void> {
  try {
    await alert(`🚨 ${INSUFFICIENT_GAS_RESERVE}\n\n${detail}\n\nEngine start REFUSED.`);
  } catch (err) {
    console.error(`[preflight] alert dispatch failed: ${(err as Error).message}`);
  }
}

/**
 * Runs the live-capital startup checks.
 *
 * Resolves when the engine may start. Throws `InsufficientGasReserveError` — after
 * sending the Telegram alert — when it may not.
 *
 * A balance that could not be READ is treated exactly like a balance that is too low.
 * Starting on an unverified wallet is the failure this gate exists to prevent, and
 * "the RPC was down" is not evidence of solvency. Same fail-closed rule as
 * `screenTokenSafety`, and the opposite of the anti-churn gates, which fail open
 * because they only protect returns.
 */
export async function runLivePreflight(deps: PreflightDeps = {}): Promise<PreflightResult> {
  const config = deps.config ?? liveMicroCapital;
  const log = deps.log ?? ((line: string) => console.log(line));

  if (!config.enabled) {
    return { status: "skipped", envelope: [] };
  }

  const readBalance = deps.readBalance ?? getWalletBalanceSol;
  const alert = deps.alert ?? ((text: string) => sendMessage(text, false));

  const envelope =
    deps.solPriceUsd && deps.solPriceUsd > 0 ? describeLiveEnvelope(deps.solPriceUsd, config) : [];

  log("[preflight] LIVE micro-capital profile ARMED");
  for (const line of envelope) log(`[preflight]   ${line}`);

  /*
   * Stated, not enforced. The GUARDLOCK in env.ts already pairs DRY_RUN=false with
   * ONCHAIN_EXECUTION_ARMED=true before boot, so this line only records whether the
   * signing key is present in the environment.
   */
  log(`[preflight]   signing key: ${hasLiveSigningKey() ? "present in env" : "not configured"}`);
  if (!env.DRY_RUN && !hasLiveSigningKey()) {
    log("[preflight]   WARNING: DRY_RUN=false but no signing key — first execution will fail to arm");
  }

  if (!config.walletAddress) {
    const detail =
      `SOLANA_WALLET_ADDRESS is not set, so the ${config.minWalletSol} SOL startup floor ` +
      `cannot be verified. Set the wallet's PUBLIC address in .env.`;
    await raiseAlert(alert, detail);
    throw new InsufficientGasReserveError(
      `[preflight] ${INSUFFICIENT_GAS_RESERVE}: ${detail}`,
      null,
      config.minWalletSol,
    );
  }

  let balance: WalletBalance;
  try {
    balance = await readBalance(config.walletAddress);
  } catch (err) {
    const detail =
      `Could not read the balance of ${config.walletAddress}: ${(err as Error).message}. ` +
      `An unverified wallet is treated as an empty one.`;
    await raiseAlert(alert, detail);
    throw new InsufficientGasReserveError(
      `[preflight] ${INSUFFICIENT_GAS_RESERVE}: ${detail}`,
      null,
      config.minWalletSol,
    );
  }

  if (balance.sol < config.minWalletSol) {
    const detail =
      `Wallet ${balance.address} holds ${balance.sol.toFixed(6)} SOL, below the ` +
      `${config.minWalletSol} SOL startup floor. The engine will not open a position it ` +
      `cannot afford to close.`;
    await raiseAlert(alert, detail);
    throw new InsufficientGasReserveError(
      `[preflight] ${INSUFFICIENT_GAS_RESERVE}: ${detail}`,
      balance.sol,
      config.minWalletSol,
    );
  }

  log(
    `[preflight]   wallet ${balance.address}: ${balance.sol.toFixed(6)} SOL ` +
      `(floor ${config.minWalletSol} SOL) — OK`,
  );

  /*
   * Seed the paper baseline from the real wallet, so the dashboard's percentages are
   * measured against what the operator actually funded rather than a $1,000 figure
   * nothing backs. Seeded HERE and nowhere else: this runs once per process, before any
   * request can read the value, which is what keeps the baseline stable for the run.
   *
   * Refuses on an explicit STARTING_BALANCE_USD, on an unreadable price, and on a
   * database that already holds trades. Its own log line says which.
   */
  if (deps.solPriceUsd && deps.solPriceUsd > 0) {
    const seed = seedStartingBalanceFromWallet({
      walletUsd: balance.sol * deps.solPriceUsd,
      walletSol: balance.sol,
      existingTrades: deps.existingTrades ?? 0,
    });
    if (!seed.applied) {
      log(`[preflight]   baseline not seeded: ${seed.reason}`);
      /*
       * A refusal used to end here, which left the operator holding a $1,000 baseline
       * under a real wallet and no number to replace it with. The obvious replacement —
       * the wallet's own balance — double-counts every trade already booked, so the
       * preflight states the one that does not. Suggested, never applied: rebasing under
       * existing trades re-scales every percentage already reported, which is a decision
       * to record in `.env`, not something a boot does quietly.
       */
      if ((deps.existingTrades ?? 0) > 0) {
        for (const line of describePinSuggestion({
          walletUsd: balance.sol * deps.solPriceUsd,
          realisedPnlUsd: deps.realisedPnlUsd ?? 0,
          closedTrades: deps.existingTrades ?? 0,
        })) {
          log(`[preflight] ${line}`);
        }
      }
    }
  } else {
    log("[preflight]   baseline not seeded: no SOL/USD price available");
  }
  for (const line of describeStartingBalance()) log(`[preflight]   ${line}`);

  return { status: "ok", balance, envelope };
}
