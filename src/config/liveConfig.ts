import { z } from "zod";
import { env } from "./env.js";

/**
 * Live micro-capital profile: 1 SOL of real money, not the $1,000 paper baseline.
 *
 * This module is a CONFIGURATION LAYER ONLY. It does not enable live trading and
 * cannot: `env.ts` refuses to boot on `DRY_RUN=false`, `isLiveTradingEnabled` is a
 * `false` literal, and no code path in this repository signs, serialises or submits a
 * Solana transaction. Arming this profile changes how the engine SIZES and SCREENS,
 * so the dry run rehearses the live envelope before any execution code exists. It
 * does not move funds.
 *
 * Everything here defaults to INERT. `LIVE_MICRO_CAPITAL=false` (the default) leaves
 * sizing, the friction gate and startup byte-identical to the paper engine — the same
 * inert-default discipline `defaultBacktestConfig()` uses, so that adding a gate never
 * silently rewrites historical output. Turning the flag on is the only thing that
 * changes behaviour.
 *
 * NOTHING here touches the V1.1 baseline. Pool cooldown (4h), the lockout (2 failures
 * -> 24h), `MIN_FEE_COST_COVERAGE` (2.5x), the screener and monitor clocks, and the
 * 16k reasoning cap are read from `env`/`constants` unchanged. The micro-capital
 * friction rule is an ADDITIONAL layer stacked on top of the 2.5x coverage gate, never
 * a replacement for it: a candidate must clear both.
 */

/** Solana's fixed denomination. Mirrors the private constant in `solana.ts`. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

const numeric = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? defaultValue : Number(v)))
    .pipe(z.number().finite());

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return defaultValue;
      return ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
    });

/** Same placeholder discipline as `env.ts`: a copied `.env.example` value is not a value. */
const PLACEHOLDER = /^(your_|<|changeme|xxx+$|todo$)/i;

const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim() ?? "";
    if (trimmed === "" || PLACEHOLDER.test(trimmed)) return undefined;
    return trimmed;
  });

const LiveConfigSchema = z
  .object({
    /**
     * Master switch. OFF by default so `npm run dev`, every backtest and every test
     * behaves exactly as it did before this file existed.
     */
    LIVE_MICRO_CAPITAL: booleanish(false),

    /* ---- Capital & position sizing ---- */
    /** Total capital base, in SOL. The account, not a notional baseline. */
    LIVE_CAPITAL_SOL: numeric(1.0),
    /** Ceiling on one position, in SOL. 0.20 = 20% of a 1 SOL book. */
    LIVE_MAX_POSITION_SOL: numeric(0.2),
    /** Concurrency ceiling. 3 x 0.20 = 0.60 SOL of maximum simultaneous exposure. */
    LIVE_MAX_CONCURRENT_POSITIONS: numeric(3),
    /**
     * Untouchable reserve, in SOL, for network fees and rent-exempt minimums.
     *
     * Subtracted from the capital base BEFORE any sizing decision. A DLMM position
     * that cannot pay for its own close is not a position, it is a stranded balance:
     * the exit transaction costs gas too, and the fast monitor's stop-loss is
     * worthless if the wallet cannot fund the transaction that acts on it.
     */
    LIVE_MIN_RESERVE_SOL: numeric(0.15),

    /* ---- Micro-capital friction ---- */
    /**
     * Assumed round-trip (open + close) network cost in SOL: used when the live
     * `getRecentPrioritizationFees` estimate is unavailable, and as a FLOOR when it
     * is present.
     *
     * A floor, not merely a fallback. The documented way this strategy churned itself
     * into a loss was treating a round trip as cheaper than it was, and at 0.20 SOL of
     * notional there is no margin to absorb that error. Erring high skips trades;
     * erring low takes trades that cannot pay for themselves.
     */
    LIVE_ROUND_TRIP_GAS_SOL: numeric(0.008),
    /**
     * Minimum projected NET PnL, in USD, for an entry to be taken.
     *
     * Projected = (expected fees over LIVE_PNL_HORIZON_HOURS) - (round-trip gas +
     * forced-exit slippage). It is a projection off the conservative pool-level fee
     * model, NOT a forecast of realised profit: fees stop accruing out of range, and
     * LP value change is not in this number at all. Read it as "this pool is not
     * mathematically doomed by friction", never as "this pool will make $1.50".
     */
    LIVE_MIN_NET_PNL_USD: numeric(1.5),
    /** Horizon the projection above is measured over. Matches the 24h fee model. */
    LIVE_PNL_HORIZON_HOURS: numeric(24),

    /* ---- Wallet safety ---- */
    /**
     * Startup floor. A wallet below this refuses to start the engine and pages the
     * operator with INSUFFICIENT_GAS_RESERVE.
     *
     * Above LIVE_MIN_RESERVE_SOL on purpose: the reserve is what must SURVIVE, this is
     * what must be PRESENT before the engine is allowed to start spending toward it.
     */
    LIVE_MIN_WALLET_SOL: numeric(0.2),
    /**
     * The wallet's PUBLIC address, used only to read a balance via `getBalance`.
     *
     * Deliberately separate from the secret key. Deriving the public key would mean
     * decoding secret material on every boot for a read-only balance probe; a public
     * address does the same job and cannot leak anything. The probe never has access
     * to the key.
     */
    SOLANA_WALLET_ADDRESS: optionalString,
  })
  .superRefine((cfg, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    for (const key of [
      "LIVE_CAPITAL_SOL",
      "LIVE_MAX_POSITION_SOL",
      "LIVE_ROUND_TRIP_GAS_SOL",
      "LIVE_MIN_WALLET_SOL",
    ] as const) {
      if (cfg[key] <= 0) fail(key, `${key} must be greater than zero.`);
    }
    if (cfg.LIVE_MIN_RESERVE_SOL < 0) {
      fail("LIVE_MIN_RESERVE_SOL", "LIVE_MIN_RESERVE_SOL cannot be negative.");
    }
    if (
      !Number.isInteger(cfg.LIVE_MAX_CONCURRENT_POSITIONS) ||
      cfg.LIVE_MAX_CONCURRENT_POSITIONS < 1
    ) {
      fail(
        "LIVE_MAX_CONCURRENT_POSITIONS",
        "LIVE_MAX_CONCURRENT_POSITIONS must be an integer >= 1.",
      );
    }
    if (cfg.LIVE_PNL_HORIZON_HOURS <= 0) {
      fail("LIVE_PNL_HORIZON_HOURS", "LIVE_PNL_HORIZON_HOURS must be greater than zero.");
    }
    if (cfg.LIVE_MIN_NET_PNL_USD < 0) {
      fail("LIVE_MIN_NET_PNL_USD", "LIVE_MIN_NET_PNL_USD cannot be negative.");
    }

    /*
     * The reserve is only a reserve if the sizing rules cannot reach it. Checked here
     * rather than clamped at sizing time so a contradictory profile is a boot failure
     * with the arithmetic printed, not a silent runtime truncation nobody reads.
     */
    const deployable = cfg.LIVE_CAPITAL_SOL - cfg.LIVE_MIN_RESERVE_SOL;
    if (deployable <= 0) {
      fail(
        "LIVE_MIN_RESERVE_SOL",
        `reserve ${cfg.LIVE_MIN_RESERVE_SOL} SOL leaves nothing deployable out of ` +
          `${cfg.LIVE_CAPITAL_SOL} SOL.`,
      );
      return;
    }
    if (cfg.LIVE_MAX_POSITION_SOL > deployable + 1e-9) {
      fail(
        "LIVE_MAX_POSITION_SOL",
        `one position of ${cfg.LIVE_MAX_POSITION_SOL} SOL exceeds the ${deployable.toFixed(4)} ` +
          `SOL deployable after the ${cfg.LIVE_MIN_RESERVE_SOL} SOL reserve.`,
      );
    }
    const maxExposure = cfg.LIVE_MAX_POSITION_SOL * cfg.LIVE_MAX_CONCURRENT_POSITIONS;
    if (maxExposure > deployable + 1e-9) {
      fail(
        "LIVE_MAX_CONCURRENT_POSITIONS",
        `${cfg.LIVE_MAX_CONCURRENT_POSITIONS} x ${cfg.LIVE_MAX_POSITION_SOL} SOL = ` +
          `${maxExposure.toFixed(4)} SOL of exposure exceeds the ${deployable.toFixed(4)} SOL ` +
          `deployable after the ${cfg.LIVE_MIN_RESERVE_SOL} SOL reserve.`,
      );
    }
    if (cfg.LIVE_MIN_WALLET_SOL < cfg.LIVE_MIN_RESERVE_SOL) {
      fail(
        "LIVE_MIN_WALLET_SOL",
        `the startup floor (${cfg.LIVE_MIN_WALLET_SOL} SOL) is below the reserve that must ` +
          `survive (${cfg.LIVE_MIN_RESERVE_SOL} SOL), so the engine would start already short.`,
      );
    }
  });

export interface LiveMicroCapitalConfig {
  /** True only when LIVE_MICRO_CAPITAL is explicitly enabled. */
  readonly enabled: boolean;
  readonly capitalSol: number;
  readonly maxPositionSol: number;
  readonly maxConcurrentPositions: number;
  readonly minReserveSol: number;
  /** capitalSol - minReserveSol. The most that may ever be at risk simultaneously. */
  readonly deployableSol: number;
  /** maxPositionSol x maxConcurrentPositions. Always <= deployableSol. */
  readonly maxExposureSol: number;
  readonly roundTripGasSol: number;
  readonly minNetPnlUsd: number;
  readonly pnlHorizonHours: number;
  readonly minWalletSol: number;
  readonly walletAddress: string | undefined;
}

export type LiveConfigResult =
  | { ok: true; config: LiveMicroCapitalConfig }
  | { ok: false; issues: string[] };

/**
 * Pure parse. Exported so the validation rules can be tested without a process exit
 * and without mutating the real environment — the module-level parse below is the
 * only caller that treats a failure as fatal.
 */
export function parseLiveConfig(source: NodeJS.ProcessEnv = process.env): LiveConfigResult {
  const parsed = LiveConfigSchema.safeParse(source);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  const cfg = parsed.data;
  return {
    ok: true,
    config: Object.freeze({
      enabled: cfg.LIVE_MICRO_CAPITAL,
      capitalSol: cfg.LIVE_CAPITAL_SOL,
      maxPositionSol: cfg.LIVE_MAX_POSITION_SOL,
      maxConcurrentPositions: cfg.LIVE_MAX_CONCURRENT_POSITIONS,
      minReserveSol: cfg.LIVE_MIN_RESERVE_SOL,
      deployableSol: cfg.LIVE_CAPITAL_SOL - cfg.LIVE_MIN_RESERVE_SOL,
      maxExposureSol: cfg.LIVE_MAX_POSITION_SOL * cfg.LIVE_MAX_CONCURRENT_POSITIONS,
      roundTripGasSol: cfg.LIVE_ROUND_TRIP_GAS_SOL,
      minNetPnlUsd: cfg.LIVE_MIN_NET_PNL_USD,
      pnlHorizonHours: cfg.LIVE_PNL_HORIZON_HOURS,
      minWalletSol: cfg.LIVE_MIN_WALLET_SOL,
      walletAddress: cfg.SOLANA_WALLET_ADDRESS,
    }),
  };
}

const resolved = parseLiveConfig(process.env);

if (!resolved.ok) {
  console.error(
    `\n[liveConfig] Invalid live micro-capital configuration:\n` +
      resolved.issues.map((i) => `  - ${i}`).join("\n") +
      `\n`,
  );
  process.exit(1);
}

export const liveMicroCapital: LiveMicroCapitalConfig = resolved.config;

/* ------------------------------------------------------------------ */
/* Private key handling                                                */
/* ------------------------------------------------------------------ */

/**
 * Whether a signing key is configured, WITHOUT returning or logging it.
 *
 * `env.ts` already reads SOLANA_PRIVATE_KEY from the environment only, and this
 * module never reads it any other way. There is deliberately no accessor that returns
 * the secret: nothing in this repository can sign a transaction, so such an accessor
 * would exist purely as a route for the key to reach a log line. `liveConfig.test.ts`
 * asserts no base58 key literal is checked into `src/`.
 */
export function hasLiveSigningKey(): boolean {
  return Boolean(env.SOLANA_PRIVATE_KEY);
}

/** A fixed mask. Not derived from the key, so it cannot leak its length or prefix. */
export const REDACTED_KEY = "<redacted:SOLANA_PRIVATE_KEY>" as const;

/* ------------------------------------------------------------------ */
/* Position sizing against free capital                                */
/* ------------------------------------------------------------------ */

export interface SizingDecision {
  /** SOL to deploy. 0 means no position may be opened right now. */
  sizeSol: number;
  /** Free capital after the reserve and open exposure. */
  freeSol: number;
  /** Populated only when sizeSol is 0. */
  reason?: string;
}

/**
 * Sizes the next position against FREE capital, never against the capital base.
 *
 * The same trap the backtest documents: sizing three concurrent positions at
 * `capital x pct` deploys the same SOL three times over and reads as leverage the
 * account does not have. Open notional and the untouchable reserve are both
 * subtracted before anything is sized.
 *
 * @param openNotionalSol total SOL currently committed to open positions.
 * @param openPositions   how many positions are currently open.
 */
export function sizeNextPositionSol(
  openNotionalSol: number,
  openPositions: number,
  config: LiveMicroCapitalConfig = liveMicroCapital,
): SizingDecision {
  const open = Number.isFinite(openNotionalSol) ? Math.max(openNotionalSol, 0) : 0;
  const freeSol = Math.max(config.deployableSol - open, 0);

  if (openPositions >= config.maxConcurrentPositions) {
    return {
      sizeSol: 0,
      freeSol,
      reason: `at capacity (${openPositions}/${config.maxConcurrentPositions} positions)`,
    };
  }

  /*
   * A position smaller than the cap is a position whose fixed costs have NOT shrunk
   * with it — gas is per transaction, not per SOL. Rather than open a stub that cannot
   * clear its own friction, refuse and wait for a close to free the capital.
   */
  if (freeSol + 1e-9 < config.maxPositionSol) {
    return {
      sizeSol: 0,
      freeSol,
      reason:
        `free capital ${freeSol.toFixed(4)} SOL is below the ${config.maxPositionSol} SOL ` +
        `position size (${open.toFixed(4)} SOL open, ${config.minReserveSol} SOL reserved)`,
    };
  }

  return { sizeSol: config.maxPositionSol, freeSol };
}

/* ------------------------------------------------------------------ */
/* Micro-capital friction gate                                         */
/* ------------------------------------------------------------------ */

export interface MicroCapitalFrictionInput {
  /** Position notional in USD (sizeSol x SOL/USD at entry). */
  notionalUsd: number;
  /** 24h fee/TVL as a RATIO (0.008 = 0.8%), never the upstream percent field. */
  feeTvlRatio24h: number;
  /** Live round-trip gas estimate in USD, or null when unavailable. */
  gasRoundTripUsd: number | null;
  /** SOL/USD, used to price the LIVE_ROUND_TRIP_GAS_SOL floor. */
  solPriceUsd: number;
  /** Forced-exit price concession, in percent. Defaults to the live setting. */
  slippagePct?: number;
  config?: LiveMicroCapitalConfig;
}

export interface MicroCapitalFrictionAssessment {
  /** Gas actually charged to the projection: max(live estimate, configured floor). */
  gasRoundTripUsd: number;
  /** True when the configured floor was used (estimate missing, or lower than it). */
  gasFloorApplied: boolean;
  slippageUsd: number;
  /** gas + slippage. */
  roundTripCostUsd: number;
  /** Fees projected over the horizon, from the conservative pool-level model. */
  projectedFeeUsd: number;
  /** projectedFeeUsd - roundTripCostUsd. */
  projectedNetPnlUsd: number;
  passes: boolean;
  reason?: string;
}

/**
 * The micro-capital layer of the friction gate: an ABSOLUTE dollar floor stacked on
 * top of the V1.1 `MIN_FEE_COST_COVERAGE` ratio, not a replacement for it.
 *
 * The ratio gate asks "do fees beat friction by 2.5x?", which is scale-free and stays
 * satisfiable at any notional. At 0.20 SOL that is no longer the binding question:
 * 2.5x of a cost measured in cents is still cents, and a trade netting $0.04 has
 * consumed a real entry slot, a real 4h cooldown, and real operator attention. This
 * gate asks the second question — "is the projected result large enough to be worth
 * the trip at all?" — and a candidate must answer yes to both.
 *
 * Gas is charged at `max(live estimate, LIVE_ROUND_TRIP_GAS_SOL x SOL/USD)`. The floor
 * wins ties and wins whenever the live estimate is missing: unknown cost is never
 * treated as zero cost, the same fail-closed rule the anti-rug and volatility gates
 * use.
 */
export function assessMicroCapitalFriction(
  input: MicroCapitalFrictionInput,
): MicroCapitalFrictionAssessment {
  const config = input.config ?? liveMicroCapital;
  const slippagePct = input.slippagePct ?? env.FORCED_EXIT_SLIPPAGE_PCT;

  const gasFloorUsd = config.roundTripGasSol * input.solPriceUsd;
  const liveGasUsd =
    input.gasRoundTripUsd !== null && Number.isFinite(input.gasRoundTripUsd)
      ? input.gasRoundTripUsd
      : null;

  const gasRoundTripUsd = liveGasUsd === null ? gasFloorUsd : Math.max(liveGasUsd, gasFloorUsd);
  const gasFloorApplied = liveGasUsd === null || gasFloorUsd >= liveGasUsd;

  const slippageUsd = input.notionalUsd * (slippagePct / 100);
  const roundTripCostUsd = gasRoundTripUsd + slippageUsd;

  // The fee model is pool-level and 24h-based; scale it to the configured horizon.
  const projectedFeeUsd = input.notionalUsd * input.feeTvlRatio24h * (config.pnlHorizonHours / 24);
  const projectedNetPnlUsd = projectedFeeUsd - roundTripCostUsd;

  const passes = projectedNetPnlUsd >= config.minNetPnlUsd;

  return {
    gasRoundTripUsd,
    gasFloorApplied,
    slippageUsd,
    roundTripCostUsd,
    projectedFeeUsd,
    projectedNetPnlUsd,
    passes,
    reason: passes
      ? undefined
      : `projected net PnL $${projectedNetPnlUsd.toFixed(4)} over ${config.pnlHorizonHours}h ` +
        `is below the $${config.minNetPnlUsd.toFixed(2)} floor ` +
        `(fees $${projectedFeeUsd.toFixed(4)} - friction $${roundTripCostUsd.toFixed(4)})`,
  };
}

/**
 * The 24h fee/TVL ratio a pool must show for `assessMicroCapitalFriction` to pass at a
 * given notional.
 *
 * Diagnostic, and the reason it exists is not decorative: at a small notional the
 * absolute $ floor implies a fee yield that may sit outside anything the screener will
 * ever surface. `describeLiveEnvelope` prints this at boot so the gate's real
 * strictness is legible up front, rather than discovered later as a permanently empty
 * candidate list that looks like a bug.
 */
export function requiredFeeTvlRatio24h(
  notionalUsd: number,
  solPriceUsd: number,
  config: LiveMicroCapitalConfig = liveMicroCapital,
  slippagePct: number = env.FORCED_EXIT_SLIPPAGE_PCT,
): number {
  if (!(notionalUsd > 0)) return Infinity;
  const gasUsd = config.roundTripGasSol * solPriceUsd;
  const frictionUsd = gasUsd + notionalUsd * (slippagePct / 100);
  const requiredFeeUsd = config.minNetPnlUsd + frictionUsd;
  return requiredFeeUsd / (notionalUsd * (config.pnlHorizonHours / 24));
}

/**
 * Human-readable summary of the armed envelope, including the implied fee yield the
 * $ floor demands and an explicit warning when that lands above `MAX_FEE_TVL_RATIO`
 * (i.e. the screener's own outlier ceiling would reject every pool that could pass).
 */
export function describeLiveEnvelope(
  solPriceUsd: number,
  config: LiveMicroCapitalConfig = liveMicroCapital,
): string[] {
  const notionalUsd = config.maxPositionSol * solPriceUsd;
  const required = requiredFeeTvlRatio24h(notionalUsd, solPriceUsd, config);
  const lines = [
    `capital    : ${config.capitalSol} SOL (~$${(config.capitalSol * solPriceUsd).toFixed(2)})`,
    `position   : ${config.maxPositionSol} SOL (~$${notionalUsd.toFixed(2)}) x ` +
      `${config.maxConcurrentPositions} max = ${config.maxExposureSol.toFixed(2)} SOL exposure`,
    `reserve    : ${config.minReserveSol} SOL untouchable, ` +
      `${config.deployableSol.toFixed(2)} SOL deployable`,
    `friction   : ${config.roundTripGasSol} SOL round-trip gas floor, ` +
      `net PnL floor $${config.minNetPnlUsd.toFixed(2)} over ${config.pnlHorizonHours}h`,
    `implies    : a pool must show >= ${(required * 100).toFixed(2)}% fee/TVL in 24h ` +
      `to clear the $${config.minNetPnlUsd.toFixed(2)} floor at this size`,
  ];

  if (required > env.MAX_FEE_TVL_RATIO) {
    lines.push(
      `WARNING    : that exceeds MAX_FEE_TVL_RATIO (${(env.MAX_FEE_TVL_RATIO * 100).toFixed(2)}%), ` +
        `so the screener's outlier ceiling rejects every pool that could clear the floor. ` +
        `No entry can be opened under this profile.`,
    );
  } else if (required > env.MIN_FEE_TVL_RATIO * 10) {
    lines.push(
      `WARNING    : that is ${(required / env.MIN_FEE_TVL_RATIO).toFixed(0)}x MIN_FEE_TVL_RATIO ` +
        `(${(env.MIN_FEE_TVL_RATIO * 100).toFixed(2)}%); expect very few or no candidates.`,
    );
  }

  return lines;
}
