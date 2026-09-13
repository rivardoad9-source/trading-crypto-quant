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

describe("known failed opens file", () => {
  it("parses the shipped file, and refuses a malformed one instead of returning nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const shipped = backfill.parseKnownFailedOpens(readFileSync(backfill.KNOWN_FAILED_OPENS_PATH, "utf8"));
    assert.equal(shipped[0]?.pairName, "NEARKAT-SOL");
    assert.throws(() => backfill.parseKnownFailedOpens("{}"), /no failedOpens array/);
    assert.throws(() => backfill.parseKnownFailedOpens('{"failedOpens":[{"positionId":"x"}]}'), /poolAddress missing/);
  });
});
