/**
 * Entry economics: what a live ENTRY actually cost, one row per opened position.
 *
 * WHY. `exit_economics` measures the leg that sells the token back, and the entry gate prices
 * a round trip as `gas + forced-exit slippage` — the ENTRY leg has no term at all. Measuring
 * the live trades (17 Sep 2026) showed the missing leg is not free: the swap that buys the
 * paired token filled a median 0,42% of notional away from the price the decision was made on
 * (n=7, −0,43%…+2,52%), which is 26-35% of the reconciliation gap between the book and the
 * wallet. This module is where those points accumulate — one row per entry, written by
 * `npm run entrycosts:backfill` (safe to re-run, insert-if-absent).
 *
 * Two rules, both "unmeasured is null, never zero":
 *
 *  - `expected_tokens` is the SOL actually spent valued at the POOL price recorded at the
 *    entry DECISION (before impact). `entry_cost_bps` = (expected - received) / notional
 *    x 10 000 — the same unit as `forced_exit_slippage_pct`, so the two legs add up.
 *    `entry_concession_bps` = (expected - received) / expected x 10 000 — the calibration
 *    unit of the swap itself, independent of position size.
 *  - Positive bps always mean "worse than the recorded price": on a buy that is more tokens
 *    paid, on the exit it is fewer lamports received.
 *
 * A transaction whose meta cannot be read leaves the leg null plus a note. Nothing here
 * throws into a caller: the entry already happened and a flaky RPC must not lose it.
 */
import { type TransactionMetaReading } from "./solana.js";
import { solIsQuoteFromPairName, LAMPORTS_PER_SOL } from "./exitEconomics.js";

export interface EntryEconomicsRow {
  positionId: string;
  pairName: string;
  mint: string | null;
  binStep: number | null;
  /** The SIZED position in lamports (both legs), not just the SOL leg the swap spent. */
  notionalLamports: number | null;
  tvlUsdAtEntry: number | null;
  /** Pool price recorded at the entry decision — the reference for the concession. */
  poolPriceAtEntry: number | null;
  swapSignature: string | null;
  openSignature: string | null;
  /** Lamports the entry swap spent, excluding its own fee. */
  swapInLamports: number | null;
  /** Base units of the paired mint the swap delivered. */
  tokensReceived: string | null;
  /** Base units the same lamports should have bought at `poolPriceAtEntry`. */
  expectedTokens: string | null;
  entryFeeLamports: number | null;
  /** (expected - received) / expected x 10 000. */
  entryConcessionBps: number | null;
  /** (expected - received) / notional x 10 000 — additive with `exit_cost_bps`. */
  entryCostBps: number | null;
  /** Pool price read shortly AFTER the swap landed; null when read too late to be a landing. */
  poolPriceAfterEntry: number | null;
  entryConcessionAfterPriceBps: number | null;
  entryCostAfterPriceBps: number | null;
  source: "live" | "backfill";
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Transaction meta parsing                                            */
/* ------------------------------------------------------------------ */

/** Lamports the fee payer SPENT in a transaction, excluding the fee it paid. */
export function lamportsSpentByPayer(meta: TransactionMetaReading): number {
  const pre = meta.preBalances[0];
  const post = meta.postBalances[0];
  if (pre === undefined || post === undefined) throw new Error("meta carries no fee-payer balance");
  return pre - post - meta.fee;
}

/** Base units of `mint` that ARRIVED in accounts owned by `owner` (post - pre). */
export function tokenReceivedByOwner(
  meta: TransactionMetaReading,
  mint: string,
  owner: string,
): { amount: bigint; decimals: number } | null {
  const sum = (list: TransactionMetaReading["preTokenBalances"]) => {
    let total = 0n;
    let decimals: number | null = null;
    for (const b of list) {
      if (b.mint !== mint) continue;
      if ((b.owner ?? null) !== owner) continue;
      total += BigInt(b.uiTokenAmount.amount);
      decimals = b.uiTokenAmount.decimals;
    }
    return { total, decimals };
  };
  const pre = sum(meta.preTokenBalances);
  const post = sum(meta.postTokenBalances);
  const decimals = post.decimals ?? pre.decimals;
  if (decimals === null) return null;
  return { amount: post.total - pre.total, decimals };
}

/**
 * Base units of the paired mint that `lamports` should have bought at `poolPrice`.
 *
 * `poolPrice` is Meteora's `current_price`, Y per X in human units: SOL per token when SOL
 * is the quote side, token per SOL when SOL is the base — in which case it inverts.
 */
export function tokensAtPoolPrice(
  lamports: number,
  decimals: number,
  poolPrice: number,
  solIsQuote: boolean,
): number | null {
  if (!(poolPrice > 0) || !Number.isFinite(poolPrice)) return null;
  const solPerToken = solIsQuote ? poolPrice : 1 / poolPrice;
  if (!(solPerToken > 0) || !Number.isFinite(solPerToken)) return null;
  return (lamports / LAMPORTS_PER_SOL / solPerToken) * 10 ** decimals;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

export type MetaReader = (signature: string) => Promise<TransactionMetaReading | null>;

export interface EntryMeasurementInput {
  positionId: string;
  pairName: string;
  mint: string | null;
  binStep: number | null;
  notionalLamports: number | null;
  tvlUsdAtEntry: number | null;
  poolPriceAtEntry: number | null;
  swapSignature: string | null;
  openSignature: string | null;
  /**
   * Pool price read after the entry settled. `undefined` = never read on this path;
   * `null` = read and unusable (or read too late to be a landing reference), and
   * `landingPriceNote` says which.
   */
  poolPriceAfterEntry?: number | null;
  landingPriceNote?: string | null;
  /**
   * Failed open (swap in, rescue unwind): measured as a round-trip friction instead, since
   * no position exists and no decision price was stored.
   */
  unwindSignature?: string | null;
  /**
   * Lamports the ATTEMPT cost the wallet, as the engine recorded it at the time. Used only
   * for a failed open whose unwind signature was never stored: without that signature the
   * legs cannot be separated, so this stays a round trip by construction — swap in, unwind,
   * and rent, all in one number — and the note says so.
   */
  recordedCostLamports?: number | null;
  source: "live" | "backfill";
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/** Round-trip friction of a failed open as bps of the SOL spent; null when unmeasurable. */
export function failedOpenRoundTripBps(spent: number, back: number): number | null {
  if (!(spent > 0)) return null;
  return ((spent - back) / spent) * 10_000;
}

export async function measureEntryEconomics(
  input: EntryMeasurementInput,
  readMeta: MetaReader,
): Promise<EntryEconomicsRow> {
  const notes: string[] = [];
  const row: EntryEconomicsRow = {
    positionId: input.positionId,
    pairName: input.pairName,
    mint: input.mint,
    binStep: input.binStep,
    notionalLamports: input.notionalLamports,
    tvlUsdAtEntry: input.tvlUsdAtEntry,
    poolPriceAtEntry: input.poolPriceAtEntry,
    swapSignature: input.swapSignature,
    openSignature: input.openSignature,
    swapInLamports: null,
    tokensReceived: null,
    expectedTokens: null,
    entryFeeLamports: null,
    entryConcessionBps: null,
    entryCostBps: null,
    poolPriceAfterEntry: null,
    entryConcessionAfterPriceBps: null,
    entryCostAfterPriceBps: null,
    source: input.source,
    notes,
  };

  const read = async (label: string, signature: string | null) => {
    if (!signature) return null;
    try {
      const meta = await readMeta(signature);
      if (meta === null) notes.push(`tx meta ${label} ${signature.slice(0, 8)}… unreadable: not found`);
      return meta;
    } catch (err) {
      notes.push(`tx meta ${label} ${signature.slice(0, 8)}… unreadable: ${errText(err)}`);
      return null;
    }
  };

  /* ---- the landing price, recorded whether or not the swap leg is measurable ---- */
  if (input.poolPriceAfterEntry === undefined) {
    notes.push("pool price after entry not recorded: landing concession unmeasured");
  } else if (input.poolPriceAfterEntry !== null && input.poolPriceAfterEntry > 0 && Number.isFinite(input.poolPriceAfterEntry)) {
    row.poolPriceAfterEntry = input.poolPriceAfterEntry;
  } else {
    notes.push(input.landingPriceNote ?? "pool price after entry unusable: landing concession unmeasured");
  }

  /* ---- failed open with no stored unwind signature: the recorded wallet delta is all there is ---- */
  if (!input.unwindSignature && input.recordedCostLamports !== null && input.recordedCostLamports !== undefined) {
    const cost = input.recordedCostLamports;
    let notional = input.notionalLamports;
    if (notional === null) {
      /*
       * The notional is derived, and the derivation is checked against the two live rows that
       * did open: 0,9015 SOL swapped in and 0,9 SOL deposited as the SOL leg, i.e. the position
       * is 2x the lamports the first leg spends. A failed open never got past that first leg,
       * so 2x the swap-in is the size it was sized for — recorded as derived, not as stored.
       */
      const swapMeta = await read("swap", input.swapSignature);
      if (swapMeta) {
        try {
          const spent = lamportsSpentByPayer(swapMeta);
          if (spent > 0) {
            notional = spent * 2;
            notes.push("notional derived as 2x the swap-in lamports (the open path's 0,9 SOL + 0,9 SOL split)");
          }
        } catch (err) {
          notes.push(`notional underivable: ${errText(err)}`);
        }
      }
    }
    row.notionalLamports = notional;
    row.entryCostBps = notional !== null && notional > 0 ? (cost / notional) * 10_000 : null;
    if (row.entryCostBps === null) {
      notes.push("failed open: cost recorded but the notional could not be established, so the cost stays unmeasured");
    } else {
      notes.push(
        "failed open: no unwind signature was stored, so the legs are not separated — this is the " +
          "attempt's own wallet delta (swap in + unwind + rent) over the position notional",
      );
    }
    return row;
  }

  /* ---- the swap leg ---- */
  const swap = await read("swap", input.swapSignature);
  if (!swap) return row;
  if (swap.err !== null && swap.err !== undefined) {
    notes.push(`swap tx failed on-chain: ${JSON.stringify(swap.err)}`);
    return row;
  }
  const swapFee = swap.fee;
  const payer = swap.accountKeys[0];

  /* ---- failed open: no position, no decision price -> round-trip friction only ---- */
  if (input.unwindSignature) {
    const unwind = await read("unwind", input.unwindSignature);
    if (!unwind) return row;
    let spent = 0;
    let back = 0;
    try {
      spent = lamportsSpentByPayer(swap);
      back = postOf(unwind);
    } catch (err) {
      notes.push(`round trip unmeasured: ${errText(err)}`);
      return row;
    }
    row.swapInLamports = spent;
    row.entryFeeLamports = swapFee + unwind.fee;
    row.entryCostBps = failedOpenRoundTripBps(spent, back);
    if (row.entryCostBps !== null) {
      notes.push("failed open: swap in + rescue unwind, cost per round trip — the two legs are not separated");
    }
    return row;
  }

  if (!input.mint) {
    notes.push("entry leg unmeasured: paired mint unknown");
    return row;
  }
  let spent = 0;
  try {
    spent = lamportsSpentByPayer(swap);
  } catch (err) {
    notes.push(`entry leg unmeasured: ${errText(err)}`);
    return row;
  }
  if (!(spent > 0)) {
    notes.push("entry leg unmeasured: the swap spent no SOL from the payer");
    return row;
  }
  const received = payer ? tokenReceivedByOwner(swap, input.mint, payer) : null;
  if (!received || received.amount <= 0n) {
    notes.push("entry leg unmeasured: no token balance change for the paired mint in the swap tx");
    return row;
  }
  row.swapInLamports = spent;
  row.tokensReceived = received.amount.toString();
  row.entryFeeLamports = swapFee;
  notes.push("entry fee covers the swap tx only; the open (add-liquidity) tx fee is not summed here");

  const solIsQuote = solIsQuoteFromPairName(input.pairName);
  if (solIsQuote === null) {
    notes.push("expected tokens unmeasured: cannot tell which side of the pair SOL is");
    return row;
  }
  const receivedTokens = Number(received.amount);

  // Landing-price concession first and independently: a missing DECISION price must not hide it.
  if (row.poolPriceAfterEntry !== null) {
    const expectedAfter = tokensAtPoolPrice(spent, received.decimals, row.poolPriceAfterEntry, solIsQuote);
    if (expectedAfter !== null && expectedAfter > 0) {
      const gapAfter = expectedAfter - receivedTokens;
      row.entryConcessionAfterPriceBps = (gapAfter / expectedAfter) * 10_000;
      row.entryCostAfterPriceBps = costBpsOfNotional(
        gapAfter,
        received.decimals,
        row.poolPriceAfterEntry,
        solIsQuote,
        input.notionalLamports,
      );
    }
  }

  if (input.poolPriceAtEntry === null) {
    notes.push("entry concession unmeasured: no pool price recorded at the entry decision");
    return row;
  }
  const expected = tokensAtPoolPrice(spent, received.decimals, input.poolPriceAtEntry, solIsQuote);
  if (expected === null || !(expected > 0)) {
    notes.push("entry concession unmeasured: unusable pool price");
    return row;
  }
  row.expectedTokens = Math.round(expected).toString();
  const gap = expected - receivedTokens;
  row.entryConcessionBps = (gap / expected) * 10_000;
  row.entryCostBps = costBpsOfNotional(
    gap,
    received.decimals,
    input.poolPriceAtEntry,
    solIsQuote,
    input.notionalLamports,
  );
  if (row.entryCostBps === null) notes.push("entry_cost_bps unmeasured: notional unknown");
  notes.push("pool price is the one recorded at the entry DECISION, not at the swap's landing");
  return row;
}

/** A token gap valued at the pool price, as bps of the position notional. */
function costBpsOfNotional(
  gapTokens: number,
  decimals: number,
  poolPrice: number,
  solIsQuote: boolean,
  notionalLamports: number | null,
): number | null {
  if (notionalLamports === null || !(notionalLamports > 0)) return null;
  const solPerToken = solIsQuote ? poolPrice : 1 / poolPrice;
  if (!(solPerToken > 0) || !Number.isFinite(solPerToken)) return null;
  const gapLamports = (gapTokens / 10 ** decimals) * solPerToken * LAMPORTS_PER_SOL;
  return (gapLamports / notionalLamports) * 10_000;
}

function postOf(meta: TransactionMetaReading): number {
  const pre = meta.preBalances[0];
  const post = meta.postBalances[0];
  if (pre === undefined || post === undefined) throw new Error("meta carries no fee-payer balance");
  return post - pre + meta.fee;
}
