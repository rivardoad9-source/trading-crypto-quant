/**
 * Exit economics — what a live exit actually cost, measured from transaction meta.
 *
 * The rule under test everywhere: an unmeasured quantity is NULL with a note, never 0. A
 * zero exit cost is a real, strongly optimistic claim, and the whole point of this ledger is
 * to stop the backtest's exit model resting on numbers nobody measured.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-exitecon-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Econ = typeof import("../services/exitEconomics.js");
type Backfill = typeof import("../services/exitEconomicsBackfill.js");
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
  econ = await import("../services/exitEconomics.js");
  backfill = await import("../services/exitEconomicsBackfill.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows can hold the temp dir; a leftover temp dir is not a test result.
  }
});

const WALLET = "Wa11et1111111111111111111111111111111111111";
const MINT = "EMBERmint11111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

/** A sweep: 4,498,666,263 EMBER (6 dp) out of the wallet, 786,995,667 lamports in, fee 5,000. */
function sweepMeta(over: Partial<Meta> = {}): Meta {
  return {
    accountKeys: [WALLET, "ata1"],
    fee: 5_000,
    err: null,
    preBalances: [2_000_000_000, 0],
    postBalances: [2_000_000_000 + 786_995_667 - 5_000, 0],
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "4498666263", decimals: 6 } }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, uiTokenAmount: { amount: "0", decimals: 6 } }],
    ...over,
  };
}

const feeOnly = (fee: number): Meta => ({
  accountKeys: [WALLET],
  fee,
  err: null,
  preBalances: [1_000_000],
  postBalances: [1_000_000 - fee],
  preTokenBalances: [],
  postTokenBalances: [],
});

const input = (over: Partial<import("../services/exitEconomics.js").ExitMeasurementInput> = {}) => ({
  positionId: "pos-5",
  pairName: "EMBER-SOL",
  mint: MINT,
  binStep: 200,
  notionalLamports: 1_800_000_000,
  tvlUsdAtExit: null,
  entryTvlUsd: 82_785,
  poolPriceAtExit: 0.000182131568819979,
  residualSweep: "swept",
  sweepRoute: "jupiter" as const,
  sweepSlippageBpsUsed: 50,
  closeSignature: "CLOSEsig",
  sweepSignature: "SWEEPsig",
  ataCloseSignature: "ATAsig",
  source: "live" as const,
  ...over,
});

const reader = (metas: Record<string, Meta | null | Error>) => async (sig: string) => {
  const m = metas[sig];
  if (m instanceof Error) throw m;
  return m ?? null;
};

describe("transaction meta parsing", () => {
  it("reads SOL received net of the fee the payer paid, and the token that left the wallet", () => {
    const m = sweepMeta();
    assert.equal(econ.lamportsReceivedByPayer(m), 786_995_667);
    assert.deepEqual(econ.tokenSpentByOwner(m, MINT, WALLET), { amount: 4_498_666_263n, decimals: 6 });
    assert.equal(econ.tokenSpentByOwner(m, MINT, "someoneElse"), null, "another owner's balances are not ours");
  });

  it("values at the pool price on either side of the pair", () => {
    // EMBER-SOL: SOL is the quote, price is SOL per EMBER.
    assert.equal(econ.valueAtPoolPriceLamports(4_498_666_263n, 6, 0.000182131568819979, true), 819_349_144);
    // SOL-X: price is X per SOL, inverted.
    assert.equal(econ.valueAtPoolPriceLamports(2_000_000n, 6, 2, false), 1_000_000_000);
    assert.equal(econ.valueAtPoolPriceLamports(1n, 6, 0, true), null);
    assert.deepEqual(
      ["EMBER-SOL", "SOL-USDC", "OPENAI-USDC"].map(econ.solIsQuoteFromPairName),
      [true, false, null],
    );
  });
});

describe("measureExitEconomics", () => {
  it("derives the EMBER #5 figures the trade doc reports (3.95% under the pool price)", async () => {
    const row = await econ.measureExitEconomics(
      input(),
      reader({ CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) }),
    );
    assert.equal(row.sweepInAmount, "4498666263");
    assert.equal(row.sweepOutLamports, 786_995_667);
    assert.equal(row.expectedOutLamports, 819_349_144);
    assert.equal(row.exitFeeLamports, 20_000);
    assert.ok(Math.abs(row.sweepConcessionBps! - 394.87) < 0.05, `concession ${row.sweepConcessionBps}`);
    assert.ok(Math.abs(row.exitCostBps! - (32_353_477 / 1_800_000_000) * 10_000) < 1e-9);
  });

  it("a FAILED or missing sweep is null with a note — never a zero-cost exit", async () => {
    for (const residualSweep of ["failed", "dust", "operator", "unmeasured"]) {
      const row = await econ.measureExitEconomics(
        input({ residualSweep, sweepSignature: null, ataCloseSignature: null }),
        reader({ CLOSEsig: feeOnly(10_000) }),
      );
      assert.equal(row.exitCostBps, null, residualSweep);
      assert.equal(row.sweepOutLamports, null);
      assert.equal(row.expectedOutLamports, null);
      assert.equal(row.exitFeeLamports, 10_000, "the close fee is still measured");
      assert.ok(row.notes.some((n) => n.includes(`residual_sweep=${residualSweep}`)));
    }
  });

  it("an UNREADABLE tx makes the fee null and names the signature and the error", async () => {
    const row = await econ.measureExitEconomics(
      input(),
      reader({ CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: new Error("429 Too Many Requests") }),
    );
    assert.equal(row.exitFeeLamports, null);
    assert.ok(row.notes.some((n) => /tx meta ata_close ATAsig.* unreadable: 429 Too Many Requests/.test(n)));
    // The sweep itself was readable, so the cost is still measured.
    assert.notEqual(row.exitCostBps, null);
  });

  it("an unreadable SWEEP tx leaves the cost null, not zero", async () => {
    const row = await econ.measureExitEconomics(input(), reader({ CLOSEsig: feeOnly(1), SWEEPsig: null, ATAsig: feeOnly(1) }));
    assert.equal(row.exitCostBps, null);
    assert.equal(row.exitFeeLamports, null);
    assert.ok(row.notes.some((n) => /tx meta sweep .* not found/.test(n)));
  });

  it("a sweep that reverted on-chain is not a measurement", async () => {
    const row = await econ.measureExitEconomics(
      input(),
      reader({ CLOSEsig: feeOnly(1), SWEEPsig: sweepMeta({ err: { InstructionError: [0, "x"] } }), ATAsig: feeOnly(1) }),
    );
    assert.equal(row.exitCostBps, null);
    assert.ok(row.notes.some((n) => n.startsWith("sweep tx failed on-chain")));
  });

  it("the failed-open round trip removes the transfer fee from both legs, per leg", async () => {
    const swap: Meta = { ...feeOnly(10_000), preBalances: [3_000_000_000], postBalances: [3_000_000_000 - 901_586_000 - 10_000] };
    const unwind: Meta = { ...feeOnly(14_000), preBalances: [2_000_000_000], postBalances: [2_000_000_000 + 822_476_000 - 14_000] };
    const row = await econ.measureFailedOpenRoundTrip(
      { positionId: "attempt-5", pairName: "NEARKAT-SOL", mint: MINT, binStep: 400, entryTvlUsd: null, swapSignature: "S", unwindSignature: "U", transferFeeBps: 300 },
      reader({ S: swap, U: unwind }),
    );
    assert.equal(row.notionalLamports, 901_586_000);
    assert.equal(row.exitFeeLamports, 24_000);
    assert.ok(Math.abs(row.exitCostBps! - 143.2) < 0.2, `per leg ${row.exitCostBps}`);

    const unknownFee = await econ.measureFailedOpenRoundTrip(
      { positionId: "attempt-5", pairName: "NEARKAT-SOL", mint: MINT, binStep: 400, entryTvlUsd: null, swapSignature: "S", unwindSignature: "U", transferFeeBps: null },
      reader({ S: swap, U: unwind }),
    );
    assert.equal(unknownFee.exitCostBps, null, "without the transfer fee the bin-step part cannot be separated");
  });
});

describe("the live write and the backfill", () => {
  it("recordLiveExitEconomics never throws, and writes a row even when the pool read fails", async () => {
    const written: Array<import("../services/exitEconomics.js").ExitEconomicsRow> = [];
    const row = await econ.recordLiveExitEconomics(
      { ...input({ positionId: "live-1" }), poolAddress: "P" },
      {
        readMeta: reader({ CLOSEsig: feeOnly(1), SWEEPsig: sweepMeta(), ATAsig: feeOnly(1) }),
        readPool: async () => {
          throw new Error("meteora down");
        },
        insert: (r) => {
          written.push(r);
          return true;
        },
      },
    );
    assert.equal(written.length, 1);
    assert.equal(row?.binStep, null);
    assert.equal(row?.source, "live");
    assert.match(row!.notes[0]!, /pool unreadable at exit/);

    const exploded = await econ.recordLiveExitEconomics(
      { ...input({ positionId: "live-2" }), poolAddress: "P" },
      { readMeta: reader({}), readPool: async () => null, insert: () => { throw new Error("disk full"); } },
    );
    assert.equal(exploded, null, "a failed write is logged, never thrown into the close");
  });

  it("backfill is idempotent: a second run inserts nothing and keeps the first measurement", async () => {
    const positions = [
      {
        position_id: "bf-1", pool_address: "P", pair_name: "EMBER-SOL", virtual_sol_amount: 1.8, entry_tvl: 82_785,
        exit_price: 0.000182131568819979, residual_sweep: "swept", close_signature: "CLOSEsig", sweep_signature: "SWEEPsig", ata_close_signature: "ATAsig",
      },
    ];
    const deps = {
      readMeta: reader({ CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) }),
      readPool: async () => ({ binStep: 200, baseMint: MINT, quoteMint: WSOL }),
      readTransferFeeBps: async () => 0,
      insert: repos.insertExitEconomicsIfAbsent,
    };
    const first = await backfill.runExitEconomicsBackfill(positions, [], deps);
    const second = await backfill.runExitEconomicsBackfill(positions, [], deps);
    assert.deepEqual([first.inserted, first.skipped], [1, 0]);
    assert.deepEqual([second.inserted, second.skipped], [0, 1]);
    const stored = repos.listExitEconomics().filter((r) => r.position_id === "bf-1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.expected_out_lamports, 819_349_144);
    assert.equal(stored[0]!.source, "backfill");
  });

  it("stores null — not 0 — for every unmeasured column", async () => {
    await backfill.runExitEconomicsBackfill(
      [{ position_id: "bf-null", pool_address: "P", pair_name: "MANLET-SOL", virtual_sol_amount: 1.8, entry_tvl: null, exit_price: 0.0000121, residual_sweep: "operator", close_signature: "C", sweep_signature: null, ata_close_signature: null }],
      [],
      { readMeta: reader({ C: new Error("timeout") }), readPool: async () => null, readTransferFeeBps: async () => 0, insert: repos.insertExitEconomicsIfAbsent },
    );
    const r = repos.listExitEconomics().find((x) => x.position_id === "bf-null")!;
    assert.deepEqual(
      [r.exit_cost_bps, r.exit_fee_lamports, r.sweep_out_lamports, r.bin_step, r.expected_out_lamports],
      [null, null, null, null, null],
    );
    assert.match(r.notes ?? "", /unreadable: timeout/);
  });

  it("reads closed LIVE rows out of the trades export, quoted commas and all", () => {
    const csv =
      'position_id,pool_address,pair_name,virtual_sol_amount,entry_tvl,exit_price,execution_mode,status,residual_sweep,close_signature,sweep_signature,ata_close_signature,reasoning_log\n' +
      'a,P,EMBER-SOL,1.8,82785,0.00018,LIVE,CLOSED_PROFIT,swept,C,S,,"fee, volume, ""quoted""\nline two"\n' +
      "b,P,X-SOL,1,,,PAPER,CLOSED_PROFIT,,C2,,,\n" +
      "c,P,Y-SOL,1,,,LIVE,ACTIVE,,,,,\n";
    const rows = backfill.closedLiveFromCsv(backfill.parseCsv(csv));
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0]!.position_id, rows[0]!.entry_tvl, rows[0]!.ata_close_signature, rows[0]!.sweep_signature],
      ["a", 82_785, null, "S"],
    );
  });
});

describe("the calibration report's arithmetic", () => {
  it("builds observations only from measured rows, and bootstraps deterministically", async () => {
    const cost = await import("../backtest/exitCost.js");
    const base = { pair_name: "EMBER-SOL", expected_out_lamports: 800_000_000, tvl_usd_at_exit: null, entry_tvl_usd: 80_000, source: "backfill" };
    const { observations, excluded } = cost.observationsFromLedger(
      [
        { ...base, position_id: "m1", bin_step: 200, sweep_concession_bps: 395 },
        { ...base, position_id: "m2", bin_step: 200, sweep_concession_bps: null },
        { ...base, position_id: "m3", bin_step: null, sweep_concession_bps: 100 },
      ],
      100,
    );
    assert.equal(observations.length, 1);
    assert.deepEqual(excluded.map((e) => e.why), ["concession unmeasured", "bin_step unmeasured"]);
    assert.ok(Math.abs(observations[0]!.shareOfTvlPct - 0.1) < 1e-9, "0.8 SOL x $100 / $80k = 0.1%");
    assert.match(observations[0]!.source, /entry proxy/);

    const obs = cost.LIVE_EXIT_OBSERVATIONS;
    const a = cost.bootstrapSlopeStability(obs, [3, 12, 48], 400, 7);
    const b = cost.bootstrapSlopeStability(obs, [3, 12, 48], 400, 7);
    assert.deepEqual(a, b, "seeded, so the report is reproducible");
    assert.ok(a[0]!.standardError > a[2]!.standardError, "more observations, smaller error");
    const need = cost.observationsNeededFor(a, 0.01);
    assert.ok(need && need.extrapolated && need.n > 48);
  });
});

describe("where the live write sits", () => {
  it("runs in settleLiveCloses AFTER the position row is closed and outside the mutex", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "dlmmTraderAgent.ts"), "utf8");
    const start = src.indexOf("async function settleLiveCloses(");
    const body = src.slice(start, src.indexOf("async function settleClosedPositions(", start));
    const closeWrite = body.indexOf("closePosition({");
    const mutexEnd = body.indexOf("});", body.indexOf("settleOpenedLiveAttempt("));
    const record = body.indexOf("await recordExit?.({");
    assert.ok(closeWrite > 0 && record > mutexEnd && mutexEnd > closeWrite, "row closed, mutex released, then measured");
    assert.equal((src.match(/recordExit\?\.\(\{/g) ?? []).length, 1, "one write path, not a second weaker one");
  });
});

describe("exit-cost completeness (WO3 B): every close tx, and the landing price", () => {
  const sweepAt = (price: number) => ({ binStep: 200, tvlUsd: 80_000, currentPrice: price });

  it("(a) the fee sums EVERY close tx + sweep + ata_close, and never counts the final one twice", async () => {
    const row = await econ.measureExitEconomics(
      // The executor's list already ends with the final signature; it must not be read twice.
      input({ closeSignatures: ["C1", "C2", "CLOSEsig"] }),
      reader({ C1: feeOnly(7_000), C2: feeOnly(9_000), CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) }),
    );
    assert.equal(row.exitFeeLamports, 7_000 + 9_000 + 10_000 + 5_000 + 5_000);
    assert.deepEqual(row.closeSignatures, ["C1", "C2", "CLOSEsig"]);
    assert.ok(row.notes.some((n) => /all 3 close tx/.test(n)));
    assert.equal(row.notes.some((n) => /FINAL close tx only/.test(n)), false);

    // A list that omits the final signature gets it appended, once.
    const appended = await econ.measureExitEconomics(
      input({ closeSignatures: ["C1"] }),
      reader({ C1: feeOnly(7_000), CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) }),
    );
    assert.deepEqual(appended.closeSignatures, ["C1", "CLOSEsig"]);
    assert.equal(appended.exitFeeLamports, 7_000 + 10_000 + 5_000 + 5_000);

    // One unreadable earlier close tx makes the whole fee null, naming it.
    const partial = await econ.measureExitEconomics(
      input({ closeSignatures: ["C1", "CLOSEsig"] }),
      reader({ C1: new Error("429"), CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) }),
    );
    assert.equal(partial.exitFeeLamports, null);
    assert.ok(partial.notes.some((n) => /tx meta close 1\/2 C1.* unreadable: 429/.test(n)));
  });

  it("without close_signatures (backfill) the old single-tx behaviour and its note stand", async () => {
    const row = await econ.measureExitEconomics(input(), reader({ CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) }));
    assert.equal(row.closeSignatures, null);
    assert.equal(row.exitFeeLamports, 20_000);
    assert.ok(row.notes.some((n) => /FINAL close tx only/.test(n)));
    assert.ok(row.notes.some((n) => /close_signatures not recorded/.test(n)));
    assert.equal(row.poolPriceAfterSweep, null);
    assert.equal(row.sweepConcessionAfterSweepBps, null);
    assert.ok(row.notes.some((n) => /pool price after sweep not recorded/.test(n)));
  });

  it("the landing concession is ADDITIVE: the decision-price columns keep their exact values", async () => {
    const metas = { CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) };
    const before = await econ.measureExitEconomics(input(), reader(metas));
    const landed = 0.000180; // the pool moved down between the decision and the sale
    const row = await econ.recordLiveExitEconomics(
      { ...input({ positionId: "live-landing", closeSignatures: ["CLOSEsig"] }), poolAddress: "P" },
      { readMeta: reader(metas), readPool: async () => sweepAt(landed), insert: () => true },
    );
    assert.equal(row!.sweepConcessionBps, before.sweepConcessionBps, "the calibrated column is unchanged");
    assert.equal(row!.exitCostBps, before.exitCostBps);
    assert.equal(row!.poolPriceAfterSweep, landed);
    const expectedAfter = econ.valueAtPoolPriceLamports(4_498_666_263n, 6, landed, true)!;
    assert.ok(Math.abs(row!.sweepConcessionAfterSweepBps! - ((expectedAfter - 786_995_667) / expectedAfter) * 10_000) < 1e-9);
    assert.ok(row!.sweepConcessionAfterSweepBps! < row!.sweepConcessionBps!, "a lower landing price leaves less concession");
  });

  it("(c) an unreadable landing price is NULL with a note — never 0", async () => {
    const metas = { CLOSEsig: feeOnly(1), SWEEPsig: sweepMeta(), ATAsig: feeOnly(1) };
    for (const readPool of [
      async () => null,
      async () => {
        throw new Error("meteora down");
      },
      async () => sweepAt(0),
      async () => ({ binStep: 200, tvlUsd: 1 }),
    ]) {
      const row = await econ.recordLiveExitEconomics(
        { ...input({ positionId: "live-noland" }), poolAddress: "P" },
        { readMeta: reader(metas), readPool, insert: () => true },
      );
      assert.equal(row!.poolPriceAfterSweep, null);
      assert.equal(row!.sweepConcessionAfterSweepBps, null);
      assert.equal(row!.exitCostAfterSweepBps, null);
      assert.ok(row!.notes.some((n) => /landing concession unmeasured/.test(n)), row!.notes.join(" | "));
      assert.notEqual(row!.sweepConcessionBps, null, "the decision-price measurement is unaffected");
    }
  });

  it("the dlmm-pool route's slippage is labelled as the ladder CAP, not a rung that sold", async () => {
    const row = await econ.measureExitEconomics(
      input({ sweepRoute: "dlmm-pool", sweepSlippageBpsUsed: 300 }),
      reader({ CLOSEsig: feeOnly(1), SWEEPsig: sweepMeta(), ATAsig: feeOnly(1) }),
    );
    assert.ok(row.notes.some((n) => /ladder's CAP/.test(n)));
    const jup = await econ.measureExitEconomics(input(), reader({ CLOSEsig: feeOnly(1), SWEEPsig: sweepMeta(), ATAsig: feeOnly(1) }));
    assert.equal(jup.notes.some((n) => /ladder's CAP/.test(n)), false);
  });

  it("stores the new columns — JSON list, landing price — and null (not 0) when absent", async () => {
    const metas = { C1: feeOnly(3), CLOSEsig: feeOnly(10_000), SWEEPsig: sweepMeta(), ATAsig: feeOnly(5_000) };
    await econ.recordLiveExitEconomics(
      { ...input({ positionId: "db-live", closeSignatures: ["C1", "CLOSEsig"] }), poolAddress: "P" },
      { readMeta: reader(metas), readPool: async () => sweepAt(0.00018), insert: repos.insertExitEconomicsIfAbsent },
    );
    const r = repos.listExitEconomics().find((x) => x.position_id === "db-live")!;
    assert.deepEqual(JSON.parse(r.close_signatures!), ["C1", "CLOSEsig"]);
    assert.equal(r.pool_price_after_sweep, 0.00018);
    assert.equal(r.exit_fee_lamports, 3 + 10_000 + 5_000 + 5_000);
    assert.equal(typeof r.sweep_concession_after_sweep_bps, "number");

    const bf = repos.listExitEconomics().find((x) => x.position_id === "bf-1");
    if (bf) {
      assert.deepEqual([bf.close_signatures, bf.pool_price_after_sweep, bf.sweep_concession_after_sweep_bps], [null, null, null]);
    }
  });

  it("settleLiveCloses hands the recorder EVERY close signature, not only the final one", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "dlmmTraderAgent.ts"), "utf8");
    const call = src.slice(src.indexOf("await recordExit?.({"), src.indexOf("closed++;", src.indexOf("await recordExit?.({")));
    assert.match(call, /closeSignatures: signatures,/);
    assert.match(src, /const \{ closeSignature, signatures, walletLamportsAfter/);
  });

  it("(d) the report prints BOTH concessions, and — where the landing price was never measured", async () => {
    const { renderConcessionComparison } = await import("../scripts/reportExitCosts.js");
    const base = {
      pair_name: "EMBER-SOL", mint: MINT, bin_step: 200, notional_lamports: 1, tvl_usd_at_exit: null, entry_tvl_usd: null,
      pool_price_at_exit: 1, sweep_route: "jupiter", sweep_slippage_bps_used: null, sweep_in_amount: null, sweep_out_lamports: null,
      expected_out_lamports: null, exit_fee_lamports: 20_000, exit_cost_bps: null, source: "live", measured_at: "2026-09-14 00:00:00",
      notes: null, exit_cost_after_sweep_bps: null,
    };
    const text = renderConcessionComparison([
      { ...base, position_id: "new-row", sweep_concession_bps: 394.9, sweep_concession_after_sweep_bps: 250.4, close_signatures: '["a","b"]', pool_price_after_sweep: 1 },
      { ...base, position_id: "old-row", sweep_concession_bps: 180.6, sweep_concession_after_sweep_bps: null, close_signatures: null, pool_price_after_sweep: null, source: "backfill" },
    ]);
    assert.match(text, /concession @decision/);
    assert.match(text, /concession @landing/);
    const newLine = text.split("\n").find((l) => l.includes("new-row"))!;
    assert.match(newLine, /394\.9 bps.*250\.4 bps.*-144\.5 bps/);
    const oldLine = text.split("\n").find((l) => l.includes("old-row"))!;
    assert.match(oldLine, /180\.6 bps/);
    assert.equal(/0\.0 bps/.test(oldLine), false, "an unmeasured landing concession is not rendered as zero");
  });
});

describe("(b) migration: an exit_economics table that already holds rows gains the new columns", () => {
  it("adds every column through initDatabase and leaves the existing rows exactly as they were", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "flowmetrix-exitecon-mig-"));
    const dbPath = join(dir, "old.db");
    const script = `
      const Database = require("better-sqlite3");
      const old = new Database(${JSON.stringify(dbPath)});
      old.exec(\`CREATE TABLE exit_economics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, position_id TEXT NOT NULL UNIQUE, pair_name TEXT, mint TEXT,
        bin_step INTEGER, notional_lamports INTEGER, tvl_usd_at_exit REAL, entry_tvl_usd REAL, pool_price_at_exit REAL,
        sweep_route TEXT, sweep_slippage_bps_used INTEGER, sweep_in_amount TEXT, sweep_out_lamports INTEGER,
        expected_out_lamports INTEGER, exit_fee_lamports INTEGER, exit_cost_bps REAL, sweep_concession_bps REAL,
        source TEXT NOT NULL, measured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, notes TEXT)\`);
      const ins = old.prepare("INSERT INTO exit_economics (position_id, pair_name, bin_step, exit_fee_lamports, exit_cost_bps, sweep_concession_bps, source, notes) VALUES (?, ?, ?, ?, ?, ?, 'backfill', ?)");
      const seeds = [[4,"MANLET-SOL",80,null,null,null],[5,"EMBER-SOL",200,20000,175.2,394.9],[6,"EMBER-SOL",200,15000,80.1,180.6],
        [7,"EMBER-SOL",200,15000,40.2,90.4],[8,"EMBER-SOL",200,15000,null,null],[9,"EMBER-SOL",200,15000,68.0,152.8],["attempt-5","NEARKAT-SOL",400,24000,143.1,143.1]];
      for (const s of seeds) ins.run(String(s[0]), s[1], s[2], s[3], s[4], s[5], "seed " + s[0]);
      old.close();
    `;
    const seeded = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);

    // A fresh process, because db.ts opens DATABASE_PATH once at import.
    const migrate = `
      const { initDatabase, db, closeDatabase } = await import("./src/database/db.ts");
      initDatabase();
      const cols = db.prepare("PRAGMA table_info(exit_economics)").all().map((c) => c.name);
      const rows = db.prepare("SELECT position_id, bin_step, exit_fee_lamports, exit_cost_bps, sweep_concession_bps, notes, close_signatures, pool_price_after_sweep, sweep_concession_after_sweep_bps, exit_cost_after_sweep_bps FROM exit_economics ORDER BY id").all();
      closeDatabase();
      console.log("RESULT" + JSON.stringify({ cols, rows }));
    `;
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", migrate], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_PATH: dbPath, NODE_TEST_CONTEXT: "child" },
    });
    assert.equal(run.status, 0, run.stderr);
    const line = run.stdout.split("\n").find((l) => l.startsWith("RESULT"))!;
    const { cols, rows } = JSON.parse(line.slice("RESULT".length)) as { cols: string[]; rows: Array<Record<string, unknown>> };
    for (const c of ["close_signatures", "pool_price_after_sweep", "sweep_concession_after_sweep_bps", "exit_cost_after_sweep_bps"]) {
      assert.ok(cols.includes(c), `missing ${c}`);
    }
    assert.equal(rows.length, 7);
    assert.deepEqual(
      rows.map((r) => [r.position_id, r.exit_fee_lamports, r.sweep_concession_bps, r.notes]),
      [["4", null, null, "seed 4"], ["5", 20000, 394.9, "seed 5"], ["6", 15000, 180.6, "seed 6"], ["7", 15000, 90.4, "seed 7"],
        ["8", 15000, null, "seed 8"], ["9", 15000, 152.8, "seed 9"], ["attempt-5", 24000, 143.1, "seed attempt-5"]],
    );
    for (const r of rows) {
      assert.deepEqual([r.close_signatures, r.pool_price_after_sweep, r.sweep_concession_after_sweep_bps, r.exit_cost_after_sweep_bps], [null, null, null, null]);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the temp dir; not a test result.
    }
  });
});

describe("known failed opens file", () => {
  it("parses the shipped file, and refuses a malformed one instead of returning nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const shipped = backfill.parseKnownFailedOpens(readFileSync(backfill.KNOWN_FAILED_OPENS_PATH, "utf8"));
    assert.equal(shipped[0]?.pairName, "NEARKAT-SOL");
    assert.throws(() => backfill.parseKnownFailedOpens("{}"), /no failedOpens array/);
    assert.throws(() => backfill.parseKnownFailedOpens('{"failedOpens":[{"positionId":"x"}]}'), /poolAddress missing/);
  });
});
