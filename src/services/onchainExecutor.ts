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
  /** Compute units requested per transaction. */
  ONCHAIN_COMPUTE_UNIT_LIMIT: numeric(400_000),
  /** Starting priority fee when the live sample is unavailable or zero. */
  ONCHAIN_MIN_PRIORITY_MICRO_LAMPORTS: numeric(20_000),
  /** Ceiling on the priority fee after escalation, in micro-lamports per CU. */
  ONCHAIN_MAX_PRIORITY_MICRO_LAMPORTS: numeric(2_000_000),
  /** Multiplier applied to the priority fee on each rebuild. */
  ONCHAIN_PRIORITY_ESCALATION: numeric(2.0),
  /** How many times a transaction may be REBUILT after its blockhash expires. */
  ONCHAIN_MAX_BUILD_ATTEMPTS: numeric(3),
  /** Jupiter swap API base. Keyless lite tier; matches ENDPOINTS.JUPITER_PRICE's host. */
  JUPITER_SWAP_API_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
});

export type OnchainConfig = {
  readonly armed: boolean;
  readonly maxLamportsPerTx: number;
  readonly maxSlippageBps: number;
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

  return Object.freeze({
    armed: parsed.ONCHAIN_EXECUTION_ARMED,
    maxLamportsPerTx: parsed.ONCHAIN_MAX_LAMPORTS_PER_TX,
    maxSlippageBps: slippage,
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
): Promise<VersionedTransaction> {
  if (quote.slippageBps > auth.maxSlippageBps) {
    throw new ExecutionLimitError(
      `Jupiter returned a quote at ${quote.slippageBps} bps slippage, above the ` +
        `authorized ${auth.maxSlippageBps} bps`,
    );
  }

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
    config?: OnchainConfig;
    onAttempt?: (info: { attempt: number; signature: string; plan: PriorityFeePlan }) => void;
  },
): Promise<{ result: SendResult; quote: JupiterQuote }> {
  const config = params.config ?? onchainConfig;
  const slippageBps = resolveSlippageBps(auth, params.slippageBps);

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
    async ({ blockhash, plan }) => buildJupiterSwap(auth, quote, plan, config, blockhash),
    {
      config,
      label: "jupiter swap",
      ...(params.onAttempt ? { onAttempt: params.onAttempt } : {}),
    },
  );

  return { result, quote };
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
  openPosition(auth: ExecutionAuthorization, params: OpenPositionParams): Promise<DlmmSendResult>;
  ensureBinArrays(
    auth: ExecutionAuthorization,
    params: EnsureBinArraysParams,
  ): Promise<EnsureBinArraysResult>;
  claimFees(auth: ExecutionAuthorization, params: ClaimFeesParams): Promise<DlmmSendResult>;
  closePosition(
    auth: ExecutionAuthorization,
    params: ClosePositionParams,
  ): Promise<DlmmSendResult>;
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
    positionSol,
    binArraysToCreate: quote.binArraysCount,
    binArraySol: quote.binArrayCost,
    totalSol: positionSol + quote.binArrayCost,
    transactionCount: quote.transactionCount,
  };
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
  binArraysToCreate: number;
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
     * The SAME budget the real send will carry, resolved the same way. A rehearsal
     * that simulated against a different compute limit than production uses would
     * pass exactly the transactions production then fails.
     */
    const requested = readRequestedComputeUnits(instructions);
    const { units } = resolveComputeUnitLimit(requested, config.computeUnitLimit);
    const withoutBudget = instructions.filter(
      (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
    );

    const message = new TransactionMessage({
      payerKey: params.wallet,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.minPriorityMicroLamports }),
        ...withoutBudget,
      ],
    }).compileToV0Message();

    let step: OpenRehearsalStep;
    try {
      const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      });
      step = {
        stage,
        computeUnitLimit: units,
        unitsConsumed: sim.value.unitsConsumed ?? null,
        error: sim.value.err === null ? null : JSON.stringify(sim.value.err),
        logs: sim.value.logs ?? null,
      };
    } catch (err) {
      /*
       * The RPC could not run the simulation. That is NOT evidence the open would
       * fail, so it must not be reported as a refusal — a rehearsal that fails closed
       * on its own outage would stop all trading whenever the provider hiccups, and
       * this gate protects against a specific on-chain failure, not against the RPC.
       * Same reasoning as `assessPoolCooldown` failing open.
       */
      step = {
        stage,
        computeUnitLimit: units,
        unitsConsumed: null,
        error: null,
        logs: [
          `rehearsal could not run: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
      console.warn(`[onchain/rehearsal] ${stage}: simulation unavailable; not treated as a refusal`);
    }
    steps.push(step);
  }

  const failure = steps.find((s) => s.error !== null) ?? null;
  const tight = steps.filter(
    (s) => s.unitsConsumed !== null && s.unitsConsumed > s.computeUnitLimit * 0.9,
  );

  return {
    ok: failure === null,
    binWidth,
    binArraysToCreate: wide ? missing.length : 0,
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
  },
): Promise<SendResult[]> {
  const landed: SendResult[] = [];

  for (const [index, original] of transactions.entries()) {
    const label = `dlmm ${context.operation} ${index + 1}/${transactions.length}`;
    const prepared = context.prepare?.(original);
    const legacy = prepared?.transaction ?? original;
    const requestedUnits = prepared?.requestedUnits ?? null;
    try {
      landed.push(
        await sendAndConfirm(
          auth,
          async ({ blockhash, plan }) =>
            asVersionedTransaction(
              legacy,
              blockhash,
              plan,
              auth.wallet,
              context.extraSigners ?? [],
              requestedUnits,
            ),
          { label },
        ),
      );
    } catch (err) {
      if (landed.length === 0) throw err;
      throw new DlmmPartialExecutionError(context.operation, context.position, landed, err);
    }
  }

  return landed;
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
  ): Promise<DlmmSendResult> {
    // Before any network call: the SOL leg is a spend, so it faces the ceiling first.
    assertWithinSpendLimit(auth, params.amountLamports, "dlmm openPosition");
    const slippageBps = resolveSlippageBps(auth, params.slippageBps);

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

    const deposit = {
      positionPubKey: positionKeypair.publicKey,
      user: auth.wallet,
      totalXAmount: side === "X" ? sol : paired,
      totalYAmount: side === "Y" ? sol : paired,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: Strategy[STRATEGY_TYPE[params.strategy]],
      },
      // The SDK takes slippage as a PERCENTAGE; our bound is in bps.
      slippage: slippageBps / 100,
    };

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
      // One transaction moves all three, so the ceiling faces their sum.
      assertWithinSpendLimit(
        auth,
        params.amountLamports + positionRentLamports + binArrayRentLamports,
        "dlmm openPosition (deposit + rent)",
      );

      const transaction = await pool.initializePositionAndAddLiquidityByStrategy(deposit);

      const sent = await sendAndConfirm(
        auth,
        async ({ blockhash, plan }) =>
          asVersionedTransaction(transaction, blockhash, plan, auth.wallet, [positionKeypair]),
        { label: "dlmm openPosition" },
      );

      return { sent: [sent], position: positionAddress };
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
     * The liquidity transactions cannot be built ahead of time: the SDK reads the
     * position account to build them, so it must already exist on-chain. That is what
     * makes this two phases rather than one, and why the failure mode below is real
     * rather than theoretical.
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
    // The funding transactions carry the deposit and any new bin arrays.
    assertWithinSpendLimit(
      auth,
      params.amountLamports + binArrayRentLamports,
      "dlmm openPosition (deposit + bin array rent)",
    );

    console.log(
      `[onchain/dlmm] ${params.poolAddress}: ${binWidth} bins needs a wide position ` +
        `(${positionAccountBytes(binWidth)} bytes, ` +
        `${(positionRentLamports / 1e9).toFixed(4)} SOL account rent + ` +
        `${(binArrayRentLamports / 1e9).toFixed(4)} SOL for ${cost.binArraysCount} bin arrays, ` +
        `~${cost.transactionCount} tx); creating the account before funding it`,
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
    try {
      const liquidityTxs = await pool.addLiquidityByStrategyChunkable(deposit);

      if (liquidityTxs.length === 0) {
        throw new DlmmExecutionError(
          `the SDK produced no liquidity transaction for a ${binWidth}-bin range`,
        );
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
       * BEST-EFFORT AUTO-CLOSE of the created-but-unfunded position. The account
       * exists and holds rent; if it holds no liquidity (funding never landed), the
       * program's closePosition refunds that rent to the wallet. Without this, every
       * wide-open failure leaves an orphan account that only a human-run script can
       * close (STONK-SOL 0.2657 SOL, SOLCAT-SOL 0.0572 SOL, both on 7 Sep 2026).
       * The close itself is safe to attempt: on an account that somehow DID receive
       * liquidity, closePosition2 refuses and this catch swallows the refusal.
       */
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

      throw new DlmmPartialExecutionError(
        "openPosition",
        positionAddress,
        [created, ...alreadyLanded],
        err,
      );
    }

    return { sent: [created, ...funded], position: positionAddress };
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

    const bins = position.positionData.positionBinData;
    const fromBinId = bins.at(0)?.binId;
    const toBinId = bins.at(-1)?.binId;

    if (fromBinId === undefined || toBinId === undefined) {
      throw new DlmmExecutionError(
        `position ${params.positionAddress} reports no bins; refusing to guess its range`,
      );
    }

    /*
     * 100% (10 000 bps) with `shouldClaimAndClose`, which is one operation on-chain:
     * withdraw every bin, claim the fees, close the account and reclaim its rent. Doing
     * it as separate withdraw-then-close calls would leave a funded-but-open position
     * if the second failed, and the engine would have booked the exit either way.
     */
    const transactions = await pool.removeLiquidity({
      user: auth.wallet,
      position: position.publicKey,
      fromBinId,
      toBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });

    if (transactions.length === 0) {
      throw new DlmmExecutionError(
        `position ${params.positionAddress} produced no close transaction`,
      );
    }

    const sent = await sendSequentially(auth, transactions, {
      operation: "closePosition",
      position: params.positionAddress,
    });
    return { sent, position: params.positionAddress };
  },
};
