import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { env, isLiveTradingEnabled } from "../config/env.js";
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
 * `isLiveTradingEnabled` in `src/config/env.ts` stays `false as const` and this
 * module NEVER reads it as permission — it reads it only to refuse (see
 * `authorizeExecution`). Arming this module does not arm the trading engine: the
 * engine still has no code path that calls any function here.
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
 * flips it. That flag governs the TRADING ENGINE, which remains paper-only; this
 * module is armed on its own, separate switch so that "the executor can sign" and "the
 * engine trades live" stay two independent facts. It is read here only to refuse the
 * one combination that would be incoherent — see below.
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
   * A tripwire, not a permission check. `isLiveTradingEnabled` is a `false` literal
   * today, so this never fires. If some future change makes it true WITHOUT an
   * execution path having been reviewed, this refuses rather than inheriting that
   * change as consent — the executor must be armed deliberately, never by proxy.
   */
  if (isLiveTradingEnabled !== false) {
    throw new ExecutionNotArmedError(
      "isLiveTradingEnabled changed without this module being reviewed; refusing to sign",
    );
  }

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
  computeUnitLimit: number;
  /** Priority portion only, in lamports. Diagnostic. */
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

/** The two compute-budget instructions every transaction this module builds carries. */
export function computeBudgetInstructions(plan: PriorityFeePlan) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnitLimit }),
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
  constructor(message: string, signature: string | null) {
    super(`[onchain] ${message}`);
    this.name = "TransactionFailedError";
    this.signature = signature;
  }
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
        // fail identically, so this is terminal rather than another attempt.
        throw new TransactionFailedError(
          `${label}: transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
          signature,
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
  config: OnchainConfig = onchainConfig,
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
    async ({ plan }) => buildJupiterSwap(auth, quote, plan, config),
    {
      config,
      label: "jupiter swap",
      ...(params.onAttempt ? { onAttempt: params.onAttempt } : {}),
    },
  );

  return { result, quote };
}

/* ------------------------------------------------------------------ */
/* Meteora DLMM adapter (STAGE 2 — interface only)                     */
/* ------------------------------------------------------------------ */

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `[onchain] ${what} is not implemented. Stage 2: install @meteora-ag/dlmm and build ` +
        `the instructions against the real SDK types. Do NOT stub this against guessed ` +
        `instruction layouts — a wrong account order does not throw, it moves funds.`,
    );
    this.name = "NotImplementedError";
  }
}

export interface OpenPositionParams {
  poolAddress: string;
  amountLamports: number;
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

/**
 * The three DLMM operations the live engine will eventually need.
 *
 * Declared as an interface now so the calling code, the guardlock and the tests can be
 * written and reviewed against a fixed shape, and Stage 2 only has to supply
 * instruction building. Every method takes an `ExecutionAuthorization` for the same
 * reason the Jupiter path does.
 */
export interface DlmmExecutor {
  openPosition(auth: ExecutionAuthorization, params: OpenPositionParams): Promise<SendResult>;
  claimFees(auth: ExecutionAuthorization, params: ClaimFeesParams): Promise<SendResult>;
  closePosition(auth: ExecutionAuthorization, params: ClosePositionParams): Promise<SendResult>;
}

/**
 * Stage 2 placeholder. Every method throws.
 *
 * Deliberately NOT a stub that "does nothing and returns success": a silent no-op in an
 * execution path reads as a working integration in every log and every test, right up
 * until the engine believes it holds a position it never opened. Throwing is the only
 * honest behaviour for an unimplemented money-moving function.
 */
export const dlmmExecutor: DlmmExecutor = {
  async openPosition(): Promise<SendResult> {
    throw new NotImplementedError("DLMM openPosition");
  },
  async claimFees(): Promise<SendResult> {
    throw new NotImplementedError("DLMM claimFees");
  },
  async closePosition(): Promise<SendResult> {
    throw new NotImplementedError("DLMM closePosition");
  },
};
