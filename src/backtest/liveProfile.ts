import { liveMicroCapital, type LiveMicroCapitalConfig } from "../config/liveConfig.js";

/**
 * The account a backtest simulates, derived from the LIVE profile unless a flag says otherwise.
 *
 * WHY. Every micro-capital runner defaulted to `--capital=100 --sizepct=27.5
 * --concurrent=MAX_CONCURRENT_POSITIONS(=3)`. Live runs LIVE_CAPITAL_SOL=2.85 (~$294),
 * LIVE_MAX_POSITION_SOL=1.8 — 63% of the account per position — and can fund ONE position,
 * not three. On 11 Sep 2026 the same data and the same gates produced PF 2.09 at one profile
 * and 3.22 at the other, maxDD 40.1% against 5.72%; the difference was entirely position size
 * and diversification, and nothing in the report said which account it described.
 * `liveV11Config` already reads every GATE from env so it "cannot silently drift from the
 * engine"; this makes the same true of the INPUTS.
 *
 *  - capitalUsd             = LIVE_CAPITAL_SOL x SOL/USD
 *  - positionSizePct        = LIVE_MAX_POSITION_SOL / LIVE_CAPITAL_SOL x 100
 *  - maxConcurrentPositions = the positions the capital can actually FUND:
 *                             min(LIVE_MAX_CONCURRENT_POSITIONS, floor(capital / position)).
 *                             `parseLiveConfig` already refuses a concurrency the deployable
 *                             capital cannot fund, so on a valid profile this is
 *                             LIVE_MAX_CONCURRENT_POSITIONS — and never the paper engine's
 *                             MAX_CONCURRENT_POSITIONS, which live never reaches.
 *
 * SOL/USD is the reference series' close at the START of the simulated window: the account's
 * dollar size when the window opens. Using today's price, or the window's median, would size
 * the account with a price the simulation had not reached yet.
 *
 * Flags still override each input; an overridden input is named in the header with a warning,
 * because a report describing another account is exactly what must not read like the live one.
 */

export interface BacktestAccountOptions {
  capitalUsd: number;
  /** Share of equity per position, as a percentage. */
  positionSizePct: number;
  maxConcurrentPositions: number;
  gasSolPerTransaction: number;
}

export interface ProfileOverrides {
  capitalUsd?: number;
  positionSizePct?: number;
  maxConcurrentPositions?: number;
  gasSolPerTransaction?: number;
  solUsd?: number;
}

export interface ResolvedBacktestProfile {
  options: BacktestAccountOptions;
  /** The SOL/USD the account was sized at, and where it came from. */
  solUsd: number;
  solUsdSource: "window-start" | "flag";
  /** What the live profile alone gives, for the comparison and the header. */
  live: { capitalSol: number; capitalUsd: number; positionSizePct: number; maxConcurrentPositions: number };
  /** Inputs a flag changed away from the live profile. Empty = the live profile. */
  overridden: Array<"capital" | "sizepct" | "concurrent">;
  matchesLive: boolean;
  notionalUsd: number;
  notionalSol: number;
}

export class BacktestProfileError extends Error {
  constructor(message: string) {
    super(`[backtest] ${message}`);
    this.name = "BacktestProfileError";
  }
}

/** Reads the four account flags (and `--solusd`) from a parsed flag map. Absent = not overridden. */
export function readProfileOverrides(flags: ReadonlyMap<string, string>): ProfileOverrides {
  const n = (key: string): number | undefined => {
    const raw = flags.get(key);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new BacktestProfileError(`--${key}=${raw} is not a number`);
    }
    return parsed;
  };
  const out: ProfileOverrides = {};
  const capital = n("capital");
  const sizepct = n("sizepct");
  const concurrent = n("concurrent");
  const gas = n("gas");
  const solusd = n("solusd");
  if (capital !== undefined) out.capitalUsd = capital;
  if (sizepct !== undefined) out.positionSizePct = sizepct;
  if (concurrent !== undefined) out.maxConcurrentPositions = concurrent;
  if (gas !== undefined) out.gasSolPerTransaction = gas;
  if (solusd !== undefined) out.solUsd = solusd;
  return out;
}

/**
 * Pure. Throws `BacktestProfileError` with the missing piece named — never falls back to a
 * demo account — when the profile cannot describe a fundable position or no SOL/USD exists.
 */
export function resolveBacktestProfile(input: {
  overrides: ProfileOverrides;
  /** The window-start SOL/USD close, or null when the reference series is empty. */
  windowStartSolUsd: number | null;
  /** The runner's own default gas assumption; gas is not part of the live envelope. */
  defaultGasSolPerTransaction: number;
  profile?: Pick<LiveMicroCapitalConfig, "capitalSol" | "maxPositionSol" | "maxConcurrentPositions">;
}): ResolvedBacktestProfile {
  const profile = input.profile ?? liveMicroCapital;
  const { overrides } = input;

  if (!(profile.capitalSol > 0) || !(profile.maxPositionSol > 0)) {
    throw new BacktestProfileError(
      `the live profile is incomplete (LIVE_CAPITAL_SOL=${profile.capitalSol}, ` +
        `LIVE_MAX_POSITION_SOL=${profile.maxPositionSol}); set both, or pass --capital and --sizepct`,
    );
  }
  const fundable = Math.min(
    profile.maxConcurrentPositions,
    Math.floor(profile.capitalSol / profile.maxPositionSol + 1e-9),
  );
  if (fundable < 1) {
    throw new BacktestProfileError(
      `LIVE_CAPITAL_SOL=${profile.capitalSol} cannot fund one LIVE_MAX_POSITION_SOL=` +
        `${profile.maxPositionSol} position, so there is no live account to simulate`,
    );
  }

  const solUsdSource: ResolvedBacktestProfile["solUsdSource"] =
    overrides.solUsd !== undefined ? "flag" : "window-start";
  const solUsd = overrides.solUsd ?? input.windowStartSolUsd;
  if (solUsd === null || !(solUsd > 0)) {
    throw new BacktestProfileError(
      "no SOL/USD to size the account in dollars (the reference series is empty); " +
        "pass --solusd=<price>, or --capital to size it yourself",
    );
  }

  const live = {
    capitalSol: profile.capitalSol,
    capitalUsd: profile.capitalSol * solUsd,
    positionSizePct: (profile.maxPositionSol / profile.capitalSol) * 100,
    maxConcurrentPositions: fundable,
  };

  const options: BacktestAccountOptions = {
    capitalUsd: overrides.capitalUsd ?? live.capitalUsd,
    positionSizePct: overrides.positionSizePct ?? live.positionSizePct,
    maxConcurrentPositions: overrides.maxConcurrentPositions ?? live.maxConcurrentPositions,
    gasSolPerTransaction: overrides.gasSolPerTransaction ?? input.defaultGasSolPerTransaction,
  };

  const overridden: ResolvedBacktestProfile["overridden"] = [];
  const differs = (a: number, b: number) => Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b));
  if (differs(options.capitalUsd, live.capitalUsd)) overridden.push("capital");
  if (differs(options.positionSizePct, live.positionSizePct)) overridden.push("sizepct");
  if (options.maxConcurrentPositions !== live.maxConcurrentPositions) overridden.push("concurrent");

  const notionalUsd = options.capitalUsd * (options.positionSizePct / 100);
  return {
    options,
    solUsd,
    solUsdSource,
    live,
    overridden,
    matchesLive: overridden.length === 0,
    notionalUsd,
    notionalSol: notionalUsd / solUsd,
  };
}

/** The header block every micro-capital report opens with. */
export function describeBacktestProfile(p: ResolvedBacktestProfile): string[] {
  const o = p.options;
  const lines = [
    `Profile         : ${p.matchesLive ? "LIVE (derived from LIVE_CAPITAL_SOL / LIVE_MAX_POSITION_SOL)" : "NOT THE LIVE PROFILE"}`,
    `  capital       : $${o.capitalUsd.toFixed(2)} (${(o.capitalUsd / p.solUsd).toFixed(4)} SOL)`,
    `  size          : ${o.positionSizePct.toFixed(2)}% per position = $${p.notionalUsd.toFixed(2)} / ` +
      `${p.notionalSol.toFixed(4)} SOL notional`,
    `  concurrent    : ${o.maxConcurrentPositions}`,
    `  gas           : ${o.gasSolPerTransaction} SOL/tx`,
    `  SOL/USD       : $${p.solUsd.toFixed(2)} (${p.solUsdSource === "flag" ? "--solusd" : "window start"})`,
  ];
  if (!p.matchesLive) {
    lines.push(
      `  ** WARNING   : ${p.overridden.map((f) => `--${f}`).join(", ")} overrode the live profile ` +
        `(live: $${p.live.capitalUsd.toFixed(2)}, ${p.live.positionSizePct.toFixed(2)}%, ` +
        `${p.live.maxConcurrentPositions} concurrent). These numbers describe a DIFFERENT ` +
        `account and must not be read as the live engine's. **`,
    );
  }
  return lines;
}
