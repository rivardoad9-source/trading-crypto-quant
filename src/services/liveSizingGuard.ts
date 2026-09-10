import { liveMicroCapital, type LiveMicroCapitalConfig } from "../config/liveConfig.js";

/**
 * Does the engine actually HAVE the capital it is sizing against?
 *
 * WHY THIS EXISTS. On 11 Sep 2026 `LIVE_CAPITAL_SOL` was pinned at 3.05 while the
 * wallet held 2.880994 SOL. The pin had been correct when it was set — the wallet was
 * 2.944854 then — and the margin was consumed by the ordinary cost of trading. Nothing
 * in the engine ever compared the two. `openLivePosition` sized a deposit against the
 * assumed 3.05, the balancing swap sent 0.9 SOL and CONFIRMED, and the DLMM deposit leg
 * then died on `TransferChecked -> insufficient funds` (SPL `0x1`). Three times in
 * thirty minutes: **-0.0639 SOL, zero positions opened.**
 *
 * The engine already read the on-chain balance. `runLivePreflight` prints
 * `wallet ...: 2.880994 SOL (floor 0.2 SOL) — OK` on every boot, and `measureWalletBalance`
 * serves it to the dashboard. The reading was simply never used as an INPUT to
 * anything. That is the whole defect, and this module is the whole fix: one comparison,
 * made before money moves.
 *
 * THE COMPARISON. `deployable = LIVE_CAPITAL_SOL - LIVE_MIN_RESERVE_SOL` must be at
 * most the real balance. Deployable rather than capital, because the reserve is money
 * the engine promises never to deploy, and demanding the wallet also cover an
 * untouchable buffer would refuse a wallet that can fund every position it will ever
 * open. That the reserve itself is present is a separate question, asked separately by
 * `LIVE_MIN_WALLET_SOL` in `livePreflight.ts`.
 *
 * EXACT EQUALITY PASSES. At `deployable === balance` every lamport the engine may
 * deploy is provably in the wallet, which is the condition being tested; refusing there
 * would make the guard stricter than its own statement and would refuse a wallet that
 * is exactly, correctly funded. It is also the boundary the operator's own runbook
 * uses. The direction is stated here rather than left to a reader of `<=`, and
 * `liveSizingGuard.test.ts` pins it.
 *
 * FAILS CLOSED ON UNKNOWN. A balance that could not be read is treated as a balance
 * that is too low, exactly as `runLivePreflight` and `screenTokenSafety` do, and
 * deliberately unlike `assessPoolCooldown`. "The RPC timed out" is not evidence of
 * solvency, and the thing being protected here is capital, not returns.
 *
 * INERT IN PAPER MODE. `enabled` comes from the live micro-capital profile; with it
 * off the verdict is `inert` and nothing consults the chain. A dry run's cycle is
 * byte-identical, the same discipline `defaultBacktestConfig()` and the execution
 * breaker follow.
 */

export type SizingGuardStatus =
  /** The live profile is off. Nothing was checked and nothing is refused. */
  | "inert"
  /** Deployable capital is covered by the wallet. */
  | "ok"
  /** The engine is sizing against SOL the wallet does not hold. */
  | "over-capital"
  /** The balance could not be read. Treated as a refusal. */
  | "balance-unknown";

export interface SizingGuardVerdict {
  /** Whether a fund-moving live entry may proceed. */
  ok: boolean;
  status: SizingGuardStatus;
  /** `LIVE_CAPITAL_SOL - LIVE_MIN_RESERVE_SOL`, the figure sizing runs off. */
  assumedDeployableSol: number;
  /** `LIVE_CAPITAL_SOL`, quoted so an operator can see which knob to move. */
  assumedCapitalSol: number;
  reserveSol: number;
  /** The chain's answer, or null when it could not be read. NEVER 0 as a stand-in. */
  actualBalanceSol: number | null;
  /**
   * How much of the assumed deployable capital the wallet cannot cover, in SOL.
   *
   * Positive only when `status` is `over-capital`. Null when there is nothing to
   * subtract from — an unmeasured shortfall is not a zero one, the same rule
   * `driftPctOfModel` and `est_gas_cost_usd` follow.
   */
  shortfallSol: number | null;
  /** Operator-readable, already carrying every number above. Null when ok or inert. */
  reason: string | null;
}

export interface SizingGuardInput {
  /** The chain's balance in SOL, or null when the read failed. */
  balanceSol: number | null;
  /** Why it failed, when it did. Folded into `reason`. */
  balanceError?: string | null;
  config?: LiveMicroCapitalConfig;
}

/**
 * The whole rule, pure: no RPC, no clock, no database. Unit-testable offline, which is
 * the point — a guard that can only be exercised against mainnet is a guard nobody
 * exercises.
 */
export function assessLiveSizing(input: SizingGuardInput): SizingGuardVerdict {
  const config = input.config ?? liveMicroCapital;
  const base = {
    assumedDeployableSol: config.deployableSol,
    assumedCapitalSol: config.capitalSol,
    reserveSol: config.minReserveSol,
  };

  if (!config.enabled) {
    return {
      ...base,
      ok: true,
      status: "inert",
      actualBalanceSol: null,
      shortfallSol: null,
      reason: null,
    };
  }

  const balance = input.balanceSol;
  /*
   * A non-finite balance is an unread one, not a zero one. `Number.isFinite` rather
   * than a truthiness test, because 0 is a legitimate reading (a drained wallet) and
   * must reach the over-capital branch below with its real number, not be reported as
   * an RPC failure.
   */
  if (balance === null || !Number.isFinite(balance)) {
    return {
      ...base,
      ok: false,
      status: "balance-unknown",
      actualBalanceSol: null,
      shortfallSol: null,
      reason:
        `the on-chain balance of the live wallet could not be read` +
        (input.balanceError ? ` (${input.balanceError})` : ``) +
        `, so it cannot be confirmed that the ${config.deployableSol.toFixed(4)} SOL ` +
        `this engine sizes against exists. An unverified wallet is treated as an ` +
        `empty one — the same rule the startup gas reserve follows.`,
    };
  }

  if (config.deployableSol <= balance) {
    return {
      ...base,
      ok: true,
      status: "ok",
      actualBalanceSol: balance,
      shortfallSol: null,
      reason: null,
    };
  }

  const shortfall = config.deployableSol - balance;
  return {
    ...base,
    ok: false,
    status: "over-capital",
    actualBalanceSol: balance,
    shortfallSol: shortfall,
    reason:
      `LIVE_CAPITAL_SOL=${config.capitalSol} minus the ` +
      `${config.minReserveSol} SOL reserve assumes ${config.deployableSol.toFixed(6)} SOL ` +
      `is deployable, but the wallet holds ${balance.toFixed(6)} SOL — short by ` +
      `${shortfall.toFixed(6)} SOL. Sizing a deposit against SOL that is not there is ` +
      `what confirmed a balancing swap and then failed the deposit leg three times on ` +
      `11 Sep 2026, for -0.0639 SOL and no position. Lower LIVE_CAPITAL_SOL to at most ` +
      `${(balance + config.minReserveSol).toFixed(4)}, or top the wallet up.`,
  };
}

/** One line for the boot log and the operator alert. Always states which way it went. */
export function describeLiveSizing(verdict: SizingGuardVerdict): string {
  switch (verdict.status) {
    case "inert":
      return "[sizing] live micro-capital profile is off — capital vs wallet NOT checked";
    case "ok":
      return (
        `[sizing] deployable ${verdict.assumedDeployableSol.toFixed(4)} SOL ` +
        `(capital ${verdict.assumedCapitalSol} - reserve ${verdict.reserveSol}) vs wallet ` +
        `${(verdict.actualBalanceSol ?? 0).toFixed(6)} SOL — OK, margin ` +
        `${((verdict.actualBalanceSol ?? 0) - verdict.assumedDeployableSol).toFixed(6)} SOL`
      );
    case "over-capital":
      return `[sizing] REFUSING LIVE ENTRIES: ${verdict.reason}`;
    case "balance-unknown":
      return `[sizing] REFUSING LIVE ENTRIES: ${verdict.reason}`;
  }
}
