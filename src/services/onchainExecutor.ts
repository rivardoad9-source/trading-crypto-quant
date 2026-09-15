import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
// Type-only: erased at compile time, so importing this module still does not pull the
// DLMM SDK (or Anchor, or spl-token) into memory. The runtime value arrives through
// `loadDlmmSdk()` below, on first use.
import type DlmmPool from "@meteora-ag/dlmm";
import type { LbPosition, StrategyType } from "@meteora-ag/dlmm";
import { z } from "zod";
import { env } from "../config/env.js";
import { getPriorityFeeEstimateSafe } from "./solana.js";

/**
 * On-chain execution: wallet loading, transaction signing, submission and
 * confirmation.
 *
 * STATUS: STAGE 1. Nothing in the running engine imports this module, and
 * `src/tests/onchainExecutor.test.ts` fails the build if that ever changes. The
 * engine remains paper-only; this is a separately armed capability being built
 * alongside it, not a switch that has been flipped.
 *
 * The isolation is enforced three ways, deliberately at different levels so one
 * mistake does not defeat all of them:
 *
 *  1. TYPE LEVEL. Every function that can move funds requires an
 *     `ExecutionAuthorization`, and the only way to obtain one is
 *     `authorizeExecution()`, which throws unless the operator has explicitly armed
 *     execution. A caller cannot "forget" the check — there is no overload without
 *     it, so accidental execution is a compile error rather than a runtime surprise.
 *  2. CONFIGURATION. `ONCHAIN_EXECUTION_ARMED` defaults to false, and arming also
 *     requires a wallet key and an explicit per-transaction lamport ceiling.
 *  3. IMPORT GRAPH. A test walks every import reachable from `src/index.ts` and
 *     fails if this module appears anywhere in it.
 *
 * This module does not read `isLiveTradingEnabled` at all. Arming it and arming the
 * ENGINE stay two independent facts: `ONCHAIN_EXECUTION_ARMED` says these functions
 * may sign, `DRY_RUN=false` says the engine should trade for real, and the engine can
 * reach this module only through `services/liveExecution.ts`.
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Absolute ceiling on slippage, in basis points. 50 bps = 0.5%.
 *
 * A CONSTANT, not a setting. `ONCHAIN_MAX_SLIPPAGE_BPS` may lower it and may never
 * raise it: a slippage bound that configuration can widen is not a bound. On a
 * micro-notional swap a loose bound is also uniquely expensive — 3% of a $20 trip is
 * more than the entire projected edge the live profile's $1.50 floor is defending.
 */
export const HARD_MAX_SLIPPAGE_BPS = 50 as const;

/**
 * Absolute ceiling on slippage for an EXIT leg (the residual sale after a close, and the
 * auto-unwind after a failed open), in basis points. 500 bps = 5%.
 *
 * WHY A SECOND, WIDER CAP — 13 Sep 2026, real money, and the operator had to sell by hand.
 *
 * `HARD_MAX_SLIPPAGE_BPS` (50) bounds what an ENTRY may pay, and that asymmetry is the
 * whole point: refusing a bad entry costs nothing, while a refused EXIT leaves the
 * position's value sitting in the wallet as a memecoin nothing monitors. On 13 Sep 2026
 * an EMBER-SOL close returned 1,568 EMBER; the residual sale was refused at the 50 bps
 * bound — the route's own program rejected it — the ten-minute self-heal retried at the
 * SAME bound and failed identically, and the operator sold it by hand while the price
 * moved. The engine had the intent (`executeJupiterSwapFreshQuote` already re-quotes on a
 * slippage refusal) but not the room: three re-quotes at 0.5% is 0.5% three times.
 *
 * 500 bps is bounded and auditable: on a $180 notional a worst-case fill costs ~$9, which
 * is real money but strictly better than an unsold token in a market that moves 10% in an
 * hour. Entries NEVER consult this constant.
 */
export const HARD_MAX_EXIT_SLIPPAGE_BPS = 500 as const;

/**
 * Absolute ceiling on the DLMM ACTIVE-BIN tolerance, in basis points. 1000 bps = 10%.
 *
 * A DIFFERENT QUANTITY FROM `HARD_MAX_SLIPPAGE_BPS`, and conflating the two is the
 * 9 Sep 2026 defect. Jupiter's bound prices a SWAP: every bp of it is money the trade
 * can lose to a worse fill, which is why 50 bps is right there. The DLMM deposit's
 * `slippage` prices something else entirely — the SDK converts it to a BIN COUNT,
 *
 *     maxActiveBinSlippage = ceil(slippagePercent / (binStep / 100))
 *
 * which is how far the pool's active bin may drift between the moment the funding
 * instructions are BUILT and the moment they LAND before the program rejects them
 * (`ExceededBinSlippageTolerance`, custom 6004). At the swap's 0.5% that is
 * `ceil(0.5 / 1) = 1 bin` on a bin_step-100 pool — one bin of tolerance on a memecoin
 * pool, across a window that includes a blockhash lifetime. It is not a loss bound
 * being widened here; it is a race the tight number could not win.
 *
 * It is still a bound, and still a constant for the same reason: the SDK applies the
 * SAME percentage to `maxDeposit{X,Y}Amount` (`floor(amount x (100 + pct) / 100)`), so
 * widening it does raise the ceiling on what the program may pull from the wallet.
 * That overshoot is charged to `assertWithinSpendLimit` rather than assumed away —
 * see `depositSlippage`.
 */
export const HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS = 1000 as const;

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

const OnchainSchema = z.object({
  /** Master switch. Off by default; arming still does not touch the engine. */
  ONCHAIN_EXECUTION_ARMED: booleanish(false),
  /**
   * Hard ceiling on the SOL any single transaction may move, in lamports.
   *
   * Deliberately tiny (0.02 SOL). This is the blast radius of a bug in code that has
   * never run against mainnet: a wrong decimal, a mint mix-up or a runaway loop
   * cannot cost more than this per transaction. Raise it only after the PoC has
   * actually settled, and raise it in steps.
   */
  ONCHAIN_MAX_LAMPORTS_PER_TX: numeric(20_000_000),
  /** Slippage bound in bps. Clamped down to HARD_MAX_SLIPPAGE_BPS; never up. */
  ONCHAIN_MAX_SLIPPAGE_BPS: numeric(HARD_MAX_SLIPPAGE_BPS),
  /**
   * Slippage bound for EXIT legs only, in bps. Clamped down to
   * HARD_MAX_EXIT_SLIPPAGE_BPS; never up.
   *
   * 300 bps (3%) by default. A sale that must happen is not a trade that can be refused:
   * on 13 Sep 2026 a residual sale of 1,568 EMBER was refused at the 50 bps ENTRY bound,
   * the retry loop repeated the same refusal, and the operator had to sell by hand. Widening
   * this knob does not touch entries, entries still ride ONCHAIN_MAX_SLIPPAGE_BPS.
   */
  EXIT_MAX_SLIPPAGE_BPS: numeric(300),
  /**
   * DLMM active-bin tolerance in bps. Clamped down to
   * HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS; never up.
   *
   * 300 bps (3%) by default rather than the swap's 50, because this number does not
   * bound a loss — it buys bins of drift. On a bin_step-100 pool it is 3 bins where
   * the swap bound gave 1; on bin_step 20 it is 15. See
   * HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS for why the two must not share a knob.
   */
  ONCHAIN_MAX_ACTIVE_BIN_SLIPPAGE_BPS: numeric(300),
  /** Compute units requested per transaction. */
  ONCHAIN_COMPUTE_UNIT_LIMIT: numeric(400_000),
  /** Starting priority fee when the live sample is unavailable or zero. */
  ONCHAIN_MIN_PRIORITY_MICRO_LAMPORTS: numeric(20_000),
  /** Ceiling on the priority fee after escalation, in micro-lamports per CU. */
  ONCHAIN_MAX_PRIORITY_MICRO_LAMPORTS: numeric(2_000_000),
  /** Multiplier applied to the priority fee on each rebuild. */
  ONCHAIN_PRIORITY_ESCALATION: numeric(2.0),
  /**
   * How many times a transaction may be REBUILT after its blockhash expires.
   *
   * 8, not 3 (raised 12 Sep 2026 after a live incident). The fee escalates by
   * `ONCHAIN_PRIORITY_ESCALATION` per rebuild, so a chain of 3 doublings from the 20 000
   * micro-lamports floor tops out at 80 000 — roughly 0.000016 SOL of priority fee at the
   * 400 000 CU floor, which a busy cluster simply ignores. On 12 Sep 2026 the recovery for
   * a half-landed open (the Jupiter auto-unwind, then `closeOrphanPosition`) lost all
   * three rebuilds to `blockhash expired` and gave up, leaving 1.8 SOL of live capital in
   * a funded position nothing was watching until an operator closed it by hand.
   * 8 rebuilds reach the `ONCHAIN_MAX_PRIORITY_MICRO_LAMPORTS` ceiling (20 000 x 2^7 =
   * 2.56 M > 2 M), so the last attempt is priced to land whatever the cluster is charging;
   * the whole worst-case chain costs ~0.0008 SOL. See
   * `docs/incidents/2026-09-12-half-landed-open-orphan-manlet.md`.
   */
  ONCHAIN_MAX_BUILD_ATTEMPTS: numeric(8),
  /** Jupiter swap API base. Keyless lite tier; matches ENDPOINTS.JUPITER_PRICE's host. */
  JUPITER_SWAP_API_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
});

export type OnchainConfig = {
  readonly armed: boolean;
  readonly maxLamportsPerTx: number;
  readonly maxSlippageBps: number;
  /**
   * The EXIT-leg slippage bound. A SEPARATE FIELD from `maxSlippageBps` on purpose: they
   * bound different decisions, and the 13 Sep 2026 incident is what happens when one knob
   * has to serve both (a residual sale refused at the ENTRY bound, retried at the same
   * bound, and finished by hand).
   */
  readonly exitMaxSlippageBps: number;
  readonly maxActiveBinSlippageBps: number;
  readonly computeUnitLimit: number;
  readonly minPriorityMicroLamports: number;
  readonly maxPriorityMicroLamports: number;
  readonly priorityEscalation: number;
  readonly maxBuildAttempts: number;
  readonly jupiterSwapApiUrl: string;
};

export function resolveOnchainConfig(source: NodeJS.ProcessEnv = process.env): OnchainConfig {
  const parsed = OnchainSchema.parse(source);

  // Clamped DOWN only. A configured 300 bps silently becomes 50, because the point of
  // a hard cap is that no configuration can widen it.
  const slippage = Math.max(1, Math.min(parsed.ONCHAIN_MAX_SLIPPAGE_BPS, HARD_MAX_SLIPPAGE_BPS));
  // The exit bound, clamped down to ITS OWN (wider) hard cap. Never up.
  const exitSlippage = Math.max(
    1,
    Math.min(parsed.EXIT_MAX_SLIPPAGE_BPS, HARD_MAX_EXIT_SLIPPAGE_BPS),
  );
  const binSlippage = Math.max(
    1,
    Math.min(parsed.ONCHAIN_MAX_ACTIVE_BIN_SLIPPAGE_BPS, HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS),
  );

  return Object.freeze({
    armed: parsed.ONCHAIN_EXECUTION_ARMED,
    maxLamportsPerTx: parsed.ONCHAIN_MAX_LAMPORTS_PER_TX,
    maxSlippageBps: slippage,
    exitMaxSlippageBps: exitSlippage,
    maxActiveBinSlippageBps: binSlippage,
    computeUnitLimit: parsed.ONCHAIN_COMPUTE_UNIT_LIMIT,
    minPriorityMicroLamports: parsed.ONCHAIN_MIN_PRIORITY_MICRO_LAMPORTS,
    maxPriorityMicroLamports: parsed.ONCHAIN_MAX_PRIORITY_MICRO_LAMPORTS,
    priorityEscalation: parsed.ONCHAIN_PRIORITY_ESCALATION,
    maxBuildAttempts: parsed.ONCHAIN_MAX_BUILD_ATTEMPTS,
    jupiterSwapApiUrl: parsed.JUPITER_SWAP_API_URL,
  });
}

export const onchainConfig: OnchainConfig = resolveOnchainConfig();

/* ------------------------------------------------------------------ */
/* Guardlock                                                           */
/* ------------------------------------------------------------------ */

export class ExecutionNotArmedError extends Error {
  constructor(reason: string) {
    super(`[onchain] execution not armed: ${reason}`);
    this.name = "ExecutionNotArmedError";
  }
}

export class ExecutionLimitError extends Error {
  constructor(message: string) {
    super(`[onchain] ${message}`);
    this.name = "ExecutionLimitError";
  }
}

declare const authorizationBrand: unique symbol;

/**
 * Proof that the operator explicitly armed on-chain execution.
 *
 * Branded so it cannot be forged by an object literal: the only way to hold one is to
 * call `authorizeExecution()` and have it not throw. Every fund-moving function takes
 * one, which turns "did anybody check whether we are allowed to spend?" from a
 * convention into a type error.
 */
export interface ExecutionAuthorization {
  readonly [authorizationBrand]: true;
  readonly wallet: PublicKey;
  readonly maxLamportsPerTx: number;
  readonly maxSlippageBps: number;
  readonly maxActiveBinSlippageBps: number;
  readonly armedAt: string;
}

/**
 * Loads the signing wallet from `SOLANA_PRIVATE_KEY` (base58, 64-byte secret key).
 *
 * The key is read from the environment and nowhere else, is never logged, never
 * returned, and never stored on any exported object — `ExecutionAuthorization` carries
 * the PUBLIC key only. Errors deliberately describe the SHAPE of the problem and never
 * echo the value, because a malformed key in a stack trace is a leaked key.
 */
function loadWallet(): Keypair {
  const raw = env.SOLANA_PRIVATE_KEY;
  if (!raw) {
    throw new ExecutionNotArmedError("SOLANA_PRIVATE_KEY is not set");
  }

  let secret: Uint8Array;
  try {
    secret = bs58.decode(raw.trim());
  } catch {
    throw new ExecutionNotArmedError(
      "SOLANA_PRIVATE_KEY is not valid base58 (expected an 87-88 character string)",
    );
  }

  if (secret.length !== 64) {
    throw new ExecutionNotArmedError(
      `SOLANA_PRIVATE_KEY decoded to ${secret.length} bytes, expected 64`,
    );
  }

  try {
    return Keypair.fromSecretKey(secret);
  } catch {
    throw new ExecutionNotArmedError("SOLANA_PRIVATE_KEY is not a valid ed25519 secret key");
  }
}

/**
 * The single gate to on-chain execution. Throws unless every condition holds.
 *
 * Note what this does NOT do: it does not consult `isLiveTradingEnabled`, and it never
 * flips it. That flag governs the TRADING ENGINE; this module is armed on its own,
 * separate switch, so "the executor can sign" and "the engine trades live" stay two
 * independent facts. `scripts/testMicroSwap.ts` arms the first without the second.
 */
export function authorizeExecution(
  config: OnchainConfig = onchainConfig,
): ExecutionAuthorization {
  if (!config.armed) {
    throw new ExecutionNotArmedError(
      "ONCHAIN_EXECUTION_ARMED is not true. This is the default; arming it is an " +
        "explicit, per-operator decision.",
    );
  }

  /*
   * The tripwire that used to live here refused to sign whenever
   * `isLiveTradingEnabled` was anything but false. That was correct while the flag was
   * a `false` literal and an unexplained `true` could only mean an unreviewed change.
   * It cannot survive live mode: the flag is now legitimately true whenever the
   * operator has set `DRY_RUN=false` AND armed this module, so keeping the check would
   * refuse every live signature — the engine would screen, decide, and then fail on
   * the last step, every time.
   *
   * What replaces it is not weaker. `config.armed` above is still the real gate and
   * still defaults to false, and the flag can no longer become true by accident: it is
   * the AND of two switches, and `env.ts` refuses to boot on either one alone. So
   * "armed by proxy" is now prevented by construction rather than by a tripwire.
   */

  if (!(config.maxLamportsPerTx > 0)) {
    throw new ExecutionNotArmedError("ONCHAIN_MAX_LAMPORTS_PER_TX must be greater than zero");
  }
  if (config.maxActiveBinSlippageBps > HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS) {
    // Same reasoning as the swap bound below: a hand-built config must not be able to
    // widen it either. The cap is looser because the quantity is a bin count, not a
    // loss — but a bound configuration can widen is not a bound.
    throw new ExecutionNotArmedError(
      `active-bin slippage ${config.maxActiveBinSlippageBps} bps exceeds the hard cap ` +
        `of ${HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS} bps`,
    );
  }
  if (config.maxSlippageBps > HARD_MAX_SLIPPAGE_BPS) {
    // Unreachable via resolveOnchainConfig, which clamps. Kept because a hand-built
    // config object reaching here must not be able to widen the bound either.
    throw new ExecutionNotArmedError(
      `slippage ${config.maxSlippageBps} bps exceeds the hard cap of ${HARD_MAX_SLIPPAGE_BPS} bps`,
    );
  }

  const wallet = loadWallet();

  return Object.freeze({
    wallet: wallet.publicKey,
    maxLamportsPerTx: config.maxLamportsPerTx,
    maxSlippageBps: config.maxSlippageBps,
    maxActiveBinSlippageBps: config.maxActiveBinSlippageBps,
    armedAt: new Date().toISOString(),
  }) as ExecutionAuthorization;
}

/** Whether execution COULD be armed, without arming it or touching the key. */
export function isExecutionArmable(config: OnchainConfig = onchainConfig): boolean {
  return config.armed && Boolean(env.SOLANA_PRIVATE_KEY);
}

/**
 * Rejects a spend above the configured per-transaction ceiling.
 *
 * Called before signing, never after: a transaction that has been broadcast cannot be
 * un-spent, so the only useful place for this check is upstream of the signature.
 */
export function assertWithinSpendLimit(
  auth: ExecutionAuthorization,
  lamports: number,
  label: string,
): void {
  if (!Number.isFinite(lamports) || lamports < 0) {
    throw new ExecutionLimitError(`${label}: spend amount is not a finite non-negative number`);
  }
  if (lamports > auth.maxLamportsPerTx) {
    throw new ExecutionLimitError(
      `${label}: ${lamports} lamports exceeds the per-transaction ceiling of ` +
        `${auth.maxLamportsPerTx} lamports (${(auth.maxLamportsPerTx / 1e9).toFixed(4)} SOL)`,
    );
  }
}

/** Clamps a requested slippage down to the authorized bound. Never widens it. */
export function resolveSlippageBps(auth: ExecutionAuthorization, requestedBps?: number): number {
  const requested = requestedBps ?? auth.maxSlippageBps;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new ExecutionLimitError("slippage must be a positive number of basis points");
  }
  return Math.min(Math.floor(requested), auth.maxSlippageBps, HARD_MAX_SLIPPAGE_BPS);
}

/**
 * The same clamp, for an EXIT leg, against ITS OWN bound.
 *
 * `HARD_MAX_SLIPPAGE_BPS` (50) is deliberately NOT consulted here, and `auth.maxSlippageBps`
 * is not either: both describe what an ENTRY may pay. Refusing an entry costs nothing;
 * refusing an exit strands the position's value. See `HARD_MAX_EXIT_SLIPPAGE_BPS`.
 *
 * Resolved from `EXIT_MAX_SLIPPAGE_BPS` (default 300), clamped down to the hard exit cap and
 * never widened by a caller: a requested 5,000 bps settles at the cap, not at 5,000.
 */
export function resolveExitSlippageBps(
  requestedBps?: number,
  config: Pick<OnchainConfig, "exitMaxSlippageBps"> = onchainConfig,
): number {
  const cap = Math.max(1, Math.min(config.exitMaxSlippageBps, HARD_MAX_EXIT_SLIPPAGE_BPS));
  const requested = requestedBps ?? cap;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new ExecutionLimitError("exit slippage must be a positive number of basis points");
  }
  return Math.min(Math.floor(requested), cap);
}

/** The configured exit bound, for a caller that needs the cap itself (the sweep ladder). */
export function exitSlippageCapBps(
  config: Pick<OnchainConfig, "exitMaxSlippageBps"> = onchainConfig,
): number {
  return Math.max(1, Math.min(config.exitMaxSlippageBps, HARD_MAX_EXIT_SLIPPAGE_BPS));
}

/** Which side of a trade a swap is. An exit puts capital BACK into SOL. */
export type SwapLeg = "entry" | "exit";

/**
 * The slippage bound a swap of this leg is QUOTED with — and therefore the bound its quote
 * is checked against before signing. ONE function for both, on purpose.
 *
 * 15 Sep 2026, LEVERCAT-SOL: the auto-unwind fetched its quote at the 300 bps EXIT bound and
 * `buildJupiterSwap` then refused that quote against the 50 bps ENTRY bound ("Jupiter returned
 * a quote at 300 bps slippage, above the authorized 50 bps"). Every exit-leg swap wider than
 * the entry bound was built only to be refused, so the unwind could never sell and the
 * residual ladder was a one-rung ladder in production. Two call sites each deriving "the
 * bound" is how they came to disagree; this is the single derivation both now read.
 *
 * The entry bound stays exactly as hard as it was: an entry resolves through
 * `resolveSlippageBps` (auth bound, 50 bps hard cap); only an exit reaches the exit cap.
 */
export function swapSlippageBoundBps(
  auth: Pick<ExecutionAuthorization, "maxSlippageBps">,
  leg: SwapLeg,
  requestedBps: number | undefined,
  config: Pick<OnchainConfig, "exitMaxSlippageBps"> = onchainConfig,
): number {
  return leg === "exit"
    ? resolveExitSlippageBps(requestedBps, config)
    : resolveSlippageBps(auth as ExecutionAuthorization, requestedBps);
}

/**
 * Refuses a quote that echoes a wider bound than the one this leg authorised. FAIL-CLOSED:
 * `boundBps` is re-clamped here to the leg's own hard cap, so a caller passing a nonsense
 * bound cannot widen an entry past 50 bps or an exit past the exit cap.
 */
export function assertQuoteWithinSlippageBound(
  auth: Pick<ExecutionAuthorization, "maxSlippageBps">,
  quote: Pick<JupiterQuote, "slippageBps">,
  bound: { leg: SwapLeg; bps: number },
  config: Pick<OnchainConfig, "exitMaxSlippageBps"> = onchainConfig,
): void {
  const legCap =
    bound.leg === "exit"
      ? exitSlippageCapBps(config)
      : Math.min(auth.maxSlippageBps, HARD_MAX_SLIPPAGE_BPS);
  const limit = Number.isFinite(bound.bps) && bound.bps > 0 ? Math.min(Math.floor(bound.bps), legCap) : 0;
  if (!(Number.isFinite(quote.slippageBps) && quote.slippageBps <= limit)) {
    throw new ExecutionLimitError(
      `Jupiter returned a quote at ${quote.slippageBps} bps slippage, above the ` +
        `authorized ${limit} bps (${bound.leg} leg)`,
    );
  }
}

/**
 * The DLMM deposit's slippage, resolved for one pool, in all three units at once.
 *
 * The SDK takes ONE number — a percentage — and derives two different bounds from it,
 * which is why this returns both rather than letting a call site convert one and
 * forget the other:
 *
 *  - `bins`, the active-bin tolerance, `ceil(percent / (binStep / 100))`. This is the
 *    number that decides whether funding lands: the program compares the `activeId`
 *    baked into the instruction against the pool's activeId when it EXECUTES, and
 *    rejects beyond this many bins of drift.
 *  - `depositCeilingFactor`, `(100 + percent) / 100`, which the SDK applies to
 *    `maxDeposit{X,Y}Amount`. Widening the tolerance therefore widens the most the
 *    program may pull, and that is a spend the ceiling has to see.
 *
 * Both formulas MIRROR the SDK (`getAndCapMaxActiveBinSlippage`, `getSlippageMaxAmount`
 * in the installed bundle) rather than approximate it, and `onchainExecutor.test.ts`
 * binds them to the shipped text so a bump that changes either fails the build.
 */
export function depositSlippage(
  auth: ExecutionAuthorization,
  binStep: number,
  requestedBps?: number,
): { bps: number; percent: number; bins: number; depositCeilingFactor: number } {
  const requested = requestedBps ?? auth.maxActiveBinSlippageBps;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new ExecutionLimitError("active-bin slippage must be a positive number of bps");
  }
  const bps = Math.min(
    Math.floor(requested),
    auth.maxActiveBinSlippageBps,
    HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS,
  );
  const percent = bps / 100;

  if (!Number.isFinite(binStep) || binStep <= 0) {
    throw new ExecutionLimitError(`pool bin step ${binStep} is not a positive number`);
  }

  return {
    bps,
    percent,
    // The SDK's own expression. `binStep` is in bps, so `binStep / 100` is the percent
    // of price one bin covers; do not "simplify" it to `percent * 100 / binStep`
    // without keeping the ceil, which is what makes a sub-bin tolerance still 1 bin.
    bins: Math.ceil(percent / (binStep / 100)),
    depositCeilingFactor: (100 + percent) / 100,
  };
}

/**
 * The most the program may pull for a deposit of `amount`, given that slippage.
 *
 * Mirrors the SDK's `getSlippageMaxAmount`, floor included. Used to charge the WIDENED
 * figure to the spend ceiling rather than the nominal one: a ceiling checked against a
 * number smaller than the transaction can move is not a ceiling, which is the same
 * defect this file already fixed for bin-array rent.
 */
export function maxDepositLamports(amount: number, depositCeilingFactor: number): number {
  return Math.floor(amount * depositCeilingFactor);
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

let connection: Connection | null = null;

/** Lazily created so importing this module never opens a socket. */
export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.SOLANA_RPC_URL, { commitment: "confirmed" });
  }
  return connection;
}

/** Test seam. Also lets a script point at a different endpoint without a reimport. */
export function setConnection(next: Connection | null): void {
  connection = next;
}

/* ------------------------------------------------------------------ */
/* Dynamic priority fee                                                */
/* ------------------------------------------------------------------ */

export interface PriorityFeePlan {
  microLamportsPerCu: number;
  /**
   * The compute-unit FLOOR, not the final limit. `computeBudgetInstructions` raises it
   * to whatever the SDK asked for when that is larger — see `resolveComputeUnitLimit`.
   */
  computeUnitLimit: number;
  /**
   * Priority portion only, in lamports, priced at the FLOOR. Diagnostic. A transaction
   * the SDK sized above the floor pays proportionally more than this figure.
   */
  estimatedLamports: number;
  source: "sampled" | "floor";
}

/**
 * Chooses a priority fee for attempt `attempt` (0-based).
 *
 * Escalates on each REBUILD rather than on each broadcast: rebroadcasting the same
 * signed bytes cannot change their fee, so escalating per send would be theatre. The
 * fee only moves when a new transaction is genuinely built after the previous
 * blockhash expired.
 *
 * The floor matters as much as the ceiling. Most slots report a zero prioritization
 * fee, so a p75 sample is frequently 0, and a zero-fee transaction is exactly the one
 * that hangs unconfirmed when the network is busy — which is the failure this handler
 * exists to prevent.
 */
export async function planPriorityFee(
  attempt: number,
  config: OnchainConfig = onchainConfig,
  lockedAccounts: string[] = [],
): Promise<PriorityFeePlan> {
  const sample = await getPriorityFeeEstimateSafe({
    lockedAccounts,
    computeUnits: config.computeUnitLimit,
  });

  const sampled = sample?.microLamportsPerCu ?? 0;
  const base = Math.max(sampled, config.minPriorityMicroLamports);
  const escalated = base * Math.pow(config.priorityEscalation, Math.max(attempt, 0));
  const microLamportsPerCu = Math.min(
    Math.ceil(escalated),
    config.maxPriorityMicroLamports,
  );

  return {
    microLamportsPerCu,
    computeUnitLimit: config.computeUnitLimit,
    estimatedLamports: Math.ceil((microLamportsPerCu * config.computeUnitLimit) / 1e6),
    source: sampled > config.minPriorityMicroLamports ? "sampled" : "floor",
  };
}

/**
 * Solana's per-transaction compute ceiling. A `setComputeUnitLimit` above it is
 * rejected outright, so it bounds what an SDK may ask for as much as what we may set.
 */
export const SOLANA_MAX_COMPUTE_UNITS = 1_400_000;

/**
 * The compute-unit limit an SDK-built transaction asked for, or null when it set none.
 *
 * Read by DECODING rather than by matching on programId alone: the ComputeBudget
 * program carries the unit LIMIT and the unit PRICE under the same programId, and
 * mistaking one for the other would install a fee where a unit count belongs. An
 * instruction that will not decode is treated as "no limit stated" rather than as a
 * zero — absent is not the same fact as zero, the same rule `est_gas_cost_usd` follows.
 */
export function readRequestedComputeUnits(
  instructions: readonly TransactionInstruction[],
): number | null {
  let requested: number | null = null;

  for (const ix of instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    try {
      if (ComputeBudgetInstruction.decodeInstructionType(ix) !== "SetComputeUnitLimit") continue;
      const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix);
      if (Number.isFinite(units) && units > 0) requested = Math.max(requested ?? 0, units);
    } catch {
      continue;
    }
  }

  return requested;
}

/**
 * The compute-unit limit a transaction will actually carry.
 *
 * **`ONCHAIN_COMPUTE_UNIT_LIMIT` is a FLOOR, not a ceiling.** That one-sided rule —
 * the same shape `LIVE_ROUND_TRIP_GAS_SOL` already uses — is the correction for the
 * defect that cost real money on 7 Sep 2026, and it is the reason that class of bug
 * cannot come back:
 *
 * The DLMM SDK sizes the budget PER CALL, and it is the only party that can. Most of
 * its paths SIMULATE the instructions against the cluster and add a buffer
 * (`getEstimatedComputeUnitIxWithBuffer`, falling back to the 1.4M ceiling when the
 * simulation itself fails); the chunked add-liquidity paths, whose transactions depend
 * on each other and so cannot be simulated ahead of time, carry a measured constant
 * instead (`DEFAULT_ADD_LIQUIDITY_CU` = 1,000,000; `DEFAULT_INIT_BIN_ARRAY_CU` =
 * 350,000 for each bin array). `asVersionedTransaction` used to DROP all of that and
 * install a flat 400,000, so any operation the SDK had sized above our constant died
 * on the compute meter — which is exactly what happened: two `InitializeBinArray`
 * instructions (~192k each as executed) blew a 399,700 CU budget AFTER the balancing
 * swap had spent, leaving a funded-but-empty position account holding 0.2657 SOL.
 *
 * Taking the MAXIMUM of the two is what makes this safe in both directions. Our floor
 * still applies where the SDK asked for less (so a transaction is never starved by a
 * tight third-party estimate), and the SDK's larger figure always wins (so a bigger
 * operation is never truncated by our constant). Over-requesting is not free — the
 * priority fee is price x REQUESTED units — but at the configured price band that
 * costs fractions of a cent, against a failure mode that has twice cost tenths of a
 * SOL. Never invert this into a `Math.min`.
 *
 * The same reasoning covers the paths that have never run: `removeLiquidity` and
 * `claimSwapFee` are simulation-sized by the SDK too, and a CLOSE that will not fit
 * its budget is strictly worse than an open that will not — the capital is already
 * committed and the stop-loss is what stops being enforceable.
 */
export function resolveComputeUnitLimit(
  sdkRequestedUnits: number | null,
  floorUnits: number,
): { units: number; source: "sdk" | "floor" } {
  const floor = Math.max(
    1,
    Math.min(Math.floor(Number.isFinite(floorUnits) ? floorUnits : 0), SOLANA_MAX_COMPUTE_UNITS),
  );

  const asked =
    sdkRequestedUnits !== null && Number.isFinite(sdkRequestedUnits) && sdkRequestedUnits > 0
      ? Math.min(Math.floor(sdkRequestedUnits), SOLANA_MAX_COMPUTE_UNITS)
      : null;

  if (asked === null || asked <= floor) return { units: floor, source: "floor" };
  return { units: asked, source: "sdk" };
}

/**
 * What one chunked funding transaction costs, mirroring the SDK's own sizing.
 *
 * These two numbers are `DEFAULT_ADD_LIQUIDITY_CU` and `DEFAULT_INIT_BIN_ARRAY_CU`
 * inside `@meteora-ag/dlmm`. Copying them breaks this file's own rule against
 * hand-writing SDK constants, and it is done deliberately because the SDK does NOT
 * export them — `onchainExecutor.test.ts` asserts that they are absent from the
 * public surface AND that these values still appear in the installed bundle, so a
 * bump that changes or exports either one fails the build instead of the wallet.
 *
 * The direction of error is also safe here in a way it is not for the bin constants:
 * a compute limit is a RESERVATION, not a charge. Over-reserving costs priority fee
 * on units that are never consumed; under-reserving kills the transaction. So these
 * are floors that `resolveComputeUnitLimit` may raise and never lower.
 *
 * WHY WE MUST SIZE THIS OURSELVES. `addLiquidityByStrategyChunkable` calls the SDK's
 * `chunkDepositWithRebalanceEndpoint` with `isParallel: true`, and the branch that
 * attaches `setComputeUnitLimit` is guarded by `if (!isParallel)`. So the chunked
 * funding transactions — the ONLY ones the wide path sends — carry no compute budget
 * at all, and `readRequestedComputeUnits` correctly returns null for them. Before
 * this existed that made `resolveComputeUnitLimit` fall back to the 400,000 floor for
 * work the SDK itself sizes at 1,000,000 plus 350,000 per bin array, which is why the
 * wide path had never completed a live open. `scripts/reproWideFunding.cjs` prints
 * this against a real pool without spending anything.
 */
/**
 * How many times the narrow open may be RE-QUOTED after a simulation refuses it.
 *
 * Small on purpose. Each attempt costs one build plus one simulation — no fee, no
 * signature — but the balancing swap has already spent by the time this runs, so the
 * clock is the enemy: every attempt widens the window in which the active bin drifts
 * out from under a deposit that was, a moment ago, acceptable. Two re-quotes is enough
 * for the one condition that actually resolves (read the balance, deposit what is
 * there); a pool that needs more is a pool this entry should not be chasing.
 */
const NARROW_OPEN_REQUOTE_ATTEMPTS = 2;

/**
 * How many times the WIDE funding sequence may be re-quoted after a simulation says a chunk
 * asks for more of the paired token than the wallet holds.
 *
 * Two, matching the narrow path. The first re-quote reads the real balance and shrinks the
 * request; the second exists for the case where the balance moved between the read and the
 * rebuild. Beyond that the numbers are not the problem and another attempt would only delay
 * the unwind.
 */
const WIDE_FUNDING_REQUOTE_ATTEMPTS = 2;

/**
 * How many times a funding chunk refused MID-FLIGHT for insufficient funds may be shrunk and
 * rebuilt. One: the second refusal is the operator's problem, and the partial-execution error
 * it raises is what pages them (through `StrandedSwapError` in the bridge).
 *
 * WHY THIS EXISTS (15 Sep 2026, LEVERCAT-SOL). The pre-send check above
 * (`firstShortFundingChunk`) simulates every chunk against the state BEFORE chunk 1 lands, and
 * it passed. Chunk 1 then needed two blockhash-expiry rebuilds; chunk 2 was refused at preflight
 * as a stale active bin and REBUILT against the moved pool — with the original paired total,
 * never re-checked against what chunk 1 had left in the wallet. The rebuilt chunk asked for
 * more LEVERCAT than remained (`RebalanceLiquidity`, custom 0x1), which was terminal. The
 * position held 14 577 of the 40 376 tokens the swap delivered, and the failed unwind that
 * followed is what cost money.
 */
export const WIDE_FUNDING_MIDFLIGHT_SHRINKS = 1;

/**
 * The smaller paired total to rebuild the REMAINING funding chunks with, after one of them was
 * refused for insufficient funds; null when no smaller figure can help. PURE.
 *
 * Chunks already landed keep what they took. Scaling the total by `f` scales what every
 * not-yet-landed chunk asks for by `f`, so `f` is chosen so the remaining plan — worst case,
 * at the program's slippage-widened pull, `x (1 + slippagePercent/100)` — fits what the wallet
 * holds NOW:
 *
 *   consumed  = balanceAtStart - balanceNow        (what the landed chunks actually took)
 *   remaining = planned - consumed
 *   f         = min( balanceNow / (remaining x (1 + s)),  1 / (1 + s) )
 *
 * The second term always shrinks by at least the slippage margin: the chunk WAS refused, so
 * "the arithmetic says it fits" is not evidence it will. Only ever DOWN; an unreadable balance
 * is null (never 0, which would deposit nothing and call it funding).
 */
export function shrinkWideFundingDeposit(input: {
  planned: bigint;
  balanceAtStart: bigint | null;
  balanceNow: bigint | null;
  slippagePercent: number;
}): bigint | null {
  const { planned, balanceAtStart, balanceNow } = input;
  if (balanceNow === null || balanceNow <= 0n || planned <= 0n) return null;
  const s = Number.isFinite(input.slippagePercent) && input.slippagePercent > 0 ? input.slippagePercent : 0;
  const consumed = balanceAtStart !== null && balanceAtStart > balanceNow ? balanceAtStart - balanceNow : 0n;
  const remaining = planned - consumed;
  if (remaining <= 0n) return null;
  const SCALE = 1_000_000n;
  const margin = BigInt(Math.round((1 + s / 100) * 1_000_000)); // (1 + s) in millionths
  const byBalance = (balanceNow * SCALE * SCALE) / (remaining * margin);
  const byMargin = (SCALE * SCALE) / margin;
  const f = byBalance < byMargin ? byBalance : byMargin;
  const next = (planned * f) / SCALE;
  return next > 0n && next < planned ? next : null;
}

export const DLMM_FUNDING_CU_PER_CHUNK = 1_000_000;
export const DLMM_FUNDING_CU_PER_BIN_ARRAY_INIT = 350_000;

/**
 * The compute budget one chunked funding transaction needs, given how many
 * `InitializeBinArray` instructions survived `partitionFundingInstructions`.
 *
 * Clamped to Solana's ceiling, because a `setComputeUnitLimit` above 1,400,000 is
 * rejected outright — the transaction would fail for a reason unrelated to its work.
 */
export function fundingComputeUnits(binArrayInits: number): number {
  const inits = Number.isFinite(binArrayInits) && binArrayInits > 0 ? Math.floor(binArrayInits) : 0;
  return Math.min(
    DLMM_FUNDING_CU_PER_CHUNK + inits * DLMM_FUNDING_CU_PER_BIN_ARRAY_INIT,
    SOLANA_MAX_COMPUTE_UNITS,
  );
}

/** The shape `partitionFundingInstructions` needs back from an Anchor coder. */
export interface DecodedDlmmInstruction {
  name: string;
  data?: { index?: unknown };
}

/**
 * Splits a chunked funding transaction into the instructions we will send and the
 * redundant `InitializeBinArray` instructions we will drop.
 *
 * THE SECOND HALF OF THE 8 SEP 2026 ROOT CAUSE. With `isParallel: true` the SDK emits
 * an `initializeBinArray` for EVERY bin array the chunk covers, with no existence
 * check and no de-duplication across chunks — the non-parallel branch has both. So
 * `preCreateMissingBinArrays` running first does not remove those instructions, it
 * only guarantees that every one of them is redundant. It is not a free redundancy:
 * simulated against mainnet on 8 Sep 2026, `initializeBinArray` on an array that
 * already exists SUCCEEDS and still consumes 202,242 CU — a full-price no-op. Two of
 * them is 404,484 CU, which is why a 399,700 CU budget died before the liquidity work
 * began, and why a boundary array shared by two chunks was paid for twice.
 *
 * The hypothesis this replaced was that the SDK widens the range past
 * `[minBinId, maxBinId]` and touches arrays the probe never saw. It does not:
 * `chunkBinRange` partitions the range contiguously and `getBinArrayIndexesCoverage`
 * returns a contiguous index run, so the union of the per-chunk coverage is exactly
 * the probe's coverage. The repro harness asserts that directly and has never found
 * an array outside it.
 *
 * FAIL-SAFE IN BOTH DIRECTIONS. An instruction is dropped only when it decodes as
 * `initializeBinArray`, its decoded index derives to a bin array we verified exists,
 * AND that derived address is the one the instruction actually names. Anything we do
 * not fully recognise is KEPT and paid for, because sending one redundant init wastes
 * compute while dropping a needed one strands the funding.
 */
export function partitionFundingInstructions(
  instructions: readonly TransactionInstruction[],
  dlmmProgramId: PublicKey,
  decode: (data: Buffer) => DecodedDlmmInstruction | null,
  binArrayForIndex: (index: string) => PublicKey | null,
  existingBinArrays: ReadonlySet<string>,
): { kept: TransactionInstruction[]; dropped: string[]; keptBinArrayInits: number } {
  const kept: TransactionInstruction[] = [];
  const dropped: string[] = [];
  let keptBinArrayInits = 0;

  for (const ix of instructions) {
    if (!ix.programId.equals(dlmmProgramId)) {
      kept.push(ix);
      continue;
    }

    let decoded: DecodedDlmmInstruction | null = null;
    try {
      decoded = decode(ix.data);
    } catch {
      decoded = null;
    }

    if (decoded?.name !== "initializeBinArray") {
      kept.push(ix);
      continue;
    }

    const rawIndex = decoded.data?.index;
    const index = rawIndex === undefined || rawIndex === null ? null : String(rawIndex);
    const derived = index === null ? null : binArrayForIndex(index);

    /*
     * The IDL orders `initialize_bin_array` as (lb_pair, bin_array, funder,
     * system_program). Rather than trust that slot, the derived address is checked
     * against the one the instruction names: if a future IDL reorders them the two
     * disagree, and disagreement keeps the instruction.
     */
    const named = ix.keys[1]?.pubkey ?? null;
    const recognised = derived !== null && named !== null && derived.equals(named);

    if (recognised && existingBinArrays.has(derived.toBase58())) {
      dropped.push(index as string);
      continue;
    }

    keptBinArrayInits += 1;
    kept.push(ix);
  }

  return { kept, dropped, keptBinArrayInits };
}

/**
 * The two compute-budget instructions every transaction this module builds carries.
 *
 * `sdkRequestedUnits` is what the SDK asked for in the transaction being rebuilt, or
 * null for one we assembled ourselves. See `resolveComputeUnitLimit` for why it wins
 * whenever it is larger.
 */
export function computeBudgetInstructions(
  plan: PriorityFeePlan,
  sdkRequestedUnits: number | null = null,
): TransactionInstruction[] {
  const { units } = resolveComputeUnitLimit(sdkRequestedUnits, plan.computeUnitLimit);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: plan.microLamportsPerCu }),
  ];
}

/* ------------------------------------------------------------------ */
/* Send & confirm                                                      */
/* ------------------------------------------------------------------ */

export interface SendResult {
  signature: string;
  slot: number | null;
  buildAttempts: number;
  priorityMicroLamports: number;
}

export class TransactionFailedError extends Error {
  readonly signature: string | null;
  /**
   * True when the transaction is KNOWN not to have landed — a preflight rejection, or
   * an on-chain execution error the cluster reported back.
   *
   * The distinction is operational, not cosmetic. `false` means the outcome is
   * genuinely unknown and the operator must check the signature on-chain before
   * retrying, because a retry on top of an in-flight transaction is how the same trade
   * executes twice. Reporting a deterministic preflight rejection as "unknown" sends
   * the operator to look for a transaction that provably never existed, and the whole
   * point of the ambiguity warning is that it should mean something when it appears.
   */
  readonly deterministic: boolean;
  /** Simulation logs when the cluster supplied them. The CU meter message lives here. */
  readonly logs: string[] | null;

  constructor(
    message: string,
    signature: string | null,
    options: { deterministic?: boolean; logs?: string[] | null } = {},
  ) {
    super(`[onchain] ${message}`);
    this.name = "TransactionFailedError";
    this.signature = signature;
    this.deterministic = options.deterministic ?? false;
    this.logs = options.logs ?? null;
  }
}

/**
 * Whether an error is the RPC refusing a transaction at PREFLIGHT.
 *
 * Preflight runs the transaction in simulation before broadcasting it, so a rejection
 * there is proof it never entered the network: nothing is in flight, nothing can land
 * later, and rebuilding is safe. That is the opposite of the ambiguous failure
 * `sendAndConfirm` is otherwise careful about, and it deserves the opposite report.
 */
function preflightRejection(err: unknown): { logs: string[] | null } | null {
  if (err instanceof SendTransactionError) {
    // `logs` is the public getter; `transactionLogs` behind it is private.
    return { logs: Array.isArray(err.logs) ? err.logs : null };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/simulation failed|preflight/i.test(message)) return { logs: null };
  return null;
}

/**
 * Whether a rejection is the program refusing a STALE ACTIVE BIN, rather than refusing
 * the work itself.
 *
 * `ExceededBinSlippageTolerance` (Anchor 6004, `0x1774`) means the pool's active bin
 * moved further than the tolerance baked into the instruction between the moment it was
 * BUILT and the moment it was simulated. That is a statement about elapsed time, not
 * about the transaction: the identical instructions rebuilt against current state may
 * well be accepted, which is exactly what makes it worth rebuilding for and what
 * separates it from every other deterministic rejection.
 *
 * Matched on the Anchor NAME first and the raw code second, because the cluster logs
 * carry the name and the outer error message usually carries only `custom program
 * error: 0x1774`. Both appear in the 9 Sep 2026 OTC-SOL incident.
 */
export function isStaleActiveBinRejection(
  logs: readonly string[] | null,
  message: string,
): boolean {
  const haystack = [message, ...(logs ?? [])].join(" | ");
  return /ExceededBinSlippageTolerance|custom program error: 0x1774|Error Number: 6004/i.test(
    haystack,
  );
}

/**
 * Whether a rejection says the SWAP QUOTE went stale rather than that the swap is wrong.
 *
 * `SlippageToleranceExceeded` is Jupiter's custom code 6001 (`0x1771`): the pool moved further
 * than the slippage bound hard-coded into the quote between the moment the quote was fetched
 * and the moment the transaction was simulated. Like a stale active bin it is a statement
 * about ELAPSED TIME, not about the transaction — and it is the one refusal this engine cannot
 * fix by rebuilding from the same quote, because the quote is the stale part. A fresh quote
 * prices the moved pool and lands.
 *
 * 12 Sep 2026, EMBER-SOL: the balancing swap was rebuilt EIGHT times against a single quote
 * (`buildJupiterSwap(auth, quote, …)` reuses it) and every attempt was refused for the same
 * 0.5% of drift, so the entry aborted. Nothing was spent — a preflight rejection never reaches
 * the network — but the engine could not enter any token that was actively moving, which is
 * precisely when a DLMM fee opportunity is doing something.
 *
 * Safe to retry in both of its shapes:
 *  - a preflight rejection means nothing entered the network;
 *  - a transaction that LANDED and reverted moved no tokens, so nothing was swapped.
 * Matched on the name first and the raw code second, like its two siblings.
 */
export function isSlippageRejection(
  logs: readonly string[] | null,
  message: string,
): boolean {
  const haystack = [message, ...(logs ?? [])].join(" | ");
  // The negative lookahead keeps `0x1771` from matching inside a longer hex code, exactly as
  // the insufficient-funds matcher keeps `0x1` away from `0x1774`.
  return /SlippageToleranceExceeded|custom program error: 0x1771(?!\w)|Error Number: 6001(?!\w)/i.test(
    haystack,
  );
}

/**
 * Whether a rejection says an ACCOUNT WAS SHORT rather than that the work was wrong.
 *
 * The 10 Sep 2026 KNOTS-SOL open died on `TransferChecked` with the SPL token program's
 * `InsufficientFunds` (custom `0x1`): the deposit asked to move more of the paired token
 * than the wallet's account actually held. Like a stale active bin, that is a statement
 * about a QUANTITY the builder can change — re-read the balance, deposit what is really
 * there — and unlike a stale active bin it does not go away on its own, so a rebuild
 * that does not re-quote is pointless.
 *
 * Deliberately narrow around `0x1`: the token program's InsufficientFunds is code 1, but
 * so is the first custom error of every other program, and `0x1774` (the active-bin one)
 * starts with the same characters. The negative lookahead is what keeps the two apart —
 * without it this function would claim the active-bin rejection as its own and re-quote a
 * deposit that was never short.
 *
 * A false positive costs one extra rebuild attempt that then finds nothing to re-quote
 * and refuses; a false negative sends a transaction already known to fail. Both are
 * bounded, which is why matching on text is acceptable here at all.
 */
export function isInsufficientFundsRejection(
  logs: readonly string[] | null,
  message: string,
): boolean {
  const haystack = [message, ...(logs ?? [])].join(" | ").toLowerCase();
  return (
    /insufficient funds|insufficient lamports|attempt to debit an account/.test(haystack) ||
    /custom program error: 0x1(?![0-9a-f])/.test(haystack) ||
    // A SIMULATION reports the error as structured JSON rather than a log line, and a
    // simulation is where this is read from. `{"InstructionError":[4,{"Custom":1}]}`
    // lowercases to this; 6004 cannot collide with it.
    /"custom":1[,}\]]/.test(haystack)
  );
}

/** Builds a signed transaction for one attempt. Receives the blockhash to embed. */
export type TransactionBuilder = (input: {
  blockhash: BlockhashWithExpiryBlockHeight;
  plan: PriorityFeePlan;
  attempt: number;
}) => Promise<VersionedTransaction>;

/**
 * Signs, submits and confirms a transaction, escalating the priority fee across
 * rebuilds.
 *
 * The retry rule is the part that matters for correctness, and it is the opposite of
 * the obvious one. A transaction that has not confirmed may still be in flight, so a
 * naive "retry with a fresh blockhash" can land BOTH — two positions opened, or a swap
 * executed twice. Instead:
 *
 *  - The same signed bytes are REBROADCAST unchanged while the blockhash is alive.
 *    Identical bytes means an identical signature, so redelivery is idempotent: the
 *    cluster accepts it at most once no matter how many copies arrive.
 *  - Only once the blockhash is definitively expired — the cluster's block height has
 *    passed `lastValidBlockHeight`, which makes that signature permanently
 *    unlandable — is a NEW transaction built, with a higher fee.
 *
 * That ordering is what makes the escalation safe. Reversing it trades a hung
 * transaction for a double spend.
 */
export async function sendAndConfirm(
  auth: ExecutionAuthorization,
  build: TransactionBuilder,
  options: {
    config?: OnchainConfig;
    lockedAccounts?: string[];
    label?: string;
    onAttempt?: (info: { attempt: number; signature: string; plan: PriorityFeePlan }) => void;
    /**
     * Whether a PREFLIGHT rejection should be rebuilt rather than reported as terminal.
     *
     * Preflight rejections are otherwise terminal here, and the reasoning is sound:
     * the RPC simulated the transaction and refused it, so identical instructions would
     * be refused identically. The exception is a rejection caused by state that has
     * MOVED — the builder can produce different instructions, so "identical" no longer
     * holds. Only a caller that actually rebuilds from fresh state may pass this;
     * supplying it for a builder that returns the same bytes just burns the attempts.
     *
     * It is safe for the same reason the terminal report is honest: preflight means
     * nothing entered the network, so there is nothing in flight to double-spend
     * against. That is a stronger guarantee than the blockhash-expiry path has.
     */
    rebuildableRejection?: (logs: string[] | null, message: string) => boolean;
  } = {},
): Promise<SendResult> {
  const config = options.config ?? onchainConfig;
  const label = options.label ?? "transaction";
  const conn = getConnection();

  // Referenced so the authorization is a genuine precondition rather than decoration:
  // callers cannot reach this function without having passed the guardlock.
  if (!auth.wallet) throw new ExecutionNotArmedError("authorization carries no wallet");

  let lastError: unknown = null;

  for (let attempt = 0; attempt < config.maxBuildAttempts; attempt++) {
    const plan = await planPriorityFee(attempt, config, options.lockedAccounts ?? []);
    const blockhash = await conn.getLatestBlockhash("confirmed");
    const tx = await build({ blockhash, plan, attempt });

    const signatureBytes = tx.signatures[0];
    if (!signatureBytes) {
      throw new TransactionFailedError(`${label}: builder returned an unsigned transaction`, null);
    }
    const signature = bs58.encode(signatureBytes);
    options.onAttempt?.({ attempt, signature, plan });

    const raw = tx.serialize();

    try {
      /*
       * maxRetries: 0 because this function owns rebroadcasting. Letting the RPC
       * client also retry would make the in-flight window opaque, and the whole
       * safety argument above depends on knowing exactly which bytes are live.
       */
      await conn.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });

      const confirmation = await conn.confirmTransaction(
        {
          signature,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        },
        "confirmed",
      );

      if (confirmation.value.err) {
        // The cluster executed it and it failed. Retrying identical instructions would
        // fail identically, so this is terminal rather than another attempt. The
        // outcome is KNOWN: it landed and reverted, so there is nothing in flight.
        throw new TransactionFailedError(
          `${label}: transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
          signature,
          { deterministic: true },
        );
      }

      return {
        signature,
        slot: confirmation.context?.slot ?? null,
        buildAttempts: attempt + 1,
        priorityMicroLamports: plan.microLamportsPerCu,
      };
    } catch (err) {
      if (err instanceof TransactionFailedError) throw err;

      /*
       * Blockhash expiry is the ONLY error that justifies rebuilding. It is also the
       * only one that makes rebuilding safe, because an expired blockhash means the
       * previous signature can never land. Anything else — an RPC hiccup, a timeout of
       * unknown cause — leaves the transaction possibly in flight, and rebuilding on
       * top of it is how the same trade gets executed twice.
       */
      const expired =
        err instanceof TransactionExpiredBlockheightExceededError ||
        /block height exceeded|blockhash not found/i.test((err as Error).message ?? "");

      if (!expired) {
        /*
         * A PREFLIGHT rejection is the one non-expiry failure whose outcome is not in
         * doubt: the RPC simulated the transaction and refused to broadcast it, so it
         * never entered the network. Reporting it as "outcome unknown — check the
         * signature" was actively misleading, and it hid the diagnosis: the cluster's
         * simulation logs name the reason, and for the 7 Sep 2026 failure they said the
         * compute meter had been exhausted. Terminal, because the same instructions
         * would be refused identically.
         */
        const preflight = preflightRejection(err);
        if (preflight) {
          const message = (err as Error).message ?? "";

          if (
            options.rebuildableRejection?.(preflight.logs, message) === true &&
            attempt + 1 < config.maxBuildAttempts
          ) {
            /*
             * Rebuild rather than give up. Nothing entered the network, so this is the
             * safest possible place in this function to build a different transaction
             * — safer than the expiry path, which relies on the old blockhash being
             * dead rather than on the old bytes never having been broadcast.
             */
            lastError = err;
            console.warn(
              `[onchain] ${label}: rejected at preflight by state that has since moved ` +
                `(attempt ${attempt + 1}/${config.maxBuildAttempts}); nothing was ` +
                `broadcast, rebuilding against current state`,
            );
            continue;
          }

          throw new TransactionFailedError(
            `${label}: rejected at preflight, so it never reached the network and ` +
              `nothing is in flight: ${(err as Error).message}` +
              (preflight.logs?.length
                ? `\n  cluster logs:\n    ${preflight.logs.slice(-12).join("\n    ")}`
                : ""),
            signature,
            { deterministic: true, logs: preflight.logs },
          );
        }

        const status = await conn.getSignatureStatus(signature).catch(() => null);
        if (status?.value && !status.value.err) {
          // It landed while the confirmation call was failing. Reporting this as an
          // error would invite the caller to retry a trade that already happened.
          return {
            signature,
            slot: status.context?.slot ?? null,
            buildAttempts: attempt + 1,
            priorityMicroLamports: plan.microLamportsPerCu,
          };
        }
        throw new TransactionFailedError(
          `${label}: submission failed and the outcome is unknown — ` +
            `check signature ${signature} before retrying: ${(err as Error).message}`,
          signature,
        );
      }

      lastError = err;
      console.warn(
        `[onchain] ${label}: blockhash expired on attempt ${attempt + 1}/${config.maxBuildAttempts} ` +
          `(sig ${signature} can no longer land); rebuilding with a higher priority fee`,
      );
    }
  }

  throw new TransactionFailedError(
    `${label}: gave up after ${config.maxBuildAttempts} builds; last error: ` +
      `${(lastError as Error | null)?.message ?? "unknown"}`,
    null,
  );
}

/** Signs a transaction the caller assembled. Kept narrow: it only ever adds a signature. */
export function signTransaction(tx: VersionedTransaction): VersionedTransaction {
  tx.sign([loadWallet()]);
  return tx;
}

/* ------------------------------------------------------------------ */
/* Jupiter swap adapter (STAGE 1 — implemented)                        */
/* ------------------------------------------------------------------ */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Minimum out after slippage. This is the number that actually protects the trade. */
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

/**
 * Fetches a swap quote. Read-only, costs nothing, and takes no authorization.
 *
 * `slippageBps` is passed to Jupiter so that the MINIMUM-OUT is enforced by the swap
 * program on-chain, not merely checked here. A client-side check would be advisory:
 * the transaction would still execute at whatever rate it got.
 */
export async function getJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  config?: OnchainConfig;
}): Promise<JupiterQuote> {
  const config = params.config ?? onchainConfig;
  const url =
    `${config.jupiterSwapApiUrl}/quote` +
    `?inputMint=${encodeURIComponent(params.inputMint)}` +
    `&outputMint=${encodeURIComponent(params.outputMint)}` +
    `&amount=${Math.floor(params.amountLamports)}` +
    `&slippageBps=${Math.floor(params.slippageBps)}`;

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`[onchain] Jupiter quote failed: HTTP ${res.status} ${await res.text()}`);
  }

  const quote = (await res.json()) as JupiterQuote;
  if (!quote?.outAmount || !quote?.otherAmountThreshold) {
    throw new Error("[onchain] Jupiter quote response is missing outAmount/otherAmountThreshold");
  }
  return quote;
}

/**
 * Turns a quote into a signed, ready-to-send transaction.
 *
 * The quote is re-validated against the authorization before signing. Jupiter is asked
 * for a slippage bound, but the answer is not taken on trust: a quote echoing a wider
 * bound than we authorized is refused rather than signed. Trusting the echo would make
 * the 0.5% cap depend on a third party's response body.
 */
export async function buildJupiterSwap(
  auth: ExecutionAuthorization,
  quote: JupiterQuote,
  plan: PriorityFeePlan,
  config: OnchainConfig,
  /*
   * REQUIRED, and deliberately not optional. Optional made the double-spend fix depend
   * on every caller remembering to pass it, policed only by a test that reads the
   * source. Required makes a caller that forgets a compile error.
   */
  blockhash: BlockhashWithExpiryBlockHeight,
  /*
   * The bound the quote was FETCHED with, and which leg it belongs to. REQUIRED for the same
   * reason `blockhash` is: before 15 Sep 2026 this function compared every quote with the
   * ENTRY bound, so an exit quote fetched at 300 bps was always refused. Checking against the
   * bound the quote was built with — never against a different one — is the whole fix.
   */
  bound: { leg: SwapLeg; bps: number },
): Promise<VersionedTransaction> {
  assertQuoteWithinSlippageBound(auth, quote, bound, config);

  const inAmount = Number(quote.inAmount);
  if (quote.inputMint === WSOL_MINT) {
    assertWithinSpendLimit(auth, inAmount, "jupiter swap");
  }

  const res = await fetch(`${config.jupiterSwapApiUrl}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: auth.wallet.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: plan.estimatedLamports,
          priorityLevel: "high",
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`[onchain] Jupiter swap build failed: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { swapTransaction?: string };
  if (!body.swapTransaction) {
    throw new Error("[onchain] Jupiter swap response contained no transaction");
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));

  /*
   * Re-pin to the blockhash `sendAndConfirm` is tracking, BEFORE signing.
   *
   * Every other builder in this module takes its blockhash from the retry loop, and
   * CLAUDE.md states that as an invariant, "the blockhash comes from `sendAndConfirm`,
   * never from the SDK's own fetch". This path was the exception and nothing enforced
   * it: Jupiter builds the transaction server-side and stamps its OWN blockhash, which
   * is necessarily NEWER than the one the loop fetched a moment earlier.
   *
   * That inverts the safety argument the loop rests on. `confirmTransaction` is given
   * OUR blockhash and lastValidBlockHeight, so the loop declares expiry — and rebuilds
   * with a fresh quote — while Jupiter's transaction is still landable for the few
   * slots by which its blockhash is younger. Both can then land: the same swap
   * executed twice, which is precisely the double spend the rebroadcast rule exists to
   * prevent. The window is small (a slot or two of a ~60s validity) and it is on the
   * balancing swap, which runs on EVERY live entry.
   *
   * Setting `recentBlockhash` before `signTransaction` is what makes this safe rather
   * than cosmetic: the signature covers the message, so re-pinning after signing would
   * produce bytes the cluster rejects. Jupiter returns a transaction only the user
   * signs, so there is no earlier signature to invalidate.
   */
  tx.message.recentBlockhash = blockhash.blockhash;

  return signTransaction(tx);
}

/**
 * Quote, build, sign, send and confirm a swap. The Stage 1 end-to-end path.
 *
 * Note the quote is fetched ONCE and reused across rebuilds. Re-quoting on each
 * attempt would silently move the minimum-out the operator approved, so a retry could
 * settle on worse terms than the one they agreed to.
 */
export async function executeJupiterSwap(
  auth: ExecutionAuthorization,
  params: {
    inputMint: string;
    outputMint: string;
    amountLamports: number;
    slippageBps?: number;
    /**
     * Which side of the trade this swap is. Defaults to `"entry"`.
     *
     * `"exit"` resolves the bound from `EXIT_MAX_SLIPPAGE_BPS` (see
     * `HARD_MAX_EXIT_SLIPPAGE_BPS`) instead of the 50 bps entry bound. Set it for the
     * residual sale after a close and for the auto-unwind after a failed open: both put
     * capital BACK into SOL, and a refusal there strands tokens in a moving market.
     */
    leg?: "entry" | "exit";
    config?: OnchainConfig;
    onAttempt?: (info: { attempt: number; signature: string; plan: PriorityFeePlan }) => void;
  },
): Promise<{ result: SendResult; quote: JupiterQuote }> {
  const config = params.config ?? onchainConfig;
  const leg: SwapLeg = params.leg ?? "entry";
  // The SAME value quotes the swap and bounds the quote in `buildJupiterSwap`.
  const slippageBps = swapSlippageBoundBps(auth, leg, params.slippageBps, config);

  if (params.inputMint === WSOL_MINT) {
    assertWithinSpendLimit(auth, params.amountLamports, "jupiter swap");
  }

  const quote = await getJupiterQuote({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amountLamports: params.amountLamports,
    slippageBps,
    config,
  });

  const result = await sendAndConfirm(
    auth,
    async ({ blockhash, plan }) =>
      buildJupiterSwap(auth, quote, plan, config, blockhash, { leg, bps: slippageBps }),
    {
      config,
      label: "jupiter swap",
      ...(params.onAttempt ? { onAttempt: params.onAttempt } : {}),
    },
  );

  return { result, quote };
}

/* ------------------------------------------------------------------ */
/* Token account housekeeping                                          */
/* ------------------------------------------------------------------ */

export type CloseTokenAccountOutcome =
  /** The empty account was closed and its rent returned to the wallet. */
  | { state: "closed"; signature: string; ata: string }
  /** No such account — already closed, or never created. A success, not an error. */
  | { state: "absent"; ata: string }
  /** The account still holds tokens, so it was NOT touched. */
  | { state: "not-empty"; ata: string; amount: string }
  /**
   * Token-2022 only: the balance is zero but the account still carries WITHHELD TRANSFER FEES,
   * and the token program refuses to close it ("An account can only be closed if its withheld
   * fee balance is zero"). Its ~0.002 SOL of rent stays parked. NOT a failure of the sale that
   * emptied it — 15 Sep 2026 LEVERCAT-SOL is the worked example — so it is reported as its own
   * outcome instead of a throw a retry loop would read as "the recovery failed".
   */
  | { state: "withheld-fee"; ata: string; detail: string };

/** Whether a close refusal is the Token-2022 withheld-fee rule rather than a real failure. */
export function isWithheldFeeCloseRefusal(message: string, logs: readonly string[] | null = null): boolean {
  return /withheld fee balance|withheld transfer fee|AccountHasWithheldTransferFees/i.test(
    [message, ...(logs ?? [])].join(" | "),
  );
}

/**
 * Closes the wallet's EMPTY associated token account for `mint` and returns its rent.
 *
 * An ATA is rent-exempt (~0.00204 SOL on SPL Token, similar on Token-2022), and every mint
 * the engine trades leaves one behind once the residual is sold: on 11 Sep 2026 the live
 * wallet held two empty ones with their rent locked for good. Against a ~$9 take-profit that
 * is ~2% of the trade, per mint, forever.
 *
 * Narrow on purpose:
 *  - it refuses an account that still holds ANY tokens (`not-empty`) — closing is only
 *    legal on a zero balance, and value in the account is the operator's to decide about;
 *  - it refuses wSOL, whose account the swap path wraps and unwraps itself;
 *  - an account that is not there is `absent`, a success, so a second call sends nothing;
 *  - the token program is the CALLER's, from the pool the SDK read — Token-2022 accounts
 *    are closed by Token-2022, and a hand-written `Tokenkeg…` would fail on those.
 *
 * It moves only rent, back to the signer, so there is no spend to charge to the ceiling.
 */
export async function closeEmptyTokenAccount(
  auth: ExecutionAuthorization,
  params: { mint: string; tokenProgram: string },
): Promise<CloseTokenAccountOutcome> {
  if (params.mint === WSOL_MINT) {
    throw new ExecutionLimitError("closeEmptyTokenAccount refuses wSOL; the swap path owns it");
  }
  const { getAssociatedTokenAddressSync, createCloseAccountInstruction } = await import(
    "@solana/spl-token"
  );
  const tokenProgram = new PublicKey(params.tokenProgram);
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(params.mint),
    auth.wallet,
    true,
    tokenProgram,
  );
  const ataAddress = ata.toBase58();
  const connection = getConnection();

  if ((await connection.getAccountInfo(ata, "confirmed")) === null) {
    return { state: "absent", ata: ataAddress };
  }

  const balance = await connection.getTokenAccountBalance(ata, "confirmed");
  if (balance.value.amount !== "0") {
    return { state: "not-empty", ata: ataAddress, amount: balance.value.amount };
  }

  // Token-2022 withheld fees: asked before sending, so a close the program must refuse costs
  // nothing. A read that fails falls through to the send, whose refusal is recognised below.
  const withheld = await withheldTransferFeeOf(connection, ata);
  if (withheld !== null && withheld !== "0") {
    return {
      state: "withheld-fee",
      ata: ataAddress,
      detail: `${withheld} base units of transfer fee are withheld in the account; the token program refuses to close it`,
    };
  }

  const closeIx = createCloseAccountInstruction(ata, auth.wallet, auth.wallet, [], tokenProgram);

  try {
    const sent = await sendAndConfirm(
      auth,
      async ({ blockhash, plan }) =>
        asVersionedTransaction(new Transaction().add(closeIx), blockhash, plan, auth.wallet, []),
      { label: `close empty token account ${ataAddress}` },
    );
    return { state: "closed", signature: sent.signature, ata: ataAddress };
  } catch (err) {
    // Closed underneath us (or by an earlier, ambiguous attempt that did land): the goal
    // — no account, rent back — is met either way.
    const still = await connection.getAccountInfo(ata, "confirmed").catch(() => undefined);
    if (still === null) return { state: "absent", ata: ataAddress };
    const message = err instanceof Error ? err.message : String(err);
    const logs = err instanceof TransactionFailedError ? err.logs : null;
    if (isWithheldFeeCloseRefusal(message, logs)) {
      return { state: "withheld-fee", ata: ataAddress, detail: message.slice(0, 300) };
    }
    throw err;
  }
}

/**
 * The withheld transfer fee a Token-2022 account carries, as a base-unit string; "0" when the
 * account has no such extension (every SPL Token account); null when it could not be read.
 */
async function withheldTransferFeeOf(connection: Connection, ata: PublicKey): Promise<string | null> {
  try {
    const info = await connection.getParsedAccountInfo(ata, "confirmed");
    const parsed = (info.value?.data as { parsed?: { info?: { extensions?: Array<{ extension?: string; state?: { withheldAmount?: number | string } }> } } } | undefined)
      ?.parsed;
    const ext = parsed?.info?.extensions?.find((e) => e.extension === "transferFeeAmount");
    return ext?.state?.withheldAmount === undefined ? "0" : String(ext.state.withheldAmount);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Meteora DLMM adapter (STAGE 2 — implemented, still unreachable)     */
/* ------------------------------------------------------------------ */

/**
 * Retained for callers and tests that still reference it. Nothing in this module
 * throws it any more — the three DLMM operations are implemented against the real
 * `@meteora-ag/dlmm` types below.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`[onchain] ${what} is not implemented.`);
    this.name = "NotImplementedError";
  }
}

/** Raised when the chain's answer contradicts what the caller asked for. */
export class DlmmExecutionError extends Error {
  constructor(message: string) {
    super(`[onchain/dlmm] ${message}`);
    this.name = "DlmmExecutionError";
  }
}

export interface OpenPositionParams {
  poolAddress: string;
  /**
   * SOL to deposit, in lamports. Charged against the authorization's per-transaction
   * ceiling, and routed to whichever side of the pair is wSOL.
   */
  amountLamports: number;
  /**
   * Base units of the OTHER token to deposit. Defaults to 0.
   *
   * A DLMM range that brackets the active bin needs BOTH tokens to be two-sided: the
   * SDK fills bins above the active one from token X and bins below it from token Y.
   * Funding one side only is legal and lands a real, one-sided position — it is simply
   * not the balanced LP the paper model simulates. This adapter does not silently swap
   * to balance the deposit; acquiring the paired token is the caller's decision, and
   * `executeJupiterSwap` is the path for it.
   */
  pairedTokenAmount?: number;
  /** Human prices (quote per base), the same quantity `DlmmPool.currentPrice` carries. */
  lowerBinPrice: number;
  upperBinPrice: number;
  strategy: "SPOT" | "BID_ASK" | "CURVE";
  slippageBps?: number;
}

export interface ClaimFeesParams {
  poolAddress: string;
  positionAddress: string;
}

export interface ClosePositionParams {
  poolAddress: string;
  positionAddress: string;
  slippageBps?: number;
}

export interface EnsureBinArraysParams {
  poolAddress: string;
  lowerBinPrice: number;
  upperBinPrice: number;
}

export interface CloseOrphanPositionParams {
  poolAddress: string;
  /**
   * The position account to recover, as an ADDRESS the caller already holds — normally
   * `DlmmPartialExecutionError.position` from an open that half-landed.
   */
  positionAddress: string;
}

/**
 * What the recovery found, and what it did about it. Three states, because they call
 * for three different sentences in an operator alert.
 *
 * `absent` — no account at that address. Nothing was created, or something already
 *   closed it. Nothing to do and nothing at risk.
 * `empty` — the account exists and holds neither liquidity nor unclaimed fees. Its RENT
 *   is recoverable, but nothing that trades is at risk, and the wide open's own catch
 *   already attempts that close; this path does not duplicate it.
 * `closed` — it held value, and this call withdrew, claimed and closed it. The amounts
 *   below are what it held when it was read, so the alert can say how much came back.
 */
export interface OrphanPositionOutcome {
  state: "absent" | "empty" | "closed";
  /** Base units held when the account was read. Strings: they can exceed 2^53. */
  liquidityX: string;
  liquidityY: string;
  unclaimedFeeX: string;
  unclaimedFeeY: string;
  /** Signatures of the close, in submission order. Empty unless `state` is "closed". */
  signatures: string[];
}

export interface EnsureBinArraysResult {
  /** Bin arrays this call created on-chain, one transaction each. */
  created: number;
  /** Bin arrays the range needs that already existed. */
  existed: number;
}

/**
 * What a DLMM operation actually did.
 *
 * `SendResult` alone could not express either half of this, which is why the interface
 * changed when Stage 2 landed rather than before:
 *
 *  - `openPosition` mints a NEW position account (a fresh Keypair the transaction also
 *    signs). Without returning its address the caller could never claim or close what
 *    it opened, so the old single-`SendResult` shape was unusable even implemented.
 *  - `claimSwapFee` and `removeLiquidity` return `Transaction[]`, not one transaction:
 *    a position spanning many bins does not fit in one. Collapsing that to a single
 *    signature would report a partial claim as a complete one.
 */
export interface DlmmSendResult {
  /** Every transaction that confirmed, in submission order. */
  sent: SendResult[];
  /** The position account this operation opened or acted on. */
  position: string;
}

/**
 * What an OPEN did, which is a strict superset of the above.
 *
 * The extra field exists because the narrow path may deposit LESS paired token than it
 * was asked for: the pre-send simulation can find the wallet short, and the remedy is to
 * re-quote the deposit down to what the account really holds. The caller used to report
 * its own pre-open balance read as "deposited", which was true only while nothing could
 * change the figure in between. Reporting a number the chain did not act on is the
 * defect class this repository has fixed four times already; the executor is the only
 * party that knows what it actually asked for, so it says.
 */
export interface DlmmOpenResult extends DlmmSendResult {
  /** Paired-token base units the deposit actually carried. */
  depositedPairedAmount: string;
}

/**
 * Raised when a multi-transaction operation confirmed some of its parts and then
 * failed. The state on-chain is real but incomplete, so the caller must NOT retry
 * blindly — the same rule `sendAndConfirm` applies to an ambiguous single send.
 */
export class DlmmPartialExecutionError extends Error {
  readonly landed: SendResult[];
  readonly position: string;
  constructor(operation: string, position: string, landed: SendResult[], cause: unknown) {
    super(
      `[onchain/dlmm] ${operation} on position ${position} landed ${landed.length} of its ` +
        `transactions and then failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Signatures that DID land: ${landed.map((r) => r.signature).join(", ") || "none"}. ` +
        `CHECK THE POSITION ON-CHAIN BEFORE RETRYING — re-running will repeat the parts ` +
        `that already succeeded.`,
    );
    this.name = "DlmmPartialExecutionError";
    this.landed = landed;
    this.position = position;
  }
}

/**
 * The three DLMM operations the live engine will eventually need.
 *
 * Every method takes an `ExecutionAuthorization` for the same reason the Jupiter path
 * does: "did anyone check we are allowed to spend?" is a compile error here, not a
 * code-review question.
 */
export interface DlmmExecutor {
  openPosition(auth: ExecutionAuthorization, params: OpenPositionParams): Promise<DlmmOpenResult>;
  ensureBinArrays(
    auth: ExecutionAuthorization,
    params: EnsureBinArraysParams,
  ): Promise<EnsureBinArraysResult>;
  claimFees(auth: ExecutionAuthorization, params: ClaimFeesParams): Promise<DlmmSendResult>;
  closePosition(
    auth: ExecutionAuthorization,
    params: ClosePositionParams,
  ): Promise<DlmmSendResult>;
  /**
   * Recovers a position the engine created but does not own a row for.
   *
   * Separate from `closePosition` and deliberately not a flag on it, because the two
   * answer different questions. `closePosition` closes a position the ENGINE IS
   * TRACKING and fails closed when the owner scan does not list it — the right answer
   * when a mistake would target the wrong account. This one is reached only when an
   * open half-landed and the caller already holds the address the failure named, so
   * "the scan did not list it" is precisely the condition it has to survive.
   */
  closeOrphanPosition(
    auth: ExecutionAuthorization,
    params: CloseOrphanPositionParams,
  ): Promise<OrphanPositionOutcome>;
  /**
   * What the chain holds at a position address RIGHT NOW: gone, an empty account, or one
   * still holding liquidity or fees. Read-only, by address (no owner-index lag). Throws
   * when it cannot tell — "unreadable" is the caller's to decide, never guessed here.
   */
  readPositionState(
    auth: ExecutionAuthorization,
    params: ClosePositionParams,
  ): Promise<PositionChainState>;
  /**
   * The last-resort residual sale: quote selling `amount` of the paired token for SOL
   * DIRECTLY in the position's own pool. Read-only.
   */
  quotePoolSaleToSol(params: PoolSaleParams): Promise<PoolSaleQuote>;
  /**
   * Sells in that pool with a FIXED minimum out, supplied by the caller from a quote it
   * has already judged. The floor is not re-derived on a rebuild: a retry that silently
   * lowered it would sell below what was approved.
   */
  sellToSolInPool(
    auth: ExecutionAuthorization,
    params: PoolSaleParams & { minOutLamports: string },
  ): Promise<SendResult>;
}

/** What `readPositionState` found. */
export type PositionChainState = "absent" | "empty" | "funded";

export interface PoolSaleParams {
  poolAddress: string;
  /** The paired token being sold. The pool's OTHER side must be wSOL, or it is refused. */
  mint: string;
  /** Base units, as a decimal string — it can exceed 2^53. */
  amount: string;
  /** Exit-leg bound for the quote; clamped by `resolveExitSlippageBps`. */
  slippageBps?: number;
}

export interface PoolSaleQuote {
  /** Lamports of SOL the pool quotes for the whole amount. */
  outLamports: string;
  /** `outLamports` less the slippage bound, as the SDK computes it. */
  minOutLamports: string;
  slippageBps: number;
}

/**
 * Whether a close transaction may be REBUILT after its blockhash expired, given what the
 * chain now says about the position.
 *
 * WHY (13 Sep 2026). A live close needed blockhash-expired rebuilds 1-4/8 and 1-3/8 before
 * landing. Rebuilding is safe for the SIGNATURE — an expired blockhash cannot land — but
 * not for the STATE: the previous attempt can have confirmed in the gap the confirmation
 * poll missed. Rebuilding then sends a withdraw-and-close against an account that no
 * longer exists, the program refuses it, the close is reported FAILED, the row stays
 * ACTIVE, and every later tick retries a close of a position that is already gone.
 *
 * An absent account is the one fact that settles it: this sequence's job is to close the
 * account, and it is closed. Anything else — present, or unreadable — rebuilds exactly as
 * before, because "the RPC did not answer" is not evidence the close landed, and stopping
 * on it would abandon a position that is still open.
 */
export function closeRebuildDecision(
  state: PositionChainState | "unreadable",
): "stop-already-closed" | "rebuild" {
  return state === "absent" ? "stop-already-closed" : "rebuild";
}

/** Thrown from inside a builder to end a sequence whose goal the chain already reached. */
class SequenceAlreadySettled extends Error {
  constructor() {
    super("the chain already reflects this sequence's outcome");
    this.name = "SequenceAlreadySettled";
  }
}

/*
 * The SDK is loaded on first use, not at import.
 *
 * `@meteora-ag/dlmm` drags in Anchor and spl-token. The Stage 1 Jupiter path in this
 * same module needs none of it, and `scripts/testMicroSwap.ts` would otherwise pay for
 * a DLMM runtime it never touches. A type-only import at the top keeps every signature
 * below checked against the real SDK types regardless.
 */
let dlmmSdk: Promise<typeof import("@meteora-ag/dlmm")> | null = null;

/*
 * Loads the DLMM SDK through its CJS build, not its ESM one.
 *
 * `await import("@meteora-ag/dlmm")` always rejects here: the package's ESM build
 * (`dist/index.mjs`) opens with `import { bs58 } from
 * "@coral-xyz/anchor/dist/cjs/utils/bytes"` — a directory import, which Node's ESM
 * resolver forbids (CJS tolerated it). In the engine that surfaces as
 * "Directory import ... is not supported resolving ES modules" inside
 * seekNewEntry/liveExecution, killing every live entry attempt after screening
 * passes. The CJS build (`dist/index.js`, chosen by createRequire through the
 * "require" condition of the package exports) loads cleanly and exports the same
 * surface — module.exports IS the DLMM class, with the named exports attached as
 * statics. We shape it back into an ESM-namespace-like object so the
 * `const { default: DLMM } = await loadDlmmSdk()` call sites stay unchanged.
 */
function loadDlmmSdk(): Promise<typeof import("@meteora-ag/dlmm")> {
  dlmmSdk ??= (async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const cjsModule = require("@meteora-ag/dlmm");
    return { default: cjsModule, ...cjsModule };
  })();
  return dlmmSdk;
}

const STRATEGY_TYPE: Record<OpenPositionParams["strategy"], keyof typeof StrategyType> = {
  SPOT: "Spot",
  BID_ASK: "BidAsk",
  CURVE: "Curve",
};

/**
 * Rebuilds an SDK-produced legacy `Transaction` as a signed v0 transaction carrying
 * OUR compute-budget instructions.
 *
 * Two things here are load-bearing.
 *
 * The SDK attaches its own `setComputeUnitLimit` (it sizes units per call, mostly by
 * simulating the instructions against the cluster) and never sets a unit PRICE —
 * verified: the installed build contains zero `setComputeUnitPrice` call sites.
 * Prepending ours without removing theirs would put two compute-budget instructions of
 * the same kind in one transaction, which the runtime rejects outright, so exactly one
 * of each is emitted.
 *
 * What their instruction ASKED FOR is read out before it is dropped, and
 * `resolveComputeUnitLimit` keeps whichever budget is larger. Dropping it unread —
 * which this function did until 7 Sep 2026 — replaced an estimate informed by the
 * chain with a flat constant, and every operation the SDK had sized above that
 * constant died on the compute meter. Read that function before changing anything
 * here; it is the fix for a bug that cost real money twice.
 *
 * And the blockhash comes from the caller rather than from the SDK's own fetch: the
 * rebroadcast rule depends on the bytes being pinned to the blockhash whose expiry
 * `sendAndConfirm` is tracking. A transaction carrying a blockhash the retry loop does
 * not know about could be rebuilt while the original was still landable — the double
 * spend that loop is written to prevent.
 */
function asVersionedTransaction(
  legacy: Transaction,
  blockhash: BlockhashWithExpiryBlockHeight,
  plan: PriorityFeePlan,
  payer: PublicKey,
  extraSigners: Keypair[] = [],
  requestedUnitsFloor: number | null = null,
): VersionedTransaction {
  // What the SDK sized THIS transaction at, read before its instruction is dropped.
  // Dropping the instruction without first reading it is the bug that cost 0.2657 SOL.
  const fromSdk = readRequestedComputeUnits(legacy.instructions);

  /*
   * `requestedUnitsFloor` is for the transactions the SDK sizes at NOTHING — the
   * chunked funding path, whose compute-budget branch is disabled by `isParallel`.
   * Combined with MAX rather than replacing the read value, so a future SDK bump that
   * starts attaching a larger budget is still honoured; see `fundingComputeUnits`.
   */
  const sdkRequestedUnits =
    requestedUnitsFloor === null ? fromSdk : Math.max(fromSdk ?? 0, requestedUnitsFloor);

  const withoutComputeBudget: TransactionInstruction[] = legacy.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );

  const budget = computeBudgetInstructions(plan, sdkRequestedUnits);
  const { units, source } = resolveComputeUnitLimit(sdkRequestedUnits, plan.computeUnitLimit);
  if (source === "sdk") {
    console.log(
      `[onchain] honouring the SDK's compute budget: ${units} CU requested, above the ` +
        `${plan.computeUnitLimit} CU floor (ONCHAIN_COMPUTE_UNIT_LIMIT)`,
    );
  }

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash.blockhash,
    instructions: [...budget, ...withoutComputeBudget],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  // The wallet signs last and separately: loadWallet() is module-private precisely so
  // the Keypair never escapes, and signTransaction only ever adds a signature.
  if (extraSigners.length > 0) tx.sign(extraSigners);
  return signTransaction(tx);
}

/** Loads the pool's live state. Read-only; takes no authorization. */
async function openPool(poolAddress: string): Promise<DlmmPool> {
  const { default: DLMM } = await loadDlmmSdk();
  return DLMM.create(getConnection(), new PublicKey(poolAddress));
}

/**
 * Converts the engine's human prices into the bin ids the program indexes by.
 *
 * `getBinIdFromPrice` takes a price PER LAMPORT, not the human price — it is a raw
 * logarithm over the bin-step ratio and does no decimal conversion of its own. Feeding
 * it `DlmmPool.currentPrice` directly would silently place the position in an entirely
 * unrelated bin range, off by the ratio of the two mints' decimals. `toPricePerLamport`
 * is the SDK's own conversion and is used for exactly that reason; the arithmetic is
 * never reimplemented here.
 *
 * `min: true` floors and `min: false` ceils, so the range returned always CONTAINS the
 * requested prices rather than truncating inside them.
 */
export interface BinRangeSource {
  toPricePerLamport(price: number): string;
  getBinIdFromPrice(price: number, min: boolean): number;
}

export function binRangeFromPrices(
  pool: BinRangeSource,
  lowerPrice: number,
  upperPrice: number,
): { minBinId: number; maxBinId: number } {
  if (!(lowerPrice > 0) || !(upperPrice > 0) || !(upperPrice > lowerPrice)) {
    throw new DlmmExecutionError(
      `bin range [${lowerPrice}, ${upperPrice}] is not a positive, increasing range`,
    );
  }

  const minBinId = pool.getBinIdFromPrice(Number(pool.toPricePerLamport(lowerPrice)), true);
  const maxBinId = pool.getBinIdFromPrice(Number(pool.toPricePerLamport(upperPrice)), false);

  if (!Number.isFinite(minBinId) || !Number.isFinite(maxBinId) || maxBinId < minBinId) {
    throw new DlmmExecutionError(
      `price range [${lowerPrice}, ${upperPrice}] resolved to an unusable bin range ` +
        `[${minBinId}, ${maxBinId}]`,
    );
  }
  return { minBinId, maxBinId };
}

/*
 * DLMM one-position limits.
 *
 * These mirror the SDK's own exported constants (`DEFAULT_BIN_PER_POSITION`,
 * `POSITION_MAX_LENGTH`, `POSITION_MIN_SIZE`, `POSITION_BIN_DATA_SIZE`) rather than
 * being independent guesses, and `onchainExecutor.test.ts` fails the build if they
 * ever drift from the installed SDK. They are duplicated here because the SDK loads
 * asynchronously through `loadDlmmSdk()` and a module-level constant cannot await.
 *
 * The distinction between the two bin numbers is the whole reason wide positions
 * were thought impossible:
 *
 *  - `DLMM_BINS_PER_INIT` (70) is all `initializePosition` allocates in one go. The
 *    SDK's `initializePositionAndAddLiquidityByStrategy` asks for the FULL width in
 *    that single instruction, so any width above 70 makes the program's Anchor `init`
 *    grow the account inside a CPI, and Solana caps a CPI realloc at 10240 bytes —
 *    the "Account data size realloc limited to 10240 in inner instructions" failure.
 *  - `DLMM_MAX_BINS_PER_POSITION` (1400) is what one position account can actually
 *    hold. The account is grown to it by TOP-LEVEL `increasePositionLength`
 *    instructions of at most 91 bins each (91 x 112 = 10192 bytes, just under the
 *    same 10240 cap — which is exactly why the SDK's MAX_RESIZE_LENGTH is 91).
 *
 * Verified against mainnet by simulation (sigVerify:false, nothing sent) on
 * 7 Sep 2026: widths 70/100/300/600/1200/1400 all simulate clean in ONE transaction
 * (1400 bins = 17 instructions, 772 bytes, 153k CU); width 1401 and above fail with
 * AnchorError custom 6040 (InvalidPositionWidth) thrown at
 * `increase_position_length.rs:52`. 1400 is therefore a hard program limit, not a
 * tuning knob.
 */
export const DLMM_BINS_PER_INIT = 70;
export const DLMM_MAX_BINS_PER_POSITION = 1400;
export const DLMM_POSITION_MIN_SIZE = 8112;
export const DLMM_POSITION_BIN_DATA_SIZE = 112;

/**
 * Rent-exemption for ONE bin array, in SOL. Mirrors the SDK's `BIN_ARRAY_FEE`, and
 * `onchainExecutor.test.ts` binds it to the installed build like the four above.
 *
 * This number is the engine's only UNRECOVERABLE cost. A bin array is a POOL-level
 * account shared by every LP: `close_bin_array` exists in the IDL, the SDK exposes no
 * wrapper for it, and nothing in this repository can reclaim the rent. The position
 * account's rent comes back when the position closes; this does not, ever.
 *
 * It is exported so the friction gates can PRICE it. They could not before — they
 * charged gas and slippage only, and at the 0.008 SOL round-trip gas floor a single
 * new bin array is about nine times the entire modelled cost of the trade.
 */
export const DLMM_BIN_ARRAY_RENT_SOL = 0.07143744;

/**
 * On-chain byte size of a position account spanning `binWidth` bins.
 *
 * Matches the SDK's `calculatePositionSize`. It matters to the caller because the
 * account is rent-exempt and rent scales LINEARLY with it: 70 bins costs ~0.052 SOL,
 * 1400 bins ~0.996 SOL. On a 1 SOL wallet the rent, not the program limit, is what
 * actually bounds how wide a position can be opened — see the affordability gate in
 * `liveExecution.ts`.
 */
export function positionAccountBytes(binWidth: number): number {
  if (!Number.isInteger(binWidth) || binWidth < 1) {
    throw new DlmmExecutionError(`bin width ${binWidth} is not a positive integer`);
  }
  const extra = Math.max(binWidth - DLMM_BINS_PER_INIT, 0);
  return DLMM_POSITION_MIN_SIZE + extra * DLMM_POSITION_BIN_DATA_SIZE;
}

/**
 * What opening this range will COST in SOL, before anything is spent.
 *
 * Asked of the SDK rather than computed here, because the honest figure has three
 * parts and only the chain knows two of them:
 *
 *  - the position account's rent, which scales with the width;
 *  - the `increasePositionLength` realloc cost for anything past 70 bins;
 *  - rent for bin arrays that do not exist YET. Bin arrays are shared per pool, so a
 *    liquid pool usually charges nothing here and a fresh one charges 0.0714 SOL per
 *    array. Estimating this from the width alone would be wrong in both directions.
 *
 * This is a QUOTE, not a spend, and it opens no transaction. It exists so the live
 * bridge can refuse an unaffordable range BEFORE the balancing swap, which is the
 * ordering that stops a failed open stranding a memecoin balance.
 */
export interface OpenCostQuote {
  binWidth: number;
  /**
   * The pool's bin step in bps, carried out so a caller can convert a rate of price
   * movement into BINS without opening the pool a second time. The execution-time
   * volatility gate in `liveExecution.ts` is the only consumer.
   */
  binStep: number;
  /** Position account rent + realloc + any bitmap extension. */
  positionSol: number;
  binArraysToCreate: number;
  binArraySol: number;
  totalSol: number;
  /** The SDK's own estimate of how many transactions create + fund will take. */
  transactionCount: number;
}

export async function quoteOpenCost(params: {
  poolAddress: string;
  lowerBinPrice: number;
  upperBinPrice: number;
  strategy: OpenPositionParams["strategy"];
}): Promise<OpenCostQuote> {
  const { StrategyType: Strategy } = await loadDlmmSdk();
  const pool = await openPool(params.poolAddress);
  const { minBinId, maxBinId } = binRangeFromPrices(
    pool,
    params.lowerBinPrice,
    params.upperBinPrice,
  );

  const quote = await pool.quoteCreatePosition({
    strategy: {
      minBinId,
      maxBinId,
      strategyType: Strategy[STRATEGY_TYPE[params.strategy]],
    },
  });

  const positionSol = quote.positionCost + quote.positionReallocCost + quote.bitmapExtensionCost;
  return {
    binWidth: maxBinId - minBinId + 1,
    binStep: pool.lbPair.binStep,
    positionSol,
    binArraysToCreate: quote.binArraysCount,
    binArraySol: quote.binArrayCost,
    totalSol: positionSol + quote.binArrayCost,
    transactionCount: quote.transactionCount,
  };
}

/**
 * Runs one instruction set against the cluster and reports what came back.
 *
 * THE BUDGET IS THE ONE PRODUCTION WILL CARRY, resolved through the same
 * `resolveComputeUnitLimit` the send path uses. A simulation run against a different
 * compute limit than production uses would pass exactly the transactions production then
 * fails — which is the whole point of simulating, inverted. This function exists so the
 * rehearsal and the narrow path's pre-send check cannot drift apart on that detail;
 * they used to be one copy and a plan to write the second.
 *
 * `ran: false` is the load-bearing distinction. A simulation the RPC could not RUN is
 * NOT evidence the transaction would fail, so every caller must be able to tell "the
 * cluster refused this work" from "the cluster did not answer" and fail open on the
 * second. Collapsing them would stop all trading whenever a provider hiccups.
 *
 * Read-only: it takes no `ExecutionAuthorization` because it cannot spend, and a
 * function that cannot spend should not be able to ask for permission to.
 */
interface ClusterSimulation {
  /** Whether the cluster actually simulated. False = no answer, NOT a refusal. */
  ran: boolean;
  computeUnitLimit: number;
  unitsConsumed: number | null;
  /** The program's error, JSON-stringified. Null means it simulated clean. */
  error: string | null;
  logs: string[] | null;
}

async function simulateAgainstCluster(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  recentBlockhash: string,
  config: OnchainConfig,
): Promise<ClusterSimulation> {
  const requested = readRequestedComputeUnits(instructions);
  const { units } = resolveComputeUnitLimit(requested, config.computeUnitLimit);
  const withoutBudget = instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.minPriorityMicroLamports }),
      ...withoutBudget,
    ],
  }).compileToV0Message();

  try {
    const sim = await getConnection().simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    return {
      ran: true,
      computeUnitLimit: units,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      error: sim.value.err === null ? null : JSON.stringify(sim.value.err),
      logs: sim.value.logs ?? null,
    };
  } catch (err) {
    return {
      ran: false,
      computeUnitLimit: units,
      unitsConsumed: null,
      error: null,
      logs: [`simulation could not run: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * A DRESS REHEARSAL of the account-creation phase of an open, run against the cluster
 * with `sigVerify: false` so nothing is signed, sent or spent.
 *
 * WHY THIS EXISTS. Every gate in this engine fires BEFORE the balancing swap, and both
 * failures that have cost real money landed AFTER it — in the phase that had no gate,
 * only error handling. The auto-unwind worked both times, but unwinding is damage
 * control, not prevention. This is the missing gate, and it is the only one that
 * catches a failure nobody has thought of yet: instead of naming a condition to check,
 * it asks the cluster to run the transactions and reports what it says.
 *
 * The technique is already trusted here — `scripts/simWidePosition.cjs` is exactly
 * this, and it is how the 1400-bin limit was established without spending anything.
 * This moves it onto the live path.
 *
 * WHAT IT COVERS: bin-array creation, and for a wide range the extended-position
 * create. Those need only SOL, which the wallet already holds, so they simulate
 * faithfully before the swap.
 *
 * WHAT IT CANNOT COVER, and why that is not a gap being papered over: the LIQUIDITY
 * phase deposits the paired token, and the wallet does not hold that token until the
 * swap this gate runs before has happened. Simulating it here would fail for lack of
 * funds on every pool, which is a false alarm, not a check. The liquidity phase is
 * protected differently — by `resolveComputeUnitLimit` honouring the budget the SDK
 * sized for it, and by `preCreateMissingBinArrays` keeping account creation out of it.
 *
 * Read-only and unauthorized by design: it takes a wallet ADDRESS, never an
 * `ExecutionAuthorization`, because a function that cannot spend should not be able to
 * ask for permission to.
 */
export interface OpenRehearsalStep {
  stage: string;
  computeUnitLimit: number;
  unitsConsumed: number | null;
  error: string | null;
  logs: string[] | null;
}

export interface OpenRehearsal {
  ok: boolean;
  binWidth: number;
  /**
   * Bin arrays the range needs that the chain does NOT have. A measurement, always.
   *
   * This used to be forced to 0 on the narrow path — `wide ? missing.length : 0` —
   * because only the wide path creates them in their own transaction. That conflated
   * "we will not create these separately" with "these exist", and `openLivePosition`
   * then printed the second one: "no account creation needed (all bin arrays exist)"
   * over a narrow range that was about to spend 0.0714 SOL per array, permanently,
   * inside the fused open. Bin-array rent is the one cost this engine cannot get back,
   * so the log claiming there is none is the wrong thing to be wrong about.
   *
   * `rehearsedSteps` below is what says whether anything was simulated. Keep the two
   * apart: one is a fact about the chain, the other a fact about this function.
   */
  binArraysToCreate: number;
  /**
   * Whether the narrow path's inits are FUSED into the open rather than sent alone.
   *
   * True on a narrow range, and it is why `steps` is empty there: the narrow path has
   * no standalone account-creation transaction to rehearse, and the fused one cannot
   * be simulated before the swap funds its deposit. The SDK budgets that transaction
   * by simulating it itself, which `onchainExecutor.test.ts` asserts.
   */
  fusedIntoOpen: boolean;
  steps: OpenRehearsalStep[];
  /** The first step that failed, or null when every one simulated clean. */
  failure: OpenRehearsalStep | null;
  /** Steps that landed within 10% of their compute budget. Not a failure; a warning. */
  tight: OpenRehearsalStep[];
  /**
   * Whether a failure is attributable to the POOL rather than to the wallet.
   *
   * A refusal for want of lamports says nothing about the pool: the wallet is short,
   * and every pool would refuse the same way. Counting those as pool strikes would let
   * one wallet-level fact bench the entire universe a pool at a time, 24 hours each —
   * a self-inflicted outage from a condition a top-up fixes. The open is still refused;
   * only the BOOKKEEPING is withheld. Same distinction the "simulation unavailable"
   * path already makes.
   */
  poolAttributable: boolean;
}

export async function rehearseOpenPosition(params: {
  poolAddress: string;
  lowerBinPrice: number;
  upperBinPrice: number;
  wallet: PublicKey;
  config?: OnchainConfig;
}): Promise<OpenRehearsal> {
  const config = params.config ?? onchainConfig;
  const { deriveBinArray, getBinArrayIndexesCoverage } = await loadDlmmSdk();
  const pool = await openPool(params.poolAddress);
  const { minBinId, maxBinId } = binRangeFromPrices(
    pool,
    params.lowerBinPrice,
    params.upperBinPrice,
  );
  const binWidth = maxBinId - minBinId + 1;
  const connection = getConnection();

  const planned: { stage: string; instructions: TransactionInstruction[] }[] = [];

  // --- Bin arrays the range needs and the chain does not have ---
  const candidates = [...getBinArrayIndexesCoverage(new BN(minBinId), new BN(maxBinId))].map(
    (raw) => {
      const index = new BN(raw);
      const [pubkey] = deriveBinArray(pool.pubkey, index, pool.program.programId);
      return { index, pubkey };
    },
  );

  const infos: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const slice = candidates.slice(i, i + 100).map((c) => c.pubkey);
    infos.push(...(await connection.getMultipleAccountsInfo(slice)));
  }
  const missing = candidates.filter((_, i) => infos[i] === null);

  /*
   * REHEARSE ONLY WHAT WILL ACTUALLY BE SENT.
   *
   * Standalone `initializeBinArray` transactions exist on the WIDE path alone —
   * `preCreateMissingBinArrays` is called there and nowhere else. The narrow path fuses
   * the inits into `initializePositionAndAddLiquidityByStrategy`, so simulating them
   * separately here would rehearse a transaction the engine will never build: it could
   * bench a pool for 24 hours over an artefact, and it would still be blind to the
   * fused transaction that does run. An audit caught this; the first version simulated
   * them on both paths.
   *
   * The narrow path therefore has nothing to rehearse, and `openLivePosition` says so
   * in as many words rather than logging a clean rehearsal that checked nothing.
   */
  const wide = binWidth > DLMM_BINS_PER_INIT;

  if (wide) {
    for (const [i, { index, pubkey }] of missing.entries()) {
      planned.push({
        stage: `init bin array ${i + 1}/${missing.length}`,
        instructions: [
          await pool.program.methods
            .initializeBinArray(index)
            .accountsPartial({ binArray: pubkey, funder: params.wallet, lbPair: pool.pubkey })
            .instruction(),
        ],
      });
    }
  }

  // --- The position account, for the wide path only (see the note above) ---
  if (wide) {
    // Throwaway: the rehearsal never signs, so this address is never created.
    const rehearsalPosition = Keypair.generate();
    const createTx = await pool.createExtendedEmptyPosition(
      minBinId,
      maxBinId,
      rehearsalPosition.publicKey,
      params.wallet,
    );
    planned.push({ stage: `create ${binWidth}-bin position`, instructions: createTx.instructions });
  }

  const steps: OpenRehearsalStep[] = [];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  for (const { stage, instructions } of planned) {
    /*
     * The SAME budget the real send will carry, resolved the same way — see
     * `simulateAgainstCluster`, which owns that guarantee for this path and for the
     * narrow open's pre-send check.
     */
    const sim = await simulateAgainstCluster(instructions, params.wallet, blockhash, config);

    if (!sim.ran) {
      /*
       * The RPC could not run the simulation. That is NOT evidence the open would
       * fail, so it must not be reported as a refusal — a rehearsal that fails closed
       * on its own outage would stop all trading whenever the provider hiccups, and
       * this gate protects against a specific on-chain failure, not against the RPC.
       * Same reasoning as `assessPoolCooldown` failing open. `sim.error` is null in
       * that case, which is what carries the fail-open through to `ok`.
       */
      console.warn(`[onchain/rehearsal] ${stage}: simulation unavailable; not treated as a refusal`);
    }

    steps.push({
      stage,
      computeUnitLimit: sim.computeUnitLimit,
      unitsConsumed: sim.unitsConsumed,
      error: sim.error,
      logs: sim.logs,
    });
  }

  const failure = steps.find((s) => s.error !== null) ?? null;
  const tight = steps.filter(
    (s) => s.unitsConsumed !== null && s.unitsConsumed > s.computeUnitLimit * 0.9,
  );

  return {
    ok: failure === null,
    binWidth,
    // The chain's answer, on both paths. See the field's note: forcing this to 0 on
    // the narrow path is what let the operator log claim arrays existed when they did
    // not, and bin-array rent is unrecoverable.
    binArraysToCreate: missing.length,
    fusedIntoOpen: !wide,
    steps,
    failure,
    tight,
    poolAttributable: failure === null || isPoolAttributable(failure),
  };
}

/**
 * Whether a simulation failure is the POOL's fault or the WALLET's.
 *
 * Read from the cluster's own logs and error shape rather than guessed. Insufficient
 * lamports, and an account the runtime refuses to fund, are wallet-level facts that
 * would repeat identically on every pool.
 *
 * Defaults to TRUE — an unrecognised failure is treated as the pool's — because the
 * cost of wrongly benching one pool is a missed entry, while wrongly clearing a broken
 * pool is the repeat loss this whole gate exists to stop.
 */
function isPoolAttributable(failure: OpenRehearsalStep): boolean {
  const haystack = [failure.error ?? "", ...(failure.logs ?? [])].join(" ").toLowerCase();
  const walletLevel = [
    "insufficient lamports",
    "insufficient funds",
    "account not found",
    "attempt to debit an account but found no record of a prior credit",
  ];
  return !walletLevel.some((needle) => haystack.includes(needle));
}

/** Which side of the pair is wSOL, or null when neither is. */
export function solSide(pool: {
  tokenX: { publicKey: PublicKey };
  tokenY: { publicKey: PublicKey };
}): "X" | "Y" | null {
  const wsol = new PublicKey(WSOL_MINT);
  if (pool.tokenX.publicKey.equals(wsol)) return "X";
  if (pool.tokenY.publicKey.equals(wsol)) return "Y";
  return null;
}

/** Finds the caller's position on this pool, or explains that it is not there. */
async function requirePosition(
  pool: DlmmPool,
  owner: PublicKey,
  positionAddress: string,
): Promise<LbPosition> {
  const wanted = new PublicKey(positionAddress);
  const { userPositions } = await pool.getPositionsByUserAndLbPair(owner);
  const found = userPositions.find((p: LbPosition) => p.publicKey.equals(wanted));

  if (!found) {
    /*
     * Fail rather than proceed. "The RPC did not list it" is not evidence the position
     * is gone — same fail-closed rule as the anti-rug screen — and acting on a position
     * we could not read is how an operation targets the wrong account.
     */
    throw new DlmmExecutionError(
      `position ${positionAddress} is not owned by ${owner.toBase58()} on pool ` +
        `${pool.pubkey.toBase58()}, or could not be read. Refusing to act on it.`,
    );
  }
  return found;
}

/**
 * Reads a position account by ADDRESS, and verifies it is the one we mean.
 *
 * `requirePosition` above asks `getPositionsByUserAndLbPair`, which is a
 * `getProgramAccounts` scan. That is the right lookup when the caller knows only the
 * owner, and the wrong one when the caller already knows the address: the scan is an
 * INDEX QUERY, it can lag a freshly created account (observed on the SOLCAT-SOL orphan,
 * 7 Sep 2026), and its fail-closed refusal then reads as "you do not own this position"
 * about a position the wallet demonstrably just created. On the recovery path that
 * refusal is the failure — the engine cannot close what it cannot see, and what it
 * cannot see is real capital.
 *
 * A direct `getAccountInfo` has no index to lag. What it loses is the scan's implicit
 * proof of ownership, so that is re-established explicitly, and from the SDK's OWN
 * memcmp descriptors rather than from offsets written out here: `positionLbPairFilter`
 * and `positionOwnerFilter` are exactly what `getPositionsByUserAndLbPair` filters on,
 * so this checks the same two fields at the same two offsets, and an SDK that moves the
 * layout moves both together. Hand-writing `8` and `40` would silently start comparing
 * the wrong bytes on a bump — and a comparison that always passes is worse than none.
 *
 * Returns null for an account that is not there (nothing to recover), and THROWS when
 * the account is there but is not ours or not this pool's. Those are different facts and
 * only the second is alarming.
 */
async function readPositionDirect(
  pool: DlmmPool,
  owner: PublicKey,
  positionAddress: string,
): Promise<LbPosition | null> {
  const pubkey = new PublicKey(positionAddress);
  const info = await getConnection().getAccountInfo(pubkey, "confirmed");
  if (info === null) return null;

  const { positionLbPairFilter, positionOwnerFilter } = await loadDlmmSdk();
  const identity: [string, unknown, PublicKey][] = [
    ["lbPair", positionLbPairFilter(pool.pubkey), pool.pubkey],
    ["owner", positionOwnerFilter(owner), owner],
  ];

  for (const [field, filter, expected] of identity) {
    const memcmp =
      filter !== null && typeof filter === "object" && "memcmp" in filter
        ? (filter as { memcmp: { offset: number } }).memcmp
        : null;
    if (memcmp === null) {
      throw new DlmmExecutionError(
        `the DLMM SDK's ${field} filter is no longer a memcmp filter, so a position ` +
          `account's identity cannot be verified. Refusing to act on ${positionAddress}.`,
      );
    }
    const actual = info.data.subarray(memcmp.offset, memcmp.offset + 32);
    if (!actual.equals(expected.toBuffer())) {
      throw new DlmmExecutionError(
        `position ${positionAddress} carries a different ${field} than expected ` +
          `(${expected.toBase58()}). Refusing to act on it.`,
      );
    }
  }

  return pool.getPosition(pubkey);
}

/**
 * Whether a position still holds anything worth recovering.
 *
 * FEES COUNT, not just liquidity. A position whose bins are empty can still carry
 * unclaimed swap fees, and closing it without claiming them throws them away — the
 * account is gone and so is the claim. `removeLiquidity` with `shouldClaimAndClose`
 * takes both in one operation, which is why the two questions have one answer here.
 *
 * The amounts arrive as decimal strings (`BN.toString()` in the SDK), and a string that
 * can exceed 2^53 must not be routed through `Number` to be compared with zero. Testing
 * for any non-zero DIGIT is exact for every non-negative decimal representation and
 * loses no precision, which `parseFloat` would.
 *
 * Structurally typed so it is unit-testable without a cluster or the SDK.
 */
export function positionHoldsValue(data: {
  totalXAmount: string;
  totalYAmount: string;
  feeX: { isZero(): boolean };
  feeY: { isZero(): boolean };
}): boolean {
  const nonZero = (amount: string) => /[1-9]/.test(amount);
  return (
    nonZero(data.totalXAmount) ||
    nonZero(data.totalYAmount) ||
    !data.feeX.isZero() ||
    !data.feeY.isZero()
  );
}

/** The wallet's balance of one SPL token, or null when it could not be read. */
async function readAtaBalance(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): Promise<bigint | null> {
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);
  try {
    const balance = await getConnection().getTokenAccountBalance(ata, "confirmed");
    return BigInt(balance.value.amount);
  } catch {
    /*
     * NULL, never 0. This figure is used to size a deposit DOWN, so a zero standing in
     * for an unreadable balance would silently deposit nothing and report that as the
     * position's funding. "Unknown" has to stay distinguishable from "empty" — the same
     * three-state rule the database columns follow.
     */
    return null;
  }
}

/**
 * Simulates every funding chunk and reports the FIRST refusal caused by insufficient funds,
 * or null when none of them is short.
 *
 * WIDE path only, and called BEFORE anything is sent. The wide open funds its position with
 * several transactions, so a chunk refused after an earlier one landed leaves a funded
 * position account that nothing tracks — 12 Sep 2026, MANLET-SOL, 1.802543 SOL, and the
 * recovery's own transactions then lost to expired blockhashes. Checking first turns that
 * into a refusal that costs nothing but the swap's round trip.
 *
 * WHAT IT CANNOT PROVE, stated plainly: with no chunk landed, a shortfall caused by the
 * WALLET's balance is visible here — that is the 12 Sep case, where chunk 2 asked for more
 * of the paired token than the wallet held — while a shortfall that only exists in the state
 * a later chunk inherits is not. Since 15 Sep 2026 that residue is handled where it appears:
 * a chunk refused at preflight for insufficient funds is rebuilt once with a deposit shrunk
 * against the re-read wallet (`shrinkWideFundingDeposit`), and a second refusal falls to the
 * caller's recovery path.
 *
 * An RPC that could not simulate is skipped, never reported: "I could not check" is not
 * evidence that a chunk is short, and refusing on it would block opens for an RPC hiccup.
 */
async function firstShortFundingChunk(
  transactions: Transaction[],
  payer: PublicKey,
): Promise<string | null> {
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  for (const [index, tx] of transactions.entries()) {
    const sim = await simulateAgainstCluster(tx.instructions, payer, blockhash, onchainConfig);
    if (!sim.ran || sim.error === null) continue;
    if (isInsufficientFundsRejection(sim.logs, sim.error)) {
      return `chunk ${index + 1}/${transactions.length}: ${sim.error}`;
    }
  }
  return null;
}

/**
 * Submits a sequence of SDK transactions one at a time, stopping at the first failure.
 *
 * Sequential and not parallel: these transactions touch the same position account, and
 * the later ones assume the earlier ones landed. A partial run raises
 * `DlmmPartialExecutionError` carrying the signatures that DID land, because silently
 * returning the successful subset would report a partial claim as a complete one.
 */
async function sendSequentially(
  auth: ExecutionAuthorization,
  transactions: Transaction[],
  context: {
    operation: string;
    position: string;
    extraSigners?: Keypair[];
    /**
     * Rewrites each transaction before it is signed, and says what compute budget it
     * needs. Only the wide funding path uses it — see `partitionFundingInstructions`
     * and `fundingComputeUnits`. Omitted, every transaction is sent as the SDK built
     * it and sized by whatever budget it carries.
     */
    prepare?: (legacy: Transaction) => { transaction: Transaction; requestedUnits: number | null };
    /**
     * Re-derives the whole sequence from CURRENT chain state, for the attempt about to
     * be built. Returns the full array so the caller's chunking can be checked, not
     * just the one transaction.
     *
     * WHY REBUILDING IS SAFE HERE, given that this file's central rule is that an
     * unconfirmed transaction is rebroadcast unchanged rather than rebuilt.
     * `sendAndConfirm` calls its builder on the first attempt and then ONLY after the
     * previous blockhash has definitively expired — the one condition that makes the
     * previous signature permanently unlandable. At that point the bytes are dead, so
     * changing the instructions is exactly as safe as changing the blockhash, which
     * that loop already does. Any other failure never reaches a second build.
     *
     * WHY IT IS NECESSARY (9 Sep 2026). The DLMM funding instructions bake in the
     * pool's `activeId` as READ AT BUILD TIME — both as the strategy's bin deltas and
     * as the `activeId` the program compares against on execution. A rebuild that
     * reuses them re-sends a stale active bin with a fresh blockhash, so on a moving
     * pool every escalation attempt fails the same `ExceededBinSlippageTolerance`
     * check, more expensively each time. The SDK caches that state on the pool object,
     * so the caller must `refetchStates()` before rebuilding or it will hand back
     * identical instructions.
     */
    rebuild?: (index: number, attempt: number) => Promise<Transaction[]>;
    /**
     * Passed straight to `sendAndConfirm`. Only meaningful alongside `rebuild`: it
     * turns a preflight rejection into another build, and without a rebuild the next
     * build produces the same bytes.
     */
    rebuildableRejection?: (logs: string[] | null, message: string) => boolean;
    /**
     * Asked before EVERY rebuild (attempt > 0), before any bytes are built. Answering
     * "stop" ends the sequence as already settled: the signatures of this slot's earlier
     * attempts are looked up, any that confirmed are recorded as landed, and nothing
     * further is sent. See `closeRebuildDecision` — only the close uses it.
     */
    beforeRebuild?: (index: number, attempt: number) => Promise<"proceed" | "stop">;
  },
): Promise<SendResult[]> {
  const landed: SendResult[] = [];

  for (const [index, original] of transactions.entries()) {
    const label = `dlmm ${context.operation} ${index + 1}/${transactions.length}`;
    const attemptSignatures: string[] = [];
    try {
      landed.push(
        await sendAndConfirm(
          auth,
          async ({ blockhash, plan, attempt }) => {
            if (attempt > 0 && context.beforeRebuild) {
              if ((await context.beforeRebuild(index, attempt)) === "stop") {
                throw new SequenceAlreadySettled();
              }
            }

            let source = original;

            if (attempt > 0 && context.rebuild) {
              const fresh = await context.rebuild(index, attempt);
              /*
               * Fail rather than guess. The chunking is derived from the bin range,
               * which does not move, so a different length means the SDK partitioned
               * the deposit differently than the run that is already part-landed —
               * and sending `fresh[index]` under that assumption would fund a bin
               * range that does not correspond to the chunk this slot represents.
               * Refusing leaves a partial-execution error naming what did land.
               */
              if (fresh.length !== transactions.length) {
                throw new DlmmExecutionError(
                  `${label}: rebuild produced ${fresh.length} transaction(s) where the ` +
                    `first build produced ${transactions.length}; refusing to map ` +
                    `chunk ${index + 1} onto a different partition`,
                );
              }
              const replacement = fresh[index];
              if (!replacement) {
                throw new DlmmExecutionError(`${label}: rebuild returned no transaction`);
              }
              source = replacement;
            }

            const prepared = context.prepare?.(source);
            return asVersionedTransaction(
              prepared?.transaction ?? source,
              blockhash,
              plan,
              auth.wallet,
              context.extraSigners ?? [],
              prepared?.requestedUnits ?? null,
            );
          },
          {
            label,
            rebuildableRejection: context.rebuildableRejection,
            onAttempt: ({ signature }) => attemptSignatures.push(signature),
          },
        ),
      );
    } catch (err) {
      if (err instanceof SequenceAlreadySettled) {
        /*
         * The chain already holds the outcome. Record what can be PROVEN landed — an
         * earlier attempt of this slot whose signature the cluster reports confirmed —
         * and send nothing more. Nothing is invented: a slot whose signatures cannot be
         * found contributes no signature, and the caller decides what that means.
         */
        const statuses = await getConnection()
          .getSignatureStatuses(attemptSignatures, { searchTransactionHistory: true })
          .catch(() => null);
        statuses?.value.forEach((status, i) => {
          if (status && status.err === null && attemptSignatures[i]) {
            landed.push({
              signature: attemptSignatures[i]!,
              slot: status.slot ?? null,
              buildAttempts: i + 1,
              priorityMicroLamports: 0,
            });
          }
        });
        console.warn(
          `[onchain] ${label}: NOT rebuilding — the chain says this operation's outcome ` +
            `already happened (${landed.length} signature(s) confirmed); nothing more sent`,
        );
        return landed;
      }
      if (landed.length === 0) throw err;
      throw new DlmmPartialExecutionError(context.operation, context.position, landed, err);
    }
  }

  return landed;
}

/** `closeRebuildDecision`'s input, read by address. A read that throws is "unreadable". */
async function positionStateOrUnreadable(
  pool: DlmmPool,
  owner: PublicKey,
  positionAddress: string,
): Promise<PositionChainState | "unreadable"> {
  try {
    const position = await readPositionDirect(pool, owner, positionAddress);
    if (position === null) return "absent";
    return positionHoldsValue(position.positionData) ? "funded" : "empty";
  } catch {
    return "unreadable";
  }
}

/**
 * The newest CONFIRMED, successful signature that touched `address`, or null.
 *
 * For a position account that no longer exists, that is the transaction that closed it —
 * which is how a close that landed while the engine believed it failed is recorded with
 * the chain's own signature instead of an invented one.
 */
export async function findLastSuccessfulSignature(address: string): Promise<string | null> {
  const sigs = await getConnection().getSignaturesForAddress(new PublicKey(address), { limit: 10 }, "confirmed");
  return sigs.find((s) => s.err === null)?.signature ?? null;
}

/**
 * The Meteora DLMM operations, built against the real SDK.
 *
 * REACHABLE, AND SPENDING REAL MONEY SINCE 6 SEP 2026. This block used to say the
 * opposite, and left it saying so for a day after the engine went live — a comment
 * that tells a reader the code cannot spend is worse than no comment when it can.
 *
 * What still holds is the NARROWING, which is a different claim: the engine reaches
 * this module through `src/services/liveExecution.ts` and nothing else, so "can this
 * spend money, and under what conditions" has exactly one edge to review.
 * `onchainExecutor.test.ts` walks the import graph from `src/index.ts` to assert the
 * bridge is reachable, then re-walks with the bridge CUT to assert this module is not.
 * `ONCHAIN_EXECUTION_ARMED` still defaults to false, `authorizeExecution()` is still
 * the only source of an `ExecutionAuthorization`, and `env.ts` still refuses to boot a
 * half-armed configuration.
 */

/**
 * Creates every bin array the range needs that does not exist on-chain yet, ONE PER
 * TRANSACTION, before any funding runs. Returns how many it created.
 *
 * WHY THIS EXISTS (measured live on 7 Sep 2026, real money). The SDK's chunked funding
 * builder emits `InitializeBinArray` inline and budgets the whole chunk at its
 * `DEFAULT_ADD_LIQUIDITY_CU` constant (1,000,000). Each init costs the SDK's own
 * `DEFAULT_INIT_BIN_ARRAY_CU` of 350,000, so three missing arrays cannot fit that
 * budget however the compute limit is resolved. Creating them one per transaction,
 * out of the funding path, is what keeps that work bounded.
 *
 * WHAT THIS DOES NOT DO, corrected 8 Sep 2026. This comment used to claim that
 * pre-creating the arrays "means the funding builder finds every array present and
 * emits pure liquidity transactions". It does not, and believing it is what left the
 * wide path broken for three real-money incidents. The builder emits an init for
 * every array it COVERS, existence unchecked — so this call does not remove those
 * instructions, it only guarantees each one is a no-op. They still had to be dropped,
 * which is why this now returns the set of arrays known to exist and why
 * `partitionFundingInstructions` exists. `scripts/reproWideFunding.cjs` demonstrates
 * the whole thing against a live pool without spending anything.
 *
 * That is a genuinely separate defect from the compute-limit one that
 * `resolveComputeUnitLimit` fixes, and BOTH are needed: honouring the SDK's budget
 * stops us starving a transaction it sized correctly, and this stops the SDK packing
 * more into one transaction than any budget can cover.
 *
 * ORDERING. This runs BEFORE the position account is created, not after. Bin arrays
 * are derived from the pool and an index alone, so nothing here needs the position to
 * exist; and a failure partway through then leaves no position account behind, which
 * is the difference between a clean abort and an orphan holding recoverable-only-by-
 * hand rent. Bin-array rent is spent either way — it belongs to the pool, is shared by
 * every LP, and this repository has no path that reclaims it.
 */
/**
 * What `preCreateMissingBinArrays` learned, including the part the funding phase needs.
 *
 * `existing` is every bin array in range that is on-chain by the time this returns —
 * the ones that were already there plus the ones this call created. The wide funding
 * path uses it to drop the SDK's redundant `initializeBinArray` instructions; see
 * `partitionFundingInstructions` for why they are emitted at all.
 */
interface BinArrayPreparation extends EnsureBinArraysResult {
  existing: Set<string>;
}

async function preCreateMissingBinArrays(
  auth: ExecutionAuthorization,
  pool: DlmmPool,
  minBinId: number,
  maxBinId: number,
): Promise<BinArrayPreparation> {
  const sdk = await loadDlmmSdk();
  const { deriveBinArray, getBinArrayIndexesCoverage, BIN_ARRAY_FEE } = sdk;

  /*
   * Fail LOUDLY and BEFORE spending if the SDK no longer exports what this depends on.
   * A destructure of a renamed export yields `undefined` and throws at the call site
   * instead — which here would be mid-open, after the balancing swap.
   * `onchainExecutor.test.ts` asserts all three at build time, which is the real
   * guard; this covers a runtime whose node_modules disagree with the test run.
   */
  if (
    typeof deriveBinArray !== "function" ||
    typeof getBinArrayIndexesCoverage !== "function" ||
    typeof BIN_ARRAY_FEE !== "number"
  ) {
    throw new DlmmExecutionError(
      "the installed @meteora-ag/dlmm build does not export deriveBinArray, " +
        "getBinArrayIndexesCoverage and BIN_ARRAY_FEE. Refusing to open a position " +
        "rather than guess at bin-array creation.",
    );
  }

  const candidates = [...getBinArrayIndexesCoverage(new BN(minBinId), new BN(maxBinId))].map(
    (raw) => {
      const index = new BN(raw);
      const [pubkey] = deriveBinArray(pool.pubkey, index, pool.program.programId);
      return { index, pubkey };
    },
  );

  /*
   * One batched existence read for the common case, which is that every array already
   * exists and there is nothing to do. `getMultipleAccountsInfo` is capped at 100
   * accounts per request and a 1400-bin range spans 20, so the chunking is defensive
   * rather than currently load-bearing — but the range width is configuration.
   */
  const connection = pool.program.provider.connection;
  const infos: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const slice = candidates.slice(i, i + 100).map((c) => c.pubkey);
    infos.push(...(await connection.getMultipleAccountsInfo(slice)));
  }

  const missing = candidates.filter((_, i) => infos[i] === null);
  // Everything already on-chain. Grows below as each missing array is created, so the
  // funding phase can be told exactly which inits are redundant.
  const existing = new Set(
    candidates.filter((_, i) => infos[i] !== null).map((c) => c.pubkey.toBase58()),
  );

  if (missing.length === 0) {
    return { created: 0, existed: candidates.length, existing };
  }

  /*
   * Bin-array rent faces the per-transaction ceiling. Charged for the WHOLE set rather
   * than per transaction, deliberately: the ceiling is the blast radius of a bug, and
   * a loop that spends 0.0714 SOL a hundred times has a blast radius of 7.14 SOL
   * however modest each step looks on its own.
   */
  assertWithinSpendLimit(
    auth,
    Math.ceil(missing.length * BIN_ARRAY_FEE * 1e9),
    "dlmm openPosition (missing bin array rent)",
  );

  let created = 0;

  for (const [i, { index, pubkey }] of missing.entries()) {
    const label = `dlmm openPosition (init bin array ${i + 1}/${missing.length})`;

    /*
     * Built through Anchor's IDL-driven `accountsPartial`, which resolves accounts BY
     * NAME. That is the safe form of the rule this file states elsewhere — "no account
     * layout is written by hand, because a wrong ORDER does not throw, it moves funds"
     * — since naming an account cannot put it in the wrong slot and Anchor fills the
     * rest from the IDL. The one address that must be derived, `binArray`, comes from
     * the SDK's own `deriveBinArray` rather than a reimplementation of its seeds.
     *
     * The SDK's `createBinArraysIfNeeded` builds an identical instruction, but it is
     * marked private in the published types: calling it would mean casting past the
     * type system to reach an API its authors reserve the right to change.
     *
     * No compute-budget instruction is attached, so `resolveComputeUnitLimit` applies
     * the configured floor. That is deliberate and checked: the SDK budgets one
     * `InitializeBinArray` at 350,000 CU and the live failure measured ~192,000, both
     * under the 400,000 default floor.
     */
    const initIx = await pool.program.methods
      .initializeBinArray(index)
      .accountsPartial({ binArray: pubkey, funder: auth.wallet, lbPair: pool.pubkey })
      .instruction();

    try {
      await sendAndConfirm(
        auth,
        async ({ blockhash, plan }) =>
          asVersionedTransaction(new Transaction().add(initIx), blockhash, plan, auth.wallet, []),
        { label },
      );
      created += 1;
    } catch (err) {
      /*
       * Someone else may have created the same array between our read and our send —
       * bin arrays are shared pool infrastructure and any LP entering this range
       * creates them. For our purposes that is a SUCCESS: the array we needed is
       * there. Re-read before deciding, so a genuine failure still aborts the open
       * while no position account exists yet.
       */
      const nowExists = await connection.getAccountInfo(pubkey).catch(() => null);
      if (nowExists !== null) {
        console.log(`[onchain/dlmm] ${label}: already created by another party; continuing`);
        existing.add(pubkey.toBase58());
        continue;
      }
      throw err;
    }

    existing.add(pubkey.toBase58());
  }

  console.log(
    `[onchain/dlmm] ${pool.pubkey.toBase58()}: created ${created} bin array(s) ` +
      `(${(created * BIN_ARRAY_FEE).toFixed(4)} SOL of pool-shared rent) before funding`,
  );
  return { created, existed: candidates.length - created, existing };
}

/**
 * Withdraws every bin, claims the fees, closes the account and reclaims its rent — one
 * operation on-chain, per transaction.
 *
 * 100% (10 000 bps) with `shouldClaimAndClose`. Doing it as separate withdraw-then-close
 * calls would leave a funded-but-open position if the second failed, and the engine
 * would have booked the exit either way.
 *
 * Shared by the tracked close and the orphan recovery deliberately: those differ only in
 * HOW the position was found, and a second copy of this is how the recovery path would
 * drift into closing without claiming.
 */
async function withdrawClaimAndClose(
  auth: ExecutionAuthorization,
  pool: DlmmPool,
  position: LbPosition,
  operation: string,
): Promise<SendResult[]> {
  const address = position.publicKey.toBase58();
  const bins = position.positionData.positionBinData;
  const fromBinId = bins.at(0)?.binId;
  const toBinId = bins.at(-1)?.binId;

  if (fromBinId === undefined || toBinId === undefined) {
    throw new DlmmExecutionError(
      `position ${address} reports no bins; refusing to guess its range`,
    );
  }

  const transactions = await pool.removeLiquidity({
    user: auth.wallet,
    position: position.publicKey,
    fromBinId,
    toBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });

  /*
   * Before any REBUILD of a close transaction, ask the chain whether the close already
   * happened. See `closeRebuildDecision` — this is the state-aware half of the retry.
   */
  const beforeRebuild = async (): Promise<"proceed" | "stop"> => {
    const state = await positionStateOrUnreadable(pool, auth.wallet, address);
    return closeRebuildDecision(state) === "stop-already-closed" ? "stop" : "proceed";
  };

  if (transactions.length === 0) {
    /*
     * Nothing to withdraw. Before 13 Sep 2026 this threw unconditionally, so a position
     * already emptied by an earlier, partly-landed close could never be closed by the
     * engine: every tick rebuilt the same empty withdrawal and failed the same way, with
     * the row ACTIVE. When the account genuinely holds NO value — no liquidity AND no
     * fees, the same test the orphan recovery uses — closing it is the rent refund only
     * and loses nothing. When it still holds anything, the throw stands: closing would
     * discard what is in it.
     */
    if (positionHoldsValue(position.positionData)) {
      throw new DlmmExecutionError(`position ${address} produced no close transaction`);
    }
    console.warn(
      `[onchain/dlmm] ${address}: holds no liquidity and no fees; closing the empty ` +
        `account for its rent instead of withdrawing`,
    );
    const closeTx = await pool.closePosition({ owner: auth.wallet, position });
    return sendSequentially(auth, [closeTx], {
      operation: `${operation} (empty account)`,
      position: address,
      beforeRebuild,
    });
  }

  return sendSequentially(auth, transactions, { operation, position: address, beforeRebuild });
}

export const dlmmExecutor: DlmmExecutor = {
  async ensureBinArrays(
    auth: ExecutionAuthorization,
    params: EnsureBinArraysParams,
  ): Promise<EnsureBinArraysResult> {
    const pool = await openPool(params.poolAddress);
    const { minBinId, maxBinId } = binRangeFromPrices(
      pool,
      params.lowerBinPrice,
      params.upperBinPrice,
    );
    return preCreateMissingBinArrays(auth, pool, minBinId, maxBinId);
  },

  async openPosition(
    auth: ExecutionAuthorization,
    params: OpenPositionParams,
  ): Promise<DlmmOpenResult> {
    // Before any network call: the SOL leg is a spend, so it faces the ceiling first.
    assertWithinSpendLimit(auth, params.amountLamports, "dlmm openPosition");

    const { StrategyType: Strategy } = await loadDlmmSdk();
    const pool = await openPool(params.poolAddress);
    const { minBinId, maxBinId } = binRangeFromPrices(
      pool,
      params.lowerBinPrice,
      params.upperBinPrice,
    );

    const side = solSide(pool);
    if (side === null) {
      /*
       * `amountLamports` is SOL. If neither side of the pair is wSOL there is no
       * honest way to interpret it, and guessing would deposit a SOL-denominated
       * number of some other token's base units — a decimals bug that does not throw.
       */
      throw new DlmmExecutionError(
        `pool ${params.poolAddress} has no wSOL side (${pool.tokenX.publicKey.toBase58()} / ` +
          `${pool.tokenY.publicKey.toBase58()}); amountLamports has no meaning here`,
      );
    }

    // The side that is NOT wSOL, and the token program that owns it. Needed only to
    // re-read the wallet's balance when a simulation says the deposit is short.
    const pairedMint = side === "X" ? pool.tokenY.publicKey : pool.tokenX.publicKey;
    const pairedTokenProgram = side === "X" ? pool.tokenY.owner : pool.tokenX.owner;

    /*
     * The deposit's slippage is the ACTIVE-BIN bound, not the swap bound.
     *
     * This used to be `resolveSlippageBps(...) / 100`, i.e. Jupiter's 0.5% price
     * ceiling handed to a parameter the SDK reads as a bin count — one bin of drift
     * on any pool of bin_step 50 or more. Two quantities, one knob, and the tight one
     * won. `depositSlippage` resolves it against the pool's own bin step and reports
     * the bins it buys, so the log says what was actually sent.
     */
    const slip = depositSlippage(auth, pool.lbPair.binStep, params.slippageBps);

    const paired = new BN(Math.floor(params.pairedTokenAmount ?? 0));
    const sol = new BN(Math.floor(params.amountLamports));

    const positionKeypair = Keypair.generate();
    const positionAddress = positionKeypair.publicKey.toBase58();
    const binWidth = maxBinId - minBinId + 1;

    if (binWidth > DLMM_MAX_BINS_PER_POSITION) {
      throw new DlmmExecutionError(
        `pool ${params.poolAddress} needs ${binWidth} bins for range ` +
          `[${params.lowerBinPrice}, ${params.upperBinPrice}], over the ` +
          `${DLMM_MAX_BINS_PER_POSITION}-bin maximum of one DLMM position account. ` +
          `Widening past this needs several positions, which the engine's ` +
          `one-position-per-pool model does not support.`,
      );
    }

    /*
     * A FACTORY rather than a constant, because BOTH paths may have to rebuild the deposit
     * with a smaller paired amount after checking it against the chain: the narrow path
     * simulates its fused open and re-quotes before sending, and the wide path simulates its
     * funding chunks and re-quotes before sending any of them (12 Sep 2026). Neither binds a
     * single deposit and trusts it — that is what left a funded position unattended.
     */
    const depositFor = (pairedAmount: BN) => ({
      positionPubKey: positionKeypair.publicKey,
      user: auth.wallet,
      totalXAmount: side === "X" ? sol : pairedAmount,
      totalYAmount: side === "Y" ? sol : pairedAmount,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: Strategy[STRATEGY_TYPE[params.strategy]],
      },
      // The SDK takes slippage as a PERCENTAGE; our bound is in bps.
      slippage: slip.percent,
    });

    /*
     * What this open will actually cost in rent, asked of the SDK because bin-array
     * rent depends on which arrays already exist on-chain.
     *
     * It is charged to the spend ceiling. `assertWithinSpendLimit` bounds the number it
     * is handed, so a ceiling applied only to the deposit would leave the largest
     * remaining lamport movement in the transaction unbounded — and CLAUDE.md describes
     * this ceiling as bounding the transaction, not the deposit. Rent is recoverable on
     * close, but "recoverable" is not "unbounded".
     */
    const cost = await pool.quoteCreatePosition({
      strategy: { minBinId, maxBinId, strategyType: Strategy[STRATEGY_TYPE[params.strategy]] },
    });
    const positionRentLamports = Math.ceil(
      (cost.positionCost + cost.positionReallocCost + cost.bitmapExtensionCost) * 1e9,
    );
    const binArrayRentLamports = Math.ceil(cost.binArrayCost * 1e9);

    /*
     * Narrow range: unchanged single-transaction path.
     *
     * Kept as one transaction rather than routed through the wide path, because this
     * one is ATOMIC — the position cannot exist without its liquidity — and every
     * invariant in `liveExecution.ts` about not recording a row until the open confirms
     * is easier to hold when there is exactly one thing to confirm.
     */
    if (binWidth <= DLMM_BINS_PER_INIT) {
      /*
       * One transaction moves all three, so the ceiling faces their sum — and the
       * deposit term is the SLIPPAGE-WIDENED one, because that is what the program is
       * authorised to pull (`maxDepositXAmount`), not the nominal figure we asked for.
       *
       * The re-quote below only ever lowers the paired amount and never touches the SOL
       * leg, so this bound stays valid for every attempt: a smaller deposit cannot
       * breach a ceiling the larger one cleared.
       */
      assertWithinSpendLimit(
        auth,
        maxDepositLamports(params.amountLamports, slip.depositCeilingFactor) +
          positionRentLamports +
          binArrayRentLamports,
        "dlmm openPosition (max deposit + rent)",
      );

      /*
       * SIMULATE BEFORE SENDING, AND RE-QUOTE IF THE WALLET IS SHORT.
       *
       * The narrow path is one fused transaction and therefore atomic, which is why it
       * has never left an orphan — but atomic is not the same as safe, and until 10 Sep
       * 2026 it was sent BLIND. The rehearsal deliberately skips it (the deposit cannot
       * be simulated before the swap that funds it), so nothing between the swap and the
       * cluster ever looked at this transaction. The SDK simulates it, but only to SIZE
       * a compute budget: `getEstimatedComputeUnitIxWithBuffer` swallows a failed
       * simulation and falls back to 1.4M CU, so a transaction the cluster has already
       * refused is packaged with a bigger budget and sent anyway.
       *
       * By this point the balancing swap has spent, so a refusal here is not free — but
       * it is far cheaper than the alternative, and one failure mode is genuinely
       * FIXABLE from here: the deposit asking for more paired token than the wallet
       * holds (the SPL token program's InsufficientFunds, which killed the 10 Sep
       * KNOTS-SOL open on its wide sibling). The remedy is to ask the chain what is
       * really there and deposit that, which is why the re-quote reads the ATA rather
       * than trusting the caller's earlier read.
       *
       * Three boundaries are deliberate:
       *
       *  - A simulation that could not RUN sends anyway. An RPC that did not answer is
       *    not evidence the open would fail, and failing closed on a provider hiccup
       *    would strand the swap for a reason that has nothing to do with the pool.
       *    Same rule as the rehearsal.
       *  - A definitive rejection that is NEITHER a shortfall NOR a stale active bin is
       *    refused immediately rather than retried. Rebuilding cannot change it, and
       *    sending it would buy a guaranteed failure at the price of a priority fee.
       *  - The re-quote only ever moves DOWN (`BN.min`). Depositing more than the caller
       *    asked for because a balance read came back larger would spend money on an
       *    instruction nobody authorised.
       */
      let pairedForDeposit = paired;
      let transaction = await pool.initializePositionAndAddLiquidityByStrategy(
        depositFor(pairedForDeposit),
      );

      // One fetch for the whole loop: `simulateAgainstCluster` passes
      // `replaceRecentBlockhash`, so this value only has to be well-formed.
      const { blockhash: simulationBlockhash } =
        await getConnection().getLatestBlockhash("confirmed");

      for (let attempt = 0; ; attempt++) {
        const sim = await simulateAgainstCluster(
          transaction.instructions,
          auth.wallet,
          simulationBlockhash,
          onchainConfig,
        );

        if (!sim.ran) {
          console.warn(
            `[onchain/dlmm] ${positionAddress}: pre-send simulation unavailable; sending ` +
              `anyway — an RPC that could not simulate is not evidence the open fails`,
          );
          break;
        }

        if (sim.error === null) {
          if (attempt > 0) {
            console.log(
              `[onchain/dlmm] ${positionAddress}: fused open simulates clean on attempt ` +
                `${attempt + 1} with ${pairedForDeposit.toString()} paired base units ` +
                `(asked for ${paired.toString()})`,
            );
          }
          break;
        }

        const stale = isStaleActiveBinRejection(sim.logs, sim.error);
        const short = isInsufficientFundsRejection(sim.logs, sim.error);

        if (attempt >= NARROW_OPEN_REQUOTE_ATTEMPTS || (!stale && !short)) {
          throw new DlmmExecutionError(
            `the fused open for ${params.poolAddress} was REFUSED IN SIMULATION and NOT ` +
              `SENT (${sim.error}) after ${attempt + 1} attempt(s). The balancing swap has ` +
              `already spent, so the caller must unwind. Logs: ` +
              `${(sim.logs ?? []).slice(-5).join(" | ") || "none"}`,
          );
        }

        if (short) {
          const onChain = await readAtaBalance(auth.wallet, pairedMint, pairedTokenProgram);
          const next =
            onChain === null ? null : BN.min(pairedForDeposit, new BN(onChain.toString()));
          if (next === null || next.gte(pairedForDeposit)) {
            /*
             * Either the balance could not be read, or the wallet holds at least what
             * the deposit asks for — so the shortfall is somewhere this cannot reach
             * (the SOL leg, most likely). Re-sending an identical transaction would only
             * burn a fee.
             */
            throw new DlmmExecutionError(
              `the fused open for ${params.poolAddress} was refused for insufficient ` +
                `funds, but there is nothing to re-quote: the chain reports ` +
                `${onChain === null ? "an unreadable" : onChain.toString()} paired base ` +
                `units against a ${pairedForDeposit.toString()} deposit. Not sent ` +
                `(${sim.error}).`,
            );
          }
          console.warn(
            `[onchain/dlmm] ${positionAddress}: re-quoting the deposit from ` +
              `${pairedForDeposit.toString()} to ${next.toString()} paired base units — ` +
              `the simulation says the account is short`,
          );
          pairedForDeposit = next;
        }

        if (stale) {
          // The SDK builds from its cached `lbPair`, so without this the "rebuild" is
          // byte-identical and gets refused for the same reason. Same rule as the wide
          // funding rebuild.
          await pool.refetchStates();
          console.log(
            `[onchain/dlmm] ${positionAddress}: rebuilding the fused open for attempt ` +
              `${attempt + 2} — active bin is now ${pool.lbPair.activeId} ` +
              `(tolerance ${slip.bins} bin(s))`,
          );
        }

        transaction = await pool.initializePositionAndAddLiquidityByStrategy(
          depositFor(pairedForDeposit),
        );
      }

      const sent = await sendAndConfirm(
        auth,
        async ({ blockhash, plan }) =>
          asVersionedTransaction(transaction, blockhash, plan, auth.wallet, [positionKeypair]),
        { label: "dlmm openPosition" },
      );

      return {
        sent: [sent],
        position: positionAddress,
        depositedPairedAmount: pairedForDeposit.toString(),
      };
    }

    /*
     * Wide range: create the account first, then fund it. Necessarily TWO phases.
     *
     * `initializePositionAndAddLiquidityByStrategy` cannot do this — it asks
     * `initializePosition` for the full width in one instruction and dies in the CPI
     * realloc cap above 70 bins. `createExtendedEmptyPosition` instead emits
     * `initializePosition(70)` plus top-level `increasePositionLength` instructions,
     * which is the only shape the program accepts for a wide account.
     *
     * Two phases is forced by the CREATE, not by the funding. This comment used to say
     * the funding transactions "cannot be built ahead of time: the SDK reads the
     * position account", which is false in 1.9.14 — `chunkDepositWithRebalanceEndpoint`
     * uses the position only as an account meta and never fetches it. That is worth
     * knowing rather than tidying away: it is what lets `scripts/reproWideFunding.cjs`
     * inspect real funding transactions for free, and what makes the rebuild below
     * cheap. The failure mode is still real — once the create lands, the account
     * exists and holds rent whatever happens next.
     *
     * The rent is charged here too, and it is NOT small — it scales with the width
     * (~0.996 SOL at 1400 bins). It faces the spend ceiling for the same reason the
     * deposit does: a per-transaction bound that ignores the largest lamport movement
     * in the transaction is not a bound.
     */
    assertWithinSpendLimit(
      auth,
      positionRentLamports,
      "dlmm openPosition (wide position account rent)",
    );
    // The funding transactions carry the deposit and any new bin arrays. Same
    // widening as the narrow path: the ceiling faces what the program MAY pull.
    assertWithinSpendLimit(
      auth,
      maxDepositLamports(params.amountLamports, slip.depositCeilingFactor) +
        binArrayRentLamports,
      "dlmm openPosition (max deposit + bin array rent)",
    );

    console.log(
      `[onchain/dlmm] ${params.poolAddress}: ${binWidth} bins needs a wide position ` +
        `(${positionAccountBytes(binWidth)} bytes, ` +
        `${(positionRentLamports / 1e9).toFixed(4)} SOL account rent + ` +
        `${(binArrayRentLamports / 1e9).toFixed(4)} SOL for ${cost.binArraysCount} bin arrays, ` +
        `~${cost.transactionCount} tx); creating the account before funding it`,
    );
    console.log(
      `[onchain/dlmm] ${params.poolAddress}: active-bin tolerance ${slip.bins} bin(s) ` +
        `(${slip.percent}% at bin_step ${pool.lbPair.binStep}); max deposit ` +
        `${maxDepositLamports(params.amountLamports, slip.depositCeilingFactor)} lamports ` +
        `against ${params.amountLamports} nominal`,
    );

    /*
     * Bin arrays first, while a failure is still free of consequences.
     *
     * They are pool-level accounts, so nothing about them needs the position to exist,
     * and doing them here means an abort partway through leaves NO position account —
     * only arrays that the next attempt (or any other LP) will use. Doing it the other
     * way round, as this did when the fix first landed, makes every one of these sends
     * a potential orphan-maker.
     */
    const binArrays = await preCreateMissingBinArrays(auth, pool, minBinId, maxBinId);

    const createTx = await pool.createExtendedEmptyPosition(
      minBinId,
      maxBinId,
      positionKeypair.publicKey,
      auth.wallet,
    );

    const created = await sendAndConfirm(
      auth,
      async ({ blockhash, plan }) =>
        asVersionedTransaction(createTx, blockhash, plan, auth.wallet, [positionKeypair]),
      { label: "dlmm openPosition (create wide position)" },
    );

    /*
     * From here the position EXISTS and holds rent. Every failure below is therefore a
     * partial execution, never a clean one: reporting it as a plain error would leave
     * the operator with a funded-but-empty account nothing in the engine knows about.
     * `DlmmPartialExecutionError` names the address so it can be closed and the rent
     * recovered.
     */
    let funded: SendResult[] = [];
    /**
     * The paired amount the funding actually asks for; it may only ever move DOWN (see the
     * pre-send check below). Declared out here because the result reports it to the caller —
     * the position row must record what the chain was asked for, not what was requested.
     */
    let pairedForDeposit = paired;
    try {
      const activeIdAtBuild = pool.lbPair.activeId;
      /*
       * The wide path used to bind the deposit ONCE to the nominal figure and never
       * re-quote it, which is how a chunk asking for more of the paired token than the
       * wallet held reached the cluster on 12 Sep 2026. The pre-send check below shrinks it,
       * and the rebuild closure reads this variable rather than the original so a
       * mid-flight rebuild cannot inflate it back.
       */
      let liquidityTxs = await pool.addLiquidityByStrategyChunkable(depositFor(pairedForDeposit));

      if (liquidityTxs.length === 0) {
        throw new DlmmExecutionError(
          `the SDK produced no liquidity transaction for a ${binWidth}-bin range`,
        );
      }

      /*
       * PROVE THE SEQUENCE IS PAYABLE BEFORE ANY OF IT LANDS (12 Sep 2026).
       *
       * The wide open is the only shape that can leave capital behind, and this is why: it
       * funds the position with SEVERAL transactions, so "chunk 1 landed, chunk 2 refused"
       * is a state that can exist on-chain — a funded position account that no
       * `simulated_positions` row describes, because the open as a whole failed. On
       * 12 Sep 2026 that is exactly what happened (MANLET-SOL, 1.802543 SOL off the wallet,
       * the recovery's own transactions then lost to expired blockhashes, and the position
       * closed by hand ten minutes later).
       *
       * The NARROW path cannot fail this way: it simulates the fused open and, on
       * `insufficient funds`, re-reads the wallet's real token balance and shrinks the
       * request before sending anything. This is that protection, ported, with the same
       * refusal-shaped ending — when the shortfall cannot be re-quoted away this THROWS
       * BEFORE THE FIRST CHUNK IS SENT, so the caller unwinds a swap and an empty position
       * account instead of discovering a funded one.
       */
      for (let attempt = 0; ; attempt++) {
        const short = await firstShortFundingChunk(liquidityTxs, auth.wallet);
        if (short === null) break;

        const onChain = await readAtaBalance(auth.wallet, pairedMint, pairedTokenProgram);
        const next = onChain === null ? null : BN.min(pairedForDeposit, new BN(onChain.toString()));

        if (attempt >= WIDE_FUNDING_REQUOTE_ATTEMPTS || next === null || next.gte(pairedForDeposit)) {
          throw new DlmmExecutionError(
            `the wide funding sequence for ${params.poolAddress} was REFUSED IN SIMULATION and NOT ` +
              `SENT (${short}) after ${attempt + 1} attempt(s): not one chunk was broadcast, so no ` +
              `capital is stranded on-chain. The balancing swap has already spent, so the caller ` +
              `must unwind. The wallet holds ${onChain === null ? "an unreadable" : onChain.toString()} ` +
              `paired base units against a deposit request of ${pairedForDeposit.toString()} ` +
              `(the swap delivered ${paired.toString()}).`,
          );
        }

        pairedForDeposit = next;
        console.log(
          `[onchain/dlmm] ${positionAddress}: a funding chunk is short on the paired token; ` +
            `re-quoting the deposit DOWN from ${paired.toString()} to ${pairedForDeposit.toString()} ` +
            `base units and rebuilding its ${liquidityTxs.length} chunk(s) — nothing has been sent`,
        );
        await pool.refetchStates();
        liquidityTxs = await pool.addLiquidityByStrategyChunkable(depositFor(pairedForDeposit));
        if (liquidityTxs.length === 0) {
          throw new DlmmExecutionError(
            `the SDK produced no liquidity transaction after re-quoting the paired side down to ` +
              `${pairedForDeposit.toString()} base units`,
          );
        }
      }

      /*
       * The funding transactions are NOT sent as the SDK built them, and both edits
       * are the 8 Sep 2026 root cause:
       *
       *  - every `initializeBinArray` for an array `preCreateMissingBinArrays` just
       *    verified is dropped. The SDK emits one per covered array per chunk with no
       *    existence check (`isParallel: true` skips the branch that has one), and a
       *    redundant init is not free — 202,242 CU measured against mainnet;
       *  - the compute budget is supplied by us, because that same `isParallel` flag
       *    disables the branch that would have attached one. Every wide funding
       *    transaction ever sent therefore ran on the 400,000 CU floor against work
       *    the SDK sizes at 1,000,000 upward.
       *
       * `deriveBinArray` and the Anchor coder come from the SDK, so neither the
       * address derivation nor the instruction identification is reimplemented here.
       */
      /*
       * MID-FLIGHT SHORTFALL (15 Sep 2026, LEVERCAT-SOL). The check above proves the sequence
       * payable against the state BEFORE any chunk lands; it cannot see what a later chunk
       * inherits, and a stale-active-bin rebuild re-derives a chunk against a moved pool.
       * So a chunk refused at preflight for insufficient funds is rebuildable too — nothing
       * was broadcast — and its rebuild re-reads the wallet and shrinks the REMAINING deposit
       * (`shrinkWideFundingDeposit`), once. A second refusal throws, and the partial-execution
       * error that follows is what recovers the position and pages the operator.
       */
      const pairedAtFundingStart = await readAtaBalance(auth.wallet, pairedMint, pairedTokenProgram);
      let shortRejectionPending = false;
      let midflightShrinks = 0;
      const fundingRejection = (logs: string[] | null, message: string): boolean => {
        if (isStaleActiveBinRejection(logs, message)) return true;
        if (isInsufficientFundsRejection(logs, message)) {
          shortRejectionPending = true;
          return true;
        }
        return false;
      };

      const { deriveBinArray } = await loadDlmmSdk();
      const binArrayForIndex = (index: string): PublicKey | null => {
        try {
          return deriveBinArray(pool.pubkey, new BN(index), pool.program.programId)[0];
        } catch {
          return null;
        }
      };

      funded = await sendSequentially(auth, liquidityTxs, {
        operation: "openPosition (fund wide position)",
        position: positionAddress,
        extraSigners: [],
        /*
         * Every rebuild re-reads the pool and re-derives the instructions, so the
         * `activeId` they carry is the one the cluster will compare against rather
         * than the one that was current when the first attempt was signed.
         *
         * `refetchStates` is what makes this more than a no-op: the SDK builds from
         * `this.lbPair`, which it caches, so without the refetch a "rebuild" hands
         * back byte-identical instructions and escalates the fee on a transaction
         * that is going to be rejected for the same reason.
         */
        /*
         * The 9 Sep 2026 OTC-SOL failure was a PREFLIGHT rejection, which this file
         * otherwise treats as terminal — correctly, for every other cause. Without
         * this the rebuild above would be dead code on the exact incident it was
         * written for: `sendAndConfirm` only rebuilds after a blockhash EXPIRES, and
         * the funding transaction never got that far. It was refused in simulation,
         * deterministically, on every attempt it was allowed to make (one).
         */
        rebuildableRejection: fundingRejection,
        rebuild: async (index, attempt) => {
          await pool.refetchStates();
          if (shortRejectionPending) {
            shortRejectionPending = false;
            const balanceNow = await readAtaBalance(auth.wallet, pairedMint, pairedTokenProgram);
            const next =
              midflightShrinks >= WIDE_FUNDING_MIDFLIGHT_SHRINKS
                ? null
                : shrinkWideFundingDeposit({
                    planned: BigInt(pairedForDeposit.toString()),
                    balanceAtStart: pairedAtFundingStart,
                    balanceNow,
                    slippagePercent: slip.percent,
                  });
            if (next === null) {
              throw new DlmmExecutionError(
                `funding tx ${index + 1}/${liquidityTxs.length} was refused for INSUFFICIENT FUNDS ` +
                  `after ${midflightShrinks} mid-flight shrink(s) — NOT sent again. The wallet holds ` +
                  `${balanceNow === null ? "an unreadable" : balanceNow.toString()} paired base units ` +
                  `against a remaining deposit of ${pairedForDeposit.toString()} (funding started with ` +
                  `${pairedAtFundingStart === null ? "an unreadable balance" : pairedAtFundingStart.toString()}). ` +
                  `Earlier chunks LANDED: the position is funded and must be recovered.`,
              );
            }
            midflightShrinks += 1;
            console.warn(
              `[onchain/dlmm] ${positionAddress}: funding tx ${index + 1} refused at preflight for ` +
                `insufficient funds; re-read the wallet (${balanceNow?.toString()} paired base units) and ` +
                `shrinking the deposit DOWN from ${pairedForDeposit.toString()} to ${next.toString()} ` +
                `for the remaining chunk(s) — nothing was broadcast`,
            );
            pairedForDeposit = new BN(next.toString());
          }
          console.log(
            `[onchain/dlmm] ${positionAddress}: rebuilding funding tx ${index + 1} for ` +
              `attempt ${attempt + 1} — active bin ${activeIdAtBuild} -> ` +
              `${pool.lbPair.activeId} (${Math.abs(pool.lbPair.activeId - activeIdAtBuild)} ` +
              `bin(s) of drift, tolerance ${slip.bins})`,
          );
          /*
           * `pairedForDeposit`, not `paired`: if the pre-send check already had to shrink the
           * paired side to fit the wallet, a rebuild must stay at that smaller figure.
           * Rebuilding from the original is how a re-quote gets undone by the retry that was
           * meant to rescue it.
           */
          return pool.addLiquidityByStrategyChunkable(depositFor(pairedForDeposit));
        },
        prepare: (legacy) => {
          const { kept, dropped, keptBinArrayInits } = partitionFundingInstructions(
            legacy.instructions,
            pool.program.programId,
            /*
             * Anchor's published `InstructionCoder` interface declares `encode` but
             * not `decode`, though every shipped implementation (`BorshInstructionCoder`)
             * has it. The cast is narrowed to that one method rather than to `any`, and
             * `partitionFundingInstructions` treats a throw or a null as "unrecognised",
             * which KEEPS the instruction — so an SDK without it costs compute, never
             * correctness.
             */
            (data) =>
              (
                pool.program.coder.instruction as unknown as {
                  decode(d: Buffer): DecodedDlmmInstruction | null;
                }
              ).decode(data),
            binArrayForIndex,
            binArrays.existing,
          );

          if (dropped.length > 0) {
            console.log(
              `[onchain/dlmm] ${positionAddress}: dropped ${dropped.length} redundant ` +
                `InitializeBinArray instruction(s) (index ${dropped.join(", ")}) — those ` +
                `arrays already exist; the SDK emits them regardless`,
            );
          }

          const transaction = new Transaction();
          transaction.add(...kept);
          return { transaction, requestedUnits: fundingComputeUnits(keptBinArrayInits) };
        },
      });
    } catch (err) {
      const alreadyLanded = err instanceof DlmmPartialExecutionError ? err.landed : [];

      /*
       * BEST-EFFORT AUTO-CLOSE of the created-but-UNFUNDED position. The account
       * exists and holds rent; if it holds no liquidity (funding never landed), the
       * program's closePosition refunds that rent to the wallet. Without this, every
       * wide-open failure leaves an orphan account that only a human-run script can
       * close (STONK-SOL 0.2657 SOL, SOLCAT-SOL 0.0572 SOL, both on 7 Sep 2026).
       *
       * UNFUNDED IS NOW ASKED, NOT ASSUMED. `closePosition` does not withdraw, so on a
       * PARTIALLY funded position — funding chunk 1 landed, chunk 2 refused, the shape
       * of the 10 Sep 2026 KNOTS-SOL failure — this send is refused by the program and
       * the catch below logged "could not auto-close unfunded position" about an account
       * that was funded and earning. The transaction was wasted and the log was wrong
       * about the only thing that mattered. Recovering a funded position needs a
       * withdraw-claim-close, which is `closeOrphanPosition`, and the bridge runs it
       * from the `DlmmPartialExecutionError` this block is about to raise.
       *
       * A read that FAILS falls through to attempting the close anyway: not knowing is
       * not a reason to leave rent on the table, and the program still refuses a close
       * that would strand liquidity.
       */
      let holdsLiquidity = false;
      try {
        const existing = await readPositionDirect(pool, auth.wallet, positionAddress);
        holdsLiquidity = existing !== null && positionHoldsValue(existing.positionData);
      } catch (readErr) {
        console.warn(
          `[onchain/dlmm] ${positionAddress}: could not read the position before ` +
            `auto-closing it: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
        );
      }

      if (holdsLiquidity) {
        console.warn(
          `[onchain/dlmm] ${positionAddress}: NOT auto-closing — the position IS FUNDED, ` +
            `and closePosition does not withdraw. The partial-execution error names it so ` +
            `the caller can withdraw, claim and close it.`,
        );
      } else {
        try {
          // Runtime only consumes `position.publicKey` (accountsPartial
          // { rentReceiver, position, sender }); the full LbPosition shape is a TS
          // requirement. Fetching via getPositionsByUserAndLbPair can miss a freshly
          // created-but-empty account (observed with the SOLCAT-SOL orphan), so cast.
          const closeTx = await pool.closePosition({
            owner: auth.wallet,
            position: { publicKey: positionKeypair.publicKey } as unknown as LbPosition,
          });
          const closed = await sendAndConfirm(
            auth,
            async ({ blockhash, plan }) =>
              asVersionedTransaction(closeTx, blockhash, plan, auth.wallet, []),
            { label: "dlmm openPosition (auto-close unfunded position)" },
          );
          console.log(
            `[onchain/dlmm] ${positionAddress}: auto-closed unfunded position ` +
              `(rent recovered, ${closed.signature})`,
          );
        } catch (closeErr) {
          console.warn(
            `[onchain/dlmm] ${positionAddress}: could not auto-close unfunded position: ` +
              `${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          );
        }
      }

      throw new DlmmPartialExecutionError(
        "openPosition",
        positionAddress,
        [created, ...alreadyLanded],
        err,
      );
    }

    /*
     * The amount the CHAIN was asked for, which is no longer always the amount the caller
     * read: since 12 Sep 2026 the wide path simulates its funding chunks before sending any
     * of them and re-quotes the paired side DOWN when the wallet cannot cover the request.
     * Reporting `paired` here would write the caller's figure onto the position row while
     * the deposit carried less — the same class of untruth the narrow path already avoids.
     */
    return {
      sent: [created, ...funded],
      position: positionAddress,
      depositedPairedAmount: pairedForDeposit.toString(),
    };
  },

  async claimFees(
    auth: ExecutionAuthorization,
    params: ClaimFeesParams,
  ): Promise<DlmmSendResult> {
    const pool = await openPool(params.poolAddress);
    const position = await requirePosition(pool, auth.wallet, params.positionAddress);

    // Claiming moves fees TO the wallet, so there is no spend to bound here — only the
    // priority fee, which planPriorityFee already caps.
    const transactions = await pool.claimSwapFee({ owner: auth.wallet, position });

    if (transactions.length === 0) {
      throw new DlmmExecutionError(
        `position ${params.positionAddress} produced no claim transaction — there is ` +
          `nothing to claim, or the position was read as empty`,
      );
    }

    const sent = await sendSequentially(auth, transactions, {
      operation: "claimFees",
      position: params.positionAddress,
    });
    return { sent, position: params.positionAddress };
  },

  async closePosition(
    auth: ExecutionAuthorization,
    params: ClosePositionParams,
  ): Promise<DlmmSendResult> {
    const pool = await openPool(params.poolAddress);
    const position = await requirePosition(pool, auth.wallet, params.positionAddress);
    const sent = await withdrawClaimAndClose(auth, pool, position, "closePosition");
    return { sent, position: params.positionAddress };
  },

  async closeOrphanPosition(
    auth: ExecutionAuthorization,
    params: CloseOrphanPositionParams,
  ): Promise<OrphanPositionOutcome> {
    const pool = await openPool(params.poolAddress);
    const position = await readPositionDirect(pool, auth.wallet, params.positionAddress);

    const nothing = {
      liquidityX: "0",
      liquidityY: "0",
      unclaimedFeeX: "0",
      unclaimedFeeY: "0",
      signatures: [] as string[],
    };

    if (position === null) {
      return { state: "absent", ...nothing };
    }

    const data = position.positionData;
    const held = {
      liquidityX: data.totalXAmount,
      liquidityY: data.totalYAmount,
      unclaimedFeeX: data.feeX.toString(),
      unclaimedFeeY: data.feeY.toString(),
    };

    if (!positionHoldsValue(data)) {
      /*
       * Rent only. Recovering it is worth doing but it is not what this path is for,
       * and the wide open's own catch already attempts exactly that close moments
       * earlier — repeating it here would send a second transaction to be refused for
       * the same reason, on the failure path, with the swap already spent.
       */
      return { state: "empty", ...held, signatures: [] };
    }

    console.warn(
      `[onchain/dlmm] ${params.positionAddress}: the open failed but the position IS ` +
        `FUNDED (${held.liquidityX} X, ${held.liquidityY} Y, ${held.unclaimedFeeX}/` +
        `${held.unclaimedFeeY} unclaimed fees); withdrawing, claiming and closing it`,
    );

    const sent = await withdrawClaimAndClose(auth, pool, position, "closeOrphanPosition");
    return { state: "closed", ...held, signatures: sent.map((s) => s.signature) };
  },

  async readPositionState(
    auth: ExecutionAuthorization,
    params: ClosePositionParams,
  ): Promise<PositionChainState> {
    const pool = await openPool(params.poolAddress);
    const position = await readPositionDirect(pool, auth.wallet, params.positionAddress);
    if (position === null) return "absent";
    return positionHoldsValue(position.positionData) ? "funded" : "empty";
  },

  async quotePoolSaleToSol(params: PoolSaleParams): Promise<PoolSaleQuote> {
    const pool = await openPool(params.poolAddress);
    const { swapForY } = poolSaleSide(pool, params);
    const slippageBps = resolveExitSlippageBps(params.slippageBps);
    const binArrays = await pool.getBinArrayForSwap(swapForY);
    // isPartialFill false: a pool that cannot absorb the whole amount throws, never half-quotes.
    const quote = pool.swapQuote(new BN(params.amount), swapForY, new BN(slippageBps), binArrays);
    return {
      outLamports: quote.outAmount.toString(),
      minOutLamports: quote.minOutAmount.toString(),
      slippageBps,
    };
  },

  async sellToSolInPool(
    auth: ExecutionAuthorization,
    params: PoolSaleParams & { minOutLamports: string },
  ): Promise<SendResult> {
    const pool = await openPool(params.poolAddress);
    const { swapForY, mint, wsol } = poolSaleSide(pool, params);
    const minOut = new BN(params.minOutLamports);
    if (minOut.lten(0)) {
      throw new DlmmExecutionError(
        `refusing a pool sale of ${params.mint} with a minimum out of ${params.minOutLamports} ` +
          `lamports — a sale with no floor is not an exit, it is a donation`,
      );
    }

    // Selling a token moves SOL TO the wallet; there is no spend to bound beyond the fee.
    return sendAndConfirm(
      auth,
      async ({ blockhash, plan }) => {
        // Bin arrays are re-read per build: the route through the book moves; the floor does not.
        const binArrays = await pool.getBinArrayForSwap(swapForY);
        const route = pool.swapQuote(new BN(params.amount), swapForY, new BN(resolveExitSlippageBps(params.slippageBps)), binArrays);
        const tx = await pool.swap({
          inToken: mint,
          outToken: wsol,
          inAmount: new BN(params.amount),
          minOutAmount: minOut,
          lbPair: pool.pubkey,
          user: auth.wallet,
          binArraysPubkey: route.binArraysPubkey,
        });
        return asVersionedTransaction(tx, blockhash, plan, auth.wallet, []);
      },
      { label: `dlmm pool sale of ${params.mint}` },
    );
  },
};

/** Which way a pool sale of the paired token runs; refuses a pool with no wSOL side. */
function poolSaleSide(
  pool: DlmmPool,
  params: PoolSaleParams,
): { swapForY: boolean; mint: PublicKey; wsol: PublicKey } {
  const mint = new PublicKey(params.mint);
  const wsol = new PublicKey(WSOL_MINT);
  if (pool.tokenX.publicKey.equals(mint) && pool.tokenY.publicKey.equals(wsol)) {
    return { swapForY: true, mint, wsol };
  }
  if (pool.tokenY.publicKey.equals(mint) && pool.tokenX.publicKey.equals(wsol)) {
    return { swapForY: false, mint, wsol };
  }
  throw new DlmmExecutionError(
    `pool ${params.poolAddress} does not pair ${params.mint} with wSOL; refusing to sell ` +
      `through it`,
  );
}
