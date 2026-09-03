import { DEFAULT_STARTING_BALANCE_USD } from "./constants.js";

/**
 * The paper account's starting balance — the baseline every reported percentage is
 * measured against.
 *
 * Resolved once at boot rather than being a constant, so a fresh run can be based on
 * the operator's real funding instead of a $1,000 figure nothing backs. Precedence:
 *
 *   1. `STARTING_BALANCE_USD` env — explicit, and the ONLY reproducible option.
 *   2. The live wallet at preflight, when `STARTING_BALANCE_FROM_WALLET=true`.
 *   3. `DEFAULT_STARTING_BALANCE_USD` ($1,000), unchanged.
 *
 * ## Why this is pinned at boot and not read per request
 *
 * A "starting balance" re-derived from the live wallet on every read is not a starting
 * balance — it is the CURRENT balance, and `current + realisedPnL` then counts the same
 * profit twice. The same mistake in slower motion: re-deriving it on every restart makes
 * drawdown and every percentage non-reproducible, because the identical trade history
 * reports different numbers after each boot. So the wallet is read at most once, at
 * preflight, and the value is frozen for the process.
 *
 * Once the operator knows the number, `STARTING_BALANCE_USD` in `.env` is the right
 * home for it: an explicit baseline is auditable and survives a restart, and
 * `describeStartingBalance()` prints exactly what to paste.
 *
 * ## Changing this rewrites history
 *
 * `netPnlPct`, drawdown and `currentBalanceUSD` are all quoted against this number, so
 * moving it re-scales every past figure. Doing it against an EMPTY database costs
 * nothing, which is why a clean slate is the moment to set it. Restoring an old backup
 * afterwards would re-scale those trades — the balance and the history have to be
 * changed together or not at all.
 */

export type StartingBalanceSource = "env" | "wallet" | "default";

interface Resolved {
  usd: number;
  source: StartingBalanceSource;
  /** Present only for the wallet source: what the wallet held when it was captured. */
  walletSol: number | null;
  resolvedAt: string;
}

function parseEnvValue(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  // A zero or negative baseline makes every percentage Infinity or sign-flipped, and
  // NaN would propagate silently through drawdown into the dashboard.
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[balance] STARTING_BALANCE_USD="${raw}" is not a positive number; ignoring it`,
    );
    return null;
  }
  return value;
}

function initial(): Resolved {
  const fromEnv = parseEnvValue(process.env.STARTING_BALANCE_USD);
  return fromEnv === null
    ? {
        usd: DEFAULT_STARTING_BALANCE_USD,
        source: "default",
        walletSol: null,
        resolvedAt: new Date().toISOString(),
      }
    : { usd: fromEnv, source: "env", walletSol: null, resolvedAt: new Date().toISOString() };
}

let resolved: Resolved = initial();

/** The baseline. Callers read this per use rather than importing a constant. */
export function getStartingBalanceUsd(): number {
  return resolved.usd;
}

export function getStartingBalanceInfo(): Readonly<Resolved> {
  return resolved;
}

/** True when the operator pinned the value explicitly. Seeding must not override it. */
export function isStartingBalancePinned(): boolean {
  return resolved.source === "env";
}

/**
 * Seeds the baseline from the live wallet. Called once, from the preflight.
 *
 * Refuses in three cases, and each refusal is the point rather than an edge case:
 * an explicit `STARTING_BALANCE_USD` always wins (a pinned baseline is a decision, not
 * a default to be improved on); an unreadable or zero wallet is not a baseline; and a
 * database that already holds trades must not be re-based underneath them, because the
 * percentages already quoted against the old number would silently change meaning.
 *
 * @param existingTrades how many closed trades the database holds.
 * @returns whether the seed was applied.
 */
export function seedStartingBalanceFromWallet(params: {
  walletUsd: number | null;
  walletSol: number | null;
  existingTrades: number;
}): { applied: boolean; reason?: string } {
  if (isStartingBalancePinned()) {
    return { applied: false, reason: "STARTING_BALANCE_USD is set explicitly" };
  }
  if (params.walletUsd === null || !Number.isFinite(params.walletUsd) || params.walletUsd <= 0) {
    return { applied: false, reason: "wallet balance unavailable or zero" };
  }
  if (params.existingTrades > 0) {
    return {
      applied: false,
      reason:
        `database already holds ${params.existingTrades} closed trade(s); rebasing now ` +
        `would re-scale every percentage already reported against the old baseline`,
    };
  }

  resolved = {
    usd: params.walletUsd,
    source: "wallet",
    walletSol: params.walletSol,
    resolvedAt: new Date().toISOString(),
  };
  return { applied: true };
}

/** Test seam. Restores the env/default resolution. */
export function resetStartingBalance(): void {
  resolved = initial();
}

/** One line for the boot banner, plus the `.env` line to make a wallet seed permanent. */
export function describeStartingBalance(): string[] {
  const info = resolved;
  const usd = `$${info.usd.toFixed(2)}`;

  switch (info.source) {
    case "env":
      return [`starting balance: ${usd} (pinned via STARTING_BALANCE_USD)`];
    case "wallet":
      return [
        `starting balance: ${usd}` +
          (info.walletSol === null ? "" : ` (live wallet, ${info.walletSol.toFixed(4)} SOL)`),
        `  this is re-derived every boot and will drift with the wallet. To pin it:`,
        `  STARTING_BALANCE_USD=${info.usd.toFixed(2)}`,
      ];
    default:
      return [`starting balance: ${usd} (default — not backed by any wallet)`];
  }
}
