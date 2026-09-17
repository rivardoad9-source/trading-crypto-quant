/**
 * Exit economics: what a live exit ACTUALLY cost, one row per closed position.
 *
 * WHY. `src/backtest/exitCost.ts` prices every simulated exit from THREE live points
 * (MANLET, EMBER, NEARKAT), and TP / gate decisions now hang on that model. Three points
 * cannot carry that weight, and nothing recorded a fourth: the engine stored the close and
 * sweep SIGNATURES but never what the sweep received against what the token was worth. So
 * every live close now writes the measurement, and `npm run exitcosts:backfill` recovers it
 * for the trades that already happened.
 *
 * Three rules, all "unmeasured is null, never zero":
 *
 *  - `expected_out_lamports` is the swept token valued at the POOL price recorded at exit
 *    (before impact). `exit_cost_bps` = (expected - received) / notional x 10 000, for the
 *    one leg the sweep is. No sweep (dust, failed, sold by hand) -> null plus a note.
 *  - `exit_fee_lamports` is summed from the transaction meta of the stored signatures
 *    (`meta.fee` already includes the prioritisation fee). NOT the wallet delta
 *    `wallet_lamports_before/after`, which has been shown not to be final for a close.
 *  - A signature whose meta cannot be read makes the fee null and says which one and why.
 *
 * Pure derivation plus injected readers, so every branch is testable with synthetic meta.
 */
import { getTransactionMeta, type TransactionMetaReading } from "./solana.js";
import { fetchPoolByAddress } from "./meteora.js";
import { insertExitEconomicsIfAbsent } from "../database/repositories.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ExitEconomicsRow {
  positionId: string;
  pairName: string;
  mint: string | null;
  binStep: number | null;
  notionalLamports: number | null;
  tvlUsdAtExit: number | null;
  entryTvlUsd: number | null;
  poolPriceAtExit: number | null;
  sweepRoute: "jupiter" | "dlmm-pool" | null;
  sweepSlippageBpsUsed: number | null;
  sweepInAmount: string | null;
  sweepOutLamports: number | null;
  expectedOutLamports: number | null;
  exitFeeLamports: number | null;
  /** (expected - received) / notional x 10 000. */
  exitCostBps: number | null;
  /** (expected - received) / expected x 10 000 — the calibration unit of `exitCost.ts`. */
  sweepConcessionBps: number | null;
  /**
   * EVERY signature of the close, in the order the executor sent them (14 Sep 2026). A wide
   * position closes in several transactions and `closeSignature` is only the final one, so a
   * fee summed from that one alone under-counted the exit. Null when not recorded (backfill:
   * the earlier signatures were never stored anywhere and cannot be reconstructed).
   */
  closeSignatures: string[] | null;
  /**
   * Pool price read ONCE after the close and its sweep settled. `poolPriceAtExit` is the price
   * at the exit DECISION; on a bin_step-200 pool moving ~10%/h the two can differ enough that
   * a concession measured against the decision price is partly the market moving. Null (never
   * 0) when the pool could not be read, or when the row predates this column.
   */
  poolPriceAfterSweep: number | null;
  /** Same formula as `sweepConcessionBps`, against `poolPriceAfterSweep`. Additive: the old column keeps its meaning. */
  sweepConcessionAfterSweepBps: number | null;
  /** Same formula as `exitCostBps`, against `poolPriceAfterSweep`. */
  exitCostAfterSweepBps: number | null;
  source: "live" | "backfill";
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Transaction meta parsing                                            */
/* ------------------------------------------------------------------ */

/** SOL the fee payer received from a transaction, EXCLUDING the fee it paid. */
export function lamportsReceivedByPayer(meta: TransactionMetaReading): number {
  const pre = meta.preBalances[0];
  const post = meta.postBalances[0];
  if (pre === undefined || post === undefined) throw new Error("meta carries no fee-payer balance");
  return post - pre + meta.fee;
}

/** Base units of `mint` that left accounts owned by `owner` in a transaction (pre - post). */
export function tokenSpentByOwner(
  meta: TransactionMetaReading,
  mint: string,
  owner: string,
): { amount: bigint; decimals: number } | null {
  const sum = (list: TransactionMetaReading["preTokenBalances"]) => {
    let total = 0n;
    let decimals: number | null = null;
    for (const b of list) {
      if (b.mint !== mint) continue;
      const accountOwner = b.owner ?? null;
      if (accountOwner !== owner) continue;
      total += BigInt(b.uiTokenAmount.amount);
      decimals = b.uiTokenAmount.decimals;
    }
    return { total, decimals };
  };
  const pre = sum(meta.preTokenBalances);
  const post = sum(meta.postTokenBalances);
  const decimals = pre.decimals ?? post.decimals;
  if (decimals === null) return null;
  return { amount: pre.total - post.total, decimals };
}

/**
 * Value of `amount` base units at the pool price, in lamports.
 *
 * `poolPrice` is Meteora's `current_price`, Y per X in human units. When SOL is the quote
 * (Y) it is already SOL per token; when SOL is the base it is token per SOL and is inverted.
 */
export function valueAtPoolPriceLamports(
  amount: bigint,
  decimals: number,
  poolPrice: number,
  solIsQuote: boolean,
): number | null {
  if (!(poolPrice > 0) || !Number.isFinite(poolPrice)) return null;
  const human = Number(amount) / 10 ** decimals;
  const solPerToken = solIsQuote ? poolPrice : 1 / poolPrice;
  return Math.round(human * solPerToken * LAMPORTS_PER_SOL);
}

/**
 * Which side SOL is on, from the pair label ("TOKEN-SOL" / "SOL-TOKEN"); null when neither.
 *
 * The QUOTE is the LAST segment, not the second one: a base ticker may itself contain a dash
 * (`DOGE-1-SOL`), and splitting once gave `quote = "1"` — so DOGE-1's entry concession came
 * back "cannot tell which side of the pair SOL is" while the pool clearly quotes in SOL.
 * Found on 17 Sep 2026 when the entry-side measurement hit exactly that pool.
 */
export function solIsQuoteFromPairName(pairName: string): boolean | null {
  const parts = pairName.toUpperCase().split("-").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[parts.length - 1] === "SOL") return true;
  if (parts[0] === "SOL") return false;
  return null;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

export type MetaReader = (signature: string) => Promise<TransactionMetaReading | null>;

export interface ExitMeasurementInput {
  positionId: string;
  pairName: string;
  mint: string | null;
  binStep: number | null;
  notionalLamports: number | null;
  tvlUsdAtExit: number | null;
  entryTvlUsd: number | null;
  poolPriceAtExit: number | null;
  residualSweep: string | null;
  sweepRoute: "jupiter" | "dlmm-pool" | null;
  sweepSlippageBpsUsed: number | null;
  closeSignature: string | null;
  /** Every close tx signature. Absent/null = only `closeSignature` is known (backfill). */
  closeSignatures?: readonly string[] | null;
  sweepSignature: string | null;
  ataCloseSignature: string | null;
  /**
   * Pool price read after the sweep landed. `undefined` = never read on this path (backfill);
   * `null` = read and unusable, in which case `landingPriceNote` says why.
   */
  poolPriceAfterSweep?: number | null;
  landingPriceNote?: string | null;
  source: "live" | "backfill";
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/**
 * Reads the stored signatures and derives the row. Never throws: every failure becomes a
 * null field and a note, because a close that already happened must not be un-recorded
 * by a flaky RPC.
 */
export async function measureExitEconomics(
  input: ExitMeasurementInput,
  readMeta: MetaReader,
): Promise<ExitEconomicsRow> {
  const notes: string[] = [];
  const row: ExitEconomicsRow = {
    positionId: input.positionId,
    pairName: input.pairName,
    mint: input.mint,
    binStep: input.binStep,
    notionalLamports: input.notionalLamports,
    tvlUsdAtExit: input.tvlUsdAtExit,
    entryTvlUsd: input.entryTvlUsd,
    poolPriceAtExit: input.poolPriceAtExit,
    sweepRoute: input.sweepRoute,
    sweepSlippageBpsUsed: input.sweepSlippageBpsUsed,
    sweepInAmount: null,
    sweepOutLamports: null,
    expectedOutLamports: null,
    exitFeeLamports: null,
    exitCostBps: null,
    sweepConcessionBps: null,
    closeSignatures: null,
    poolPriceAfterSweep: null,
    sweepConcessionAfterSweepBps: null,
    exitCostAfterSweepBps: null,
    source: input.source,
    notes,
  };

  /*
   * The full close list: the executor's order, with the final signature appended only if the
   * caller did not already include it, and each signature counted once — a fee read twice is
   * as wrong as a fee not read at all.
   */
  const closeList: string[] = [];
  if (input.closeSignatures && input.closeSignatures.length > 0) {
    for (const s of [...input.closeSignatures, ...(input.closeSignature ? [input.closeSignature] : [])]) {
      if (s && !closeList.includes(s)) closeList.push(s);
    }
    row.closeSignatures = closeList;
  } else {
    if (input.closeSignature) closeList.push(input.closeSignature);
    notes.push("close_signatures not recorded: only the final close tx signature was stored for this exit");
  }

  const metas = new Map<string, TransactionMetaReading>();
  const read = async (label: string, signature: string | null): Promise<TransactionMetaReading | null> => {
    if (!signature) return null;
    try {
      const meta = await readMeta(signature);
      if (meta === null) {
        notes.push(`tx meta ${label} ${signature.slice(0, 8)}… unreadable: not found`);
        return null;
      }
      metas.set(label, meta);
      return meta;
    } catch (err) {
      notes.push(`tx meta ${label} ${signature.slice(0, 8)}… unreadable: ${errText(err)}`);
      return null;
    }
  };

  /* ---- fees: every stored signature, or null ---- */
  const stored: Array<[string, string | null]> = [
    ...closeList.map((sig, i): [string, string] => [closeList.length === 1 ? "close" : `close ${i + 1}/${closeList.length}`, sig]),
    ["sweep", input.sweepSignature],
    ["ata_close", input.ataCloseSignature],
  ];
  let feeTotal = 0;
  let feeMeasurable = closeList.length > 0;
  if (closeList.length === 0) notes.push("no close signature stored — exit fee unmeasured");
  for (const [label, sig] of stored) {
    if (!sig) continue;
    const meta = await read(label, sig);
    if (meta === null) feeMeasurable = false;
    else feeTotal += meta.fee;
  }
  if (feeMeasurable) {
    row.exitFeeLamports = feeTotal;
    notes.push(
      row.closeSignatures
        ? `fee covers all ${closeList.length} close tx(s) + sweep + ata_close stored for this exit`
        : "fee covers the stored FINAL close tx only; earlier txs of a multi-tx close are not stored",
    );
  }
  if (input.sweepRoute === "dlmm-pool") {
    notes.push(
      "sweep_slippage_bps_used is the exit ladder's CAP (the bound the dlmm-pool route runs at), not a Jupiter rung that sold",
    );
  }

  /* ---- the landing price: recorded whether or not the sweep leg is measurable ---- */
  if (input.poolPriceAfterSweep === undefined) {
    notes.push("pool price after sweep not recorded for this exit: landing concession unmeasured");
  } else if (input.poolPriceAfterSweep !== null && input.poolPriceAfterSweep > 0 && Number.isFinite(input.poolPriceAfterSweep)) {
    row.poolPriceAfterSweep = input.poolPriceAfterSweep;
  } else {
    notes.push(input.landingPriceNote ?? "pool price after sweep unusable: landing concession unmeasured");
  }

  /* ---- the sweep leg ---- */
  if (input.residualSweep !== "swept" || !input.sweepSignature) {
    notes.push(
      `sweep leg unmeasured: residual_sweep=${input.residualSweep ?? "null"}` +
        (input.sweepSignature ? "" : ", no sweep signature") +
        (input.residualSweep === "operator" ? " (sold by hand; that sale is not recorded)" : ""),
    );
    return row;
  }
  const sweep = metas.get("sweep");
  if (!sweep) return row; // the unreadable note is already there
  if (sweep.err !== null && sweep.err !== undefined) {
    notes.push(`sweep tx failed on-chain: ${JSON.stringify(sweep.err)}`);
    return row;
  }
  if (!input.mint) {
    notes.push("sweep leg unmeasured: paired mint unknown");
    return row;
  }
  const payer = sweep.accountKeys[0];
  const spent = payer ? tokenSpentByOwner(sweep, input.mint, payer) : null;
  if (!spent || spent.amount <= 0n) {
    notes.push("sweep leg unmeasured: no token balance change for the paired mint in the sweep tx");
    return row;
  }
  row.sweepInAmount = spent.amount.toString();
  row.sweepOutLamports = lamportsReceivedByPayer(sweep);

  const solIsQuote = solIsQuoteFromPairName(input.pairName);
  // Landing-price concession first and independently: a missing DECISION price must not hide it.
  if (solIsQuote !== null && row.poolPriceAfterSweep !== null) {
    const expectedAfter = valueAtPoolPriceLamports(spent.amount, spent.decimals, row.poolPriceAfterSweep, solIsQuote);
    if (expectedAfter !== null && expectedAfter > 0) {
      const gapAfter = expectedAfter - row.sweepOutLamports;
      row.sweepConcessionAfterSweepBps = (gapAfter / expectedAfter) * 10_000;
      if (input.notionalLamports !== null && input.notionalLamports > 0) {
        row.exitCostAfterSweepBps = (gapAfter / input.notionalLamports) * 10_000;
      }
    }
  }
  if (solIsQuote === null || input.poolPriceAtExit === null) {
    notes.push("expected out unmeasured: pool price at exit or SOL side unknown");
    return row;
  }
  row.expectedOutLamports = valueAtPoolPriceLamports(spent.amount, spent.decimals, input.poolPriceAtExit, solIsQuote);
  if (row.expectedOutLamports === null || !(row.expectedOutLamports > 0)) {
    row.expectedOutLamports = null;
    notes.push("expected out unmeasured: unusable pool price");
    return row;
  }
  const gap = row.expectedOutLamports - row.sweepOutLamports;
  row.sweepConcessionBps = (gap / row.expectedOutLamports) * 10_000;
  if (input.notionalLamports !== null && input.notionalLamports > 0) {
    row.exitCostBps = (gap / input.notionalLamports) * 10_000;
  } else {
    notes.push("exit_cost_bps unmeasured: notional unknown");
  }
  notes.push("pool price is the one recorded at the exit DECISION, not at the sweep's landing");
  return row;
}

/**
 * A failed open's round trip (swap in, unwind out) as a per-leg observation.
 *
 * received / spent covers two legs and, for a Token-2022 fee mint, the transfer fee on
 * both. The fee part is removed — it is not a bin-step cost — and the remainder split
 * evenly over the two legs. Stored with `expected_out` = spent after the transfer fees, so
 * the row stays in the same units as a sweep row.
 */
export async function measureFailedOpenRoundTrip(
  input: {
    positionId: string;
    pairName: string;
    mint: string;
    binStep: number | null;
    entryTvlUsd: number | null;
    swapSignature: string;
    unwindSignature: string;
    transferFeeBps: number | null;
  },
  readMeta: MetaReader,
): Promise<ExitEconomicsRow> {
  const notes: string[] = ["failed open: swap in + auto-unwind, per-leg cost after the transfer fee"];
  const row: ExitEconomicsRow = {
    positionId: input.positionId,
    pairName: input.pairName,
    mint: input.mint,
    binStep: input.binStep,
    notionalLamports: null,
    tvlUsdAtExit: null,
    entryTvlUsd: input.entryTvlUsd,
    poolPriceAtExit: null,
    sweepRoute: "jupiter",
    sweepSlippageBpsUsed: null,
    sweepInAmount: null,
    sweepOutLamports: null,
    expectedOutLamports: null,
    exitFeeLamports: null,
    exitCostBps: null,
    sweepConcessionBps: null,
    closeSignatures: null,
    poolPriceAfterSweep: null,
    sweepConcessionAfterSweepBps: null,
    exitCostAfterSweepBps: null,
    source: "backfill",
    notes,
  };
  let swap: TransactionMetaReading | null = null;
  let unwind: TransactionMetaReading | null = null;
  try {
    swap = await readMeta(input.swapSignature);
    if (!swap) notes.push("tx meta swap unreadable: not found");
  } catch (err) {
    notes.push(`tx meta swap unreadable: ${errText(err)}`);
  }
  try {
    unwind = await readMeta(input.unwindSignature);
    if (!unwind) notes.push("tx meta unwind unreadable: not found");
  } catch (err) {
    notes.push(`tx meta unwind unreadable: ${errText(err)}`);
  }
  if (!swap || !unwind) return row;

  const spent = -lamportsReceivedByPayer(swap);
  const back = lamportsReceivedByPayer(unwind);
  row.notionalLamports = spent;
  row.sweepOutLamports = back;
  row.exitFeeLamports = swap.fee + unwind.fee;
  if (input.transferFeeBps === null) {
    notes.push("transfer fee unknown — per-leg cost unmeasured");
    return row;
  }
  const keep = 1 - input.transferFeeBps / 10_000;
  row.expectedOutLamports = Math.round(spent * keep * keep);
  const roundTripBps = ((row.expectedOutLamports - back) / spent) * 10_000;
  row.exitCostBps = roundTripBps / 2;
  row.sweepConcessionBps = roundTripBps / 2;
  return row;
}

/* ------------------------------------------------------------------ */
/* The live write                                                      */
/* ------------------------------------------------------------------ */

/**
 * A just-confirmed transaction can be missing from `getTransaction` for a moment. A few
 * spaced reads, then the honest answer: null, recorded as unreadable.
 */
export function metaReaderWithRetry(
  read: MetaReader = getTransactionMeta,
  attempts = 3,
  delayMs = 2_000,
): MetaReader {
  return async (signature) => {
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const meta = await read(signature);
        if (meta !== null) return meta;
        lastErr = null;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr !== null) throw lastErr;
    return null;
  };
}

export interface LiveExitRecordDeps {
  readMeta: MetaReader;
  /**
   * Bin step, TVL and the current pool price NOW — i.e. after the close and sweep settled,
   * since the recorder runs after both. Null when the pool could not be read. `currentPrice`
   * is optional so an older reader still types; absent reads as unmeasured, never 0.
   */
  readPool(poolAddress: string): Promise<{ binStep: number; tvlUsd: number; currentPrice?: number | null } | null>;
  insert(row: ExitEconomicsRow): boolean;
}

export const defaultLiveExitRecordDeps = (): LiveExitRecordDeps => ({
  readMeta: metaReaderWithRetry(),
  async readPool(poolAddress) {
    const pool = await fetchPoolByAddress(poolAddress, { quiet: true });
    return pool ? { binStep: pool.binStep, tvlUsd: pool.tvlUsd, currentPrice: pool.currentPrice } : null;
  },
  insert: insertExitEconomicsIfAbsent,
});

/**
 * Called by the close settlement right AFTER the position row is written as closed.
 * NEVER THROWS: the exit already happened and is recorded; a measurement failure must
 * cost a log line, not the close. Returns the row it wrote, or null when it wrote none.
 */
export async function recordLiveExitEconomics(
  input: Omit<ExitMeasurementInput, "binStep" | "tvlUsdAtExit" | "source" | "poolPriceAfterSweep" | "landingPriceNote"> & {
    poolAddress: string;
  },
  deps: LiveExitRecordDeps = defaultLiveExitRecordDeps(),
): Promise<ExitEconomicsRow | null> {
  try {
    let binStep: number | null = null;
    let tvlUsdAtExit: number | null = null;
    let poolNote: string | null = null;
    // ONE pool read, after the sweep settled: it supplies bin_step, TVL and the landing price.
    let poolPriceAfterSweep: number | null = null;
    let landingPriceNote: string | null = null;
    try {
      const pool = await deps.readPool(input.poolAddress);
      if (pool) {
        binStep = pool.binStep;
        tvlUsdAtExit = pool.tvlUsd;
        const price = pool.currentPrice;
        if (typeof price === "number" && Number.isFinite(price) && price > 0) poolPriceAfterSweep = price;
        else landingPriceNote = "pool price after sweep unusable (missing or non-positive): landing concession unmeasured";
      } else {
        poolNote = "pool unreadable at exit: bin_step and TVL unmeasured";
        landingPriceNote = "pool unreadable after sweep: pool_price_after_sweep and landing concession unmeasured";
      }
    } catch (err) {
      poolNote = `pool unreadable at exit (${errText(err)}): bin_step and TVL unmeasured`;
      landingPriceNote = "pool unreadable after sweep: pool_price_after_sweep and landing concession unmeasured";
    }
    const row = await measureExitEconomics(
      { ...input, binStep, tvlUsdAtExit, poolPriceAfterSweep, landingPriceNote, source: "live" },
      deps.readMeta,
    );
    if (poolNote) row.notes.unshift(poolNote);
    deps.insert(row);
    return row;
  } catch (err) {
    console.warn(`[exit-economics] could not record ${input.pairName} (${input.positionId}): ${errText(err)}`);
    return null;
  }
}
