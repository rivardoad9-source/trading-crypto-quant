/**
 * Entry economics — what a live entry actually cost, measured from transaction meta.
 *
 * Same rule as the exit side: an unmeasured quantity is NULL with a note, never 0. And the
 * sign convention is fixed here too — positive bps always means "worse than the recorded
 * price", which on a BUY is more tokens paid than the decision price implied.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-entryecon-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Econ = typeof import("../services/entryEconomics.js");
type Backfill = typeof import("../services/entryEconomicsBackfill.js");
type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");
type Meta = import("../services/solana.js").TransactionMetaReading;

let econ: Econ;
let backfill: Backfill;
let repos: Repos;
let dbModule: Db;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  econ = await import("../services/entryEconomics.js");
  backfill = await import("../services/entryEconomicsBackfill.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* the temp dir is disposable */
  }
});

const MINT = "EmberMint1111111111111111111111111111111111";
const OWNER = "Wallet111111111111111111111111111111111111";
const LAMPORTS = 1_000_000_000;

/** A buy: `spentLamports` out of the payer, `receivedTokens` (human, 6 decimals) in. */
function buyMeta(spentLamports: number, receivedTokens: number, decimals = 6): Meta {
  const raw = Math.round(receivedTokens * 10 ** decimals).toString();
  return {
    accountKeys: [OWNER, "pool"],
    fee: 5_000,
    err: null,
    preBalances: [10 * LAMPORTS, 0],
    postBalances: [10 * LAMPORTS - spentLamports - 5_000, 0],
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: "0", decimals } }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: raw, decimals } }],
  };
}

const readerOf = (metas: Record<string, Meta | null>) => async (sig: string) => metas[sig] ?? null;

describe("lamportsSpentByPayer / tokenReceivedByOwner", () => {
  it("excludes the transaction fee from what the swap spent", () => {
    const meta = buyMeta(1 * LAMPORTS, 5_000);
    assert.equal(econ.lamportsSpentByPayer(meta), 1 * LAMPORTS);
    assert.equal(econ.tokenReceivedByOwner(meta, MINT, OWNER)?.amount, 5_000_000_000n);
  });

  it("returns null when the mint never appears in the token balances", () => {
    assert.equal(econ.tokenReceivedByOwner(buyMeta(1 * LAMPORTS, 1), "OtherMint", OWNER), null);
  });

  it("throws when there is no payer balance to read", () => {
    const meta = { ...buyMeta(1 * LAMPORTS, 1), preBalances: [], postBalances: [] };
    assert.throws(() => econ.lamportsSpentByPayer(meta));
  });
});

describe("tokensAtPoolPrice", () => {
  it("SOL as quote: price is SOL per token", () => {
    // 1 SOL at 0,0002 SOL/token = 5 000 tokens
    assert.equal(econ.tokensAtPoolPrice(1 * LAMPORTS, 6, 0.0002, true), 5_000 * 10 ** 6);
  });

  it("SOL as base: price is token per SOL and inverts", () => {
    // 1 SOL at 5 000 token/SOL = 5 000 tokens
    assert.equal(econ.tokensAtPoolPrice(1 * LAMPORTS, 6, 5_000, false), 5_000 * 10 ** 6);
  });

  it("refuses an unusable price instead of inventing one", () => {
    assert.equal(econ.tokensAtPoolPrice(1 * LAMPORTS, 6, 0, true), null);
    assert.equal(econ.tokensAtPoolPrice(1 * LAMPORTS, 6, Number.NaN, true), null);
  });
});

describe("measureEntryEconomics", () => {
  const base = {
    positionId: "pos-1",
    pairName: "EMBER-SOL",
    mint: MINT,
    binStep: 200,
    // 2 SOL position: the swap spends half of it, the other half stays as SOL in the bins.
    notionalLamports: 2 * LAMPORTS,
    tvlUsdAtEntry: 60_000,
    poolPriceAtEntry: 0.0002,
    swapSignature: "swap-sig",
    openSignature: "open-sig",
    source: "backfill" as const,
  };

  it("measures the concession when the fill is worse than the decision price", async () => {
    // Should have bought 5 000 tokens, got 4 950: 1% short.
    const row = await econ.measureEntryEconomics(base, readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_950) }));
    assert.equal(row.expectedTokens, "5000000000");
    assert.equal(row.tokensReceived, "4950000000");
    assert.ok(row.entryConcessionBps !== null && Math.abs(row.entryConcessionBps - 100) < 1e-9);
    // 50 tokens at 0,0002 SOL = 0,01 SOL against a 2 SOL notional = 0,5% = 50 bps.
    assert.ok(row.entryCostBps !== null && Math.abs(row.entryCostBps - 50) < 1e-9);
    assert.equal(row.entryFeeLamports, 5_000);
  });

  it("records a favourable fill as negative bps — better than the recorded price", async () => {
    const row = await econ.measureEntryEconomics(base, readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 5_050) }));
    assert.ok(row.entryConcessionBps !== null && row.entryConcessionBps < 0);
  });

  it("keeps null with a note when the decision price was never recorded", async () => {
    const row = await econ.measureEntryEconomics(
      { ...base, poolPriceAtEntry: null },
      readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_950) }),
    );
    assert.equal(row.entryConcessionBps, null);
    assert.equal(row.entryCostBps, null);
    assert.equal(row.tokensReceived, "4950000000");
    assert.ok(row.notes.some((n) => n.includes("no pool price recorded at the entry decision")));
  });

  it("keeps the landing concession even when the decision price is missing", async () => {
    const row = await econ.measureEntryEconomics(
      { ...base, poolPriceAtEntry: null, poolPriceAfterEntry: 0.0002 },
      readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_950) }),
    );
    assert.ok(row.entryConcessionAfterPriceBps !== null && Math.abs(row.entryConcessionAfterPriceBps - 100) < 1e-9);
    assert.equal(row.entryConcessionBps, null);
  });

  it("never 0 when the swap tx cannot be read", async () => {
    const row = await econ.measureEntryEconomics(base, readerOf({ "swap-sig": null }));
    assert.equal(row.entryCostBps, null);
    assert.equal(row.swapInLamports, null);
    assert.ok(row.notes.some((n) => n.includes("unreadable")));
  });

  it("says so when the paired mint is unknown rather than measuring nothing silently", async () => {
    const row = await econ.measureEntryEconomics(
      { ...base, mint: null },
      readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_950) }),
    );
    assert.equal(row.entryCostBps, null);
    assert.ok(row.notes.some((n) => n.includes("paired mint unknown")));
  });

  it("measures a failed open with no unwind signature from the recorded cost and a derived notional", async () => {
    // Swap spent 1 SOL -> notional derived 2 SOL; the attempt cost the wallet 0,12 SOL = 600 bps.
    const row = await econ.measureEntryEconomics(
      { ...base, poolPriceAtEntry: null, notionalLamports: null, recordedCostLamports: 0.12 * LAMPORTS },
      readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 5_000) }),
    );
    assert.equal(row.notionalLamports, 2 * LAMPORTS);
    assert.ok(row.entryCostBps !== null && Math.abs(row.entryCostBps - 600) < 1e-6);
    assert.ok(row.notes.some((n) => n.includes("notional derived as 2x")));
    assert.ok(row.notes.some((n) => n.includes("legs are not separated")));
    // No price reference existed, so no concession is claimed.
    assert.equal(row.entryConcessionBps, null);
  });

  it("keeps a recorded failed-open cost unmeasured when the notional cannot be established", async () => {
    const row = await econ.measureEntryEconomics(
      { ...base, poolPriceAtEntry: null, notionalLamports: null, recordedCostLamports: 0.12 * LAMPORTS },
      readerOf({ "swap-sig": null }),
    );
    assert.equal(row.entryCostBps, null);
    assert.ok(row.notes.some((n) => n.includes("could not be established")));
  });

  it("measures a failed open as a round-trip, and says the legs are not separated", async () => {
    const swap: Meta = {
      ...buyMeta(1 * LAMPORTS, 5_000),
      preBalances: [3 * LAMPORTS],
      postBalances: [2 * LAMPORTS - 5_000],
    };
    const unwind: Meta = {
      ...buyMeta(1, 0),
      accountKeys: [OWNER, "pool"],
      preBalances: [2 * LAMPORTS],
      postBalances: [2 * LAMPORTS + Math.round(0.95 * LAMPORTS) - 5_000],
    };
    const row = await econ.measureEntryEconomics(
      { ...base, poolPriceAtEntry: null, unwindSignature: "unwind-sig" },
      readerOf({ "swap-sig": swap, "unwind-sig": unwind }),
    );
    assert.ok(row.entryCostBps !== null && Math.abs(row.entryCostBps - 500) < 1);
    assert.equal(row.entryConcessionBps, null);
    assert.ok(row.notes.some((n) => n.includes("failed open")));
  });
});

describe("runEntryEconomicsBackfill", () => {
  const candidate = {
    positionId: "backfill-pos-1",
    pairName: "EMBER-SOL",
    poolAddress: "PoolAddr111111111111111111111111111111111",
    mint: MINT,
    notionalLamports: 2 * LAMPORTS,
    tvlUsdAtEntry: 60_000,
    poolPriceAtEntry: 0.0002,
    swapSignature: "swap-sig",
    openSignature: "open-sig",
    attemptedAtMs: 1_000,
  };

  it("inserts once and skips the second run", async () => {
    const deps = {
      readMeta: readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_950) }),
      readPool: async () => ({ binStep: 200, tvlUsd: 60_000, currentPrice: 0.00021 }),
      insert: (row: import("../services/entryEconomics.js").EntryEconomicsRow) => repos.insertEntryEconomicsIfAbsent(row),
      now: () => 1_000 + 60_000,
    };
    const first = await backfill.runEntryEconomicsBackfill([candidate], deps);
    assert.equal(first.inserted, 1);
    assert.equal(first.skipped, 0);
    const second = await backfill.runEntryEconomicsBackfill([candidate], deps);
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(repos.listEntryEconomics().length, 1);
  });

  it("refuses a landing price read past the freshness budget but still takes the bin step", async () => {
    let poolReads = 0;
    const result = await backfill.runEntryEconomicsBackfill(
      [{ ...candidate, positionId: "stale-pos", tvlUsdAtEntry: null }],
      {
        readMeta: readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_950) }),
        readPool: async () => {
          poolReads += 1;
          return { binStep: 200, tvlUsd: 60_000, currentPrice: 0.00021 };
        },
        insert: () => true,
        now: () => 1_000 + 60 * 60 * 1000,
      },
      { write: false },
    );
    const row = result.rows[0];
    assert.ok(row);
    assert.equal(poolReads, 1, "bin_step does not age, so the pool is still read");
    assert.equal(row.binStep, 200);
    assert.equal(row.poolPriceAfterEntry, null, "a stale price is not a landing price");
    assert.equal(row.tvlUsdAtEntry, null, "TVL read an hour late is not the entry TVL");
    assert.ok(row.notes.some((n) => n.includes("freshness budget")));
    assert.ok(row.notes.some((n) => n.includes("not the entry TVL")));
    assert.ok(row.entryConcessionBps !== null);
  });

  it("writes nothing when the caller asks for a dry run", async () => {
    const result = await backfill.runEntryEconomicsBackfill(
      [{ ...candidate, positionId: "dry-run-pos" }],
      {
        readMeta: readerOf({ "swap-sig": buyMeta(1 * LAMPORTS, 4_900) }),
        readPool: async () => null,
        insert: () => {
          throw new Error("dry run must not insert");
        },
        now: () => 2_000,
      },
      { write: false },
    );
    assert.equal(result.inserted, 0);
    assert.equal(result.rows.length, 1);
  });
});
