/**
 * `npm run report:live` — the wait-and-see report of what LIVE trading actually did.
 *
 * Pins the rules that make it trustworthy: it opens the database read-only, paper rows never
 * count, an unmeasured balance or cost is null / counted apart and never a 0, and the
 * profit-source sentence appears when price moves, not fees, carried the book.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  SETTLED_SWEEPS,
  buildLiveReport,
  openReportDatabase,
  readLiveReportInput,
  renderLiveReport,
  type LiveReportInput,
} from "../services/liveReport.js";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const stamp = (msAgo: number) => new Date(NOW - msAgo).toISOString().slice(0, 19).replace("T", " ");
const H = 3_600_000;
const HERE = dirname(fileURLToPath(import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "flowmetrix-livereport-"));
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; not a test result.
  }
});

const opts = { nowMs: NOW, windowDays: 7, liveCapitalSol: 2.85, baselineSol: 3.1 };

/** A database built by the real schema + migrations, in a fresh process (db.ts opens DATABASE_PATH at import). */
function migratedDatabase(name: string): string {
  const dbPath = join(dir, name);
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `const m = await import("./src/database/db.ts"); m.initDatabase(); m.closeDatabase();`],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATABASE_PATH: dbPath, NODE_TEST_CONTEXT: "child" } },
  );
  assert.equal(run.status, 0, run.stderr);
  return dbPath;
}

function seed(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const pos = db.prepare(`INSERT INTO simulated_positions (
      position_id, pool_address, pair_name, strategy_type, entry_price, lower_bin_price, upper_bin_price, virtual_sol_amount,
      status, unclaimed_fee_usd, realized_pnl_usd, position_value_change_usd, opened_at, closed_at,
      execution_mode, position_address, wallet_lamports_before, wallet_lamports_after, residual_sweep)
      VALUES (@id, 'pool', @pair, 'SPOT', 1, 0.5, 1.2, 1.8, @status, @fee, @pnl, @value, @opened, @closed, @mode, @addr, @before, @after, @sweep)`);
    // Measured and settled.
    pos.run({ id: "p1", pair: "EMBER-SOL", status: "CLOSED_PROFIT", fee: 0.35, pnl: 9.66, value: 9.31, opened: stamp(5 * H), closed: stamp(4 * H), mode: "LIVE", addr: "ADDR1", before: 3_000_000_000, after: 3_050_000_000, sweep: "swept" });
    // Settled but no before-read: unmeasured.
    pos.run({ id: "p2", pair: "EMBER-SOL", status: "CLOSED_PROFIT", fee: 2.7, pnl: 10.09, value: 7.39, opened: stamp(3 * 24 * H), closed: stamp(3 * 24 * H - H), mode: "LIVE", addr: "ADDR2", before: null, after: 3_040_000_000, sweep: "swept" });
    // Closed before the sweep existed: not settled.
    pos.run({ id: "p3", pair: "MANLET-SOL", status: "CLOSED_PROFIT", fee: 4.4, pnl: 9.47, value: 5.07, opened: stamp(20 * 24 * H), closed: stamp(20 * 24 * H - H), mode: "LIVE", addr: "ADDR3", before: 2_900_000_000, after: 1_700_000_000, sweep: null });
    // Paper: must not appear anywhere.
    pos.run({ id: "paper", pair: "PAPER-SOL", status: "CLOSED_PROFIT", fee: 999, pnl: 999, value: 0, opened: stamp(2 * H), closed: stamp(H), mode: "PAPER", addr: null, before: 9_000_000_000, after: 9_900_000_000, sweep: "swept" });

    const att = db.prepare(`INSERT INTO live_execution_attempts (attempted_at, pool_address, pair_name, token_mint, outcome, stage, wallet_lamports_before, wallet_lamports_after, cost_lamports, unwind, position_address)
      VALUES (@at, 'pool', @pair, @mint, @outcome, @stage, @before, @after, @cost, @unwind, @addr)`);
    att.run({ at: stamp(30 * 60_000), pair: "KNOTS-SOL", mint: "KNOTSmint", outcome: "failed", stage: "open", before: 3_050_000_000, after: 3_020_000_000, cost: 30_000_000, unwind: "clean", addr: null });
    att.run({ at: stamp(10 * 24 * H), pair: "KNOTS-SOL", mint: "KNOTSmint", outcome: "failed", stage: "open", before: null, after: null, cost: null, unwind: "unknown", addr: null });
    att.run({ at: stamp(3 * 24 * H), pair: "EMBER-SOL", mint: "EMBERmint", outcome: "opened", stage: null, before: 3_000_000_000, after: null, cost: null, unwind: null, addr: "ADDR2" });

    db.prepare(`INSERT INTO exit_economics (position_id, pair_name, mint, exit_fee_lamports, sweep_concession_bps, source) VALUES ('p1', 'EMBER-SOL', 'EMBERmint', 20000, 394.9, 'live')`).run();

    const fun = db.prepare(`INSERT INTO scan_funnel_cycles (cycle_at, shortlist_size, llm_pick_pool, llm_pick_pair, rule_pick_pool, rule_pick_pair, concentration_flagged, exec_token_concentration_rejected)
      VALUES (@at, @size, @llm, @llmPair, @rule, @rulePair, @flagged, @rejected)`);
    const cycle = (at: string, size: number | null, llm: string | null, rule: string | null, flagged = 0, rejected = 0) =>
      fun.run({ at, size, llm, llmPair: llm ? `${llm}-PAIR` : null, rule, rulePair: rule ? `${rule}-PAIR` : null, flagged, rejected });
    // Two cycles picked `pool` before p1 opened (5h ago): the later one is used, and it is ambiguous.
    cycle(stamp(6 * H), 4, "pool", "poolY");
    cycle(stamp(5 * H + 30 * 60_000), 5, "pool", "pool"); // SAME
    cycle(stamp(4 * H), 3, "poolX", "poolY"); // DIFFERENT
    cycle(stamp(3 * H), 3, null, "poolY"); // LLM declined
    cycle(stamp(2 * H + 30 * 60_000), 2, "poolZ", null); // rule made no pick
    cycle(stamp(2 * H), null, null, null, 2, 1); // no decision; concentration counts only
    cycle(stamp(3 * 24 * H + 60_000), null, null, null, 1, 0); // an earlier UTC day
  } finally {
    db.close();
  }
}

describe("liveReport against a migrated database", () => {
  const dbPath = migratedDatabase("live.db");
  seed(dbPath);

  const db = openReportDatabase(dbPath);
  let input: LiveReportInput;
  try {
    input = readLiveReportInput(db);
  } finally {
    db.close();
  }
  const report = buildLiveReport(input, opts);
  const text = renderLiveReport(report);

  it("(f) excludes paper rows everywhere", () => {
    assert.deepEqual(report.positions.map((p) => p.pair).sort(), ["EMBER-SOL", "EMBER-SOL", "MANLET-SOL"]);
    assert.equal(text.includes("PAPER-SOL"), false);
    assert.equal(report.readiness.closedLiveTrades, 3);
    assert.match(text, /3\/30 trade live/);
  });

  it("gives a chain delta only to a settled row with both reads, and keeps the rest out of the net", () => {
    const byId = new Map(report.positions.map((p) => [p.pair + p.closedAt, p]));
    const measured = report.positions.filter((p) => p.chainDeltaSol !== null);
    assert.equal(measured.length, 1);
    assert.ok(Math.abs(measured[0]!.chainDeltaSol! - 0.05) < 1e-12);
    assert.equal(byId.size, 3);
    assert.equal(report.net.unmeasuredPositions, 1);
    assert.equal(report.net.unsettledPositions, 1);
    assert.ok(Math.abs(report.net.netSol - (0.05 - 0.03)) < 1e-12);
    const p1 = report.positions.find((p) => p.chainDeltaSol !== null)!;
    assert.equal(p1.exitFeeLamports, 20000);
    assert.equal(p1.concessionDecisionBps, 394.9);
    assert.equal(p1.concessionLandingBps, null);
  });

  it("(b) a failed attempt with NULL cost is counted as unmeasured, never summed as 0", () => {
    assert.deepEqual(report.attempts.allTime, { failed: 2, measuredCostLamports: 30_000_000, unmeasuredCost: 1 });
    assert.deepEqual(report.attempts.window, { failed: 1, measuredCostLamports: 30_000_000, unmeasuredCost: 0 });
    assert.equal(report.net.unmeasuredAttemptCosts, 1);
  });

  it("takes the newest measured wallet reading and compares it with capital and baseline", () => {
    assert.equal(report.wallet.latest?.sol, 3.02);
    assert.match(report.wallet.latest!.source, /attempt #1 sesudah/);
    assert.ok(Math.abs(report.wallet.vsLiveCapitalSol! - 0.17) < 1e-9);
    assert.ok(Math.abs(report.wallet.vsBaselineSol! + 0.08) < 1e-9);
  });

  it("(c) splits fees from value change and says so when value change carried the book", () => {
    assert.ok(Math.abs(report.profitSource.feesUsd - 7.45) < 1e-9);
    assert.ok(Math.abs(report.profitSource.valueChangeUsd - 21.77) < 1e-9);
    assert.equal(report.profitSource.valueChangeExceedsFees, true);
    assert.match(text, /PERUBAHAN NILAI POSISI > FEE/);
    const p1 = report.positions.find((p) => p.feesUsd === 0.35)!;
    assert.ok(Math.abs(p1.feeSharePct! - (0.35 / 9.66) * 100) < 1e-9);
  });

  it("(d) counts entries per token, resolving the mint from exit_economics or the opening attempt", () => {
    assert.deepEqual(report.concentration.lines, [
      { token: "EMBERmint", allTime: 2, last24h: 1, lastWindow: 2 },
      { token: "MANLET-SOL", allTime: 1, last24h: 0, lastWindow: 0 },
    ]);
    assert.equal(report.concentration.top?.token, "EMBERmint");
    assert.ok(Math.abs(report.concentration.top!.sharePct - 200 / 3) < 1e-9);
  });

  it("shadow pick: counts SAME / DIFFERENT / declined / rule-null from decision cycles only", () => {
    const s = report.shadow;
    assert.equal(s.available, true);
    assert.deepEqual(
      { ...s.allTime },
      { decisions: 5, llmDeclined: 1, same: 1, different: 2, ruleNull: 1, agreementPct: (1 / 3) * 100, shortlistMedian: 3 },
    );
    assert.deepEqual(s.window, s.allTime);
    assert.deepEqual(s.recentDifferent.map((d) => d.llmPair), ["poolX-PAIR", "pool-PAIR"], "newest first");
    assert.match(text, /SAMA 1 · BEDA 2 · kesepakatan 33\.3%/);
  });

  it("shadow pick: attributes a live open to the latest matching cycle and marks the ambiguity", () => {
    const opened = report.shadow.opened.filter((o) => o.match === "position");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.cycleAt, stamp(5 * H + 30 * 60_000));
    assert.equal(opened[0]!.ruleSame, true);
    assert.equal(opened[0]!.ambiguous, true);
    assert.equal(opened[0]!.bookPnlUsd, 9.66);
    assert.match(text, /AMBIGU/);
  });

  it("shadow pick: states the counterfactual is not measurable, and gives no verdict on a small sample", () => {
    assert.equal(report.shadow.sampleSufficient, false);
    assert.match(text, /sampel belum cukup untuk menilai LLM \(5\/20 keputusan\)/);
    assert.match(text, /Hasil kontrafaktual pilihan rule TIDAK terukur dari DB/);
    assert.equal(/LLM (lebih baik|lebih buruk|better|worse)/i.test(text), false);
  });

  it("daily concentration: groups opens and funnel counts by UTC day and says the mode is not in the DB", () => {
    const today = report.dailyConcentration.days.find((d) => d.day === "2026-09-14")!;
    assert.deepEqual(
      { liveOpens: today.liveOpens, distinct: today.distinctTokens, top: today.topToken, topCount: today.topCount, flagged: today.flagged, rejected: today.rejected },
      { liveOpens: 1, distinct: 1, top: "EMBERmint", topCount: 1, flagged: 2, rejected: 1 },
    );
    const earlier = report.dailyConcentration.days.find((d) => d.day === "2026-09-11")!;
    assert.equal(earlier.liveOpens, 1);
    assert.equal(earlier.flagged, 1);
    assert.equal(report.dailyConcentration.days.length, 8, "every UTC day the 7-day window touches");
    assert.match(text, /TIDAK tercatat di DB — itu env LIVE_TOKEN_CONCENTRATION_MODE/);
  });

  it("(e) the handle is read-only: a write throws and the file is untouched", () => {
    const ro = openReportDatabase(dbPath);
    try {
      assert.throws(() => ro.prepare("DELETE FROM simulated_positions").run(), /readonly/i);
    } finally {
      ro.close();
    }
    const src = readFileSync(join(HERE, "..", "services", "liveReport.ts"), "utf8");
    assert.match(src, /readonly: true/);
    assert.equal(/from "\.\.\/database\//.test(src), false, "never imports the writable db module");
  });
});

describe("liveReport without measurements", () => {
  it("(a) no wallet read anywhere → null and said out loud, never 0", () => {
    const report = buildLiveReport({ positions: [], attempts: [], exitEconomics: [], missing: [] }, opts);
    assert.equal(report.wallet.latest, null);
    assert.equal(report.wallet.vsLiveCapitalSol, null);
    assert.equal(report.net.measuredAnything, false);
    assert.equal(report.profitSource.valueChangeExceedsFees, null);
    const text = renderLiveReport(report);
    assert.match(text, /BELUM ADA saldo terukur/);
    assert.match(text, /BELUM BISA DIUKUR/);
    assert.equal(/selisih [+-]?0\.0+ SOL/.test(text), false);
  });

  it("degrades a missing column on an older database to null instead of crashing", () => {
    const dbPath = join(dir, "old.db");
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE simulated_positions (id INTEGER PRIMARY KEY, position_id TEXT, pool_address TEXT, pair_name TEXT, status TEXT,
      opened_at TEXT, closed_at TEXT, realized_pnl_usd REAL, unclaimed_fee_usd REAL, execution_mode TEXT, position_address TEXT)`);
    old.prepare(`INSERT INTO simulated_positions VALUES (1, 'x', 'pool', 'OLD-SOL', 'CLOSED_PROFIT', '2026-09-10 00:00:00', '2026-09-10 01:00:00', 5, 1, 'LIVE', 'ADDR')`).run();
    old.close();
    const ro = openReportDatabase(dbPath);
    let input: LiveReportInput;
    try {
      input = readLiveReportInput(ro);
    } finally {
      ro.close();
    }
    assert.ok(input.missing.includes("simulated_positions.wallet_lamports_before"));
    assert.ok(input.missing.includes("live_execution_attempts"));
    const report = buildLiveReport(input, opts);
    assert.equal(report.positions[0]!.chainDeltaSol, null);
    assert.equal(report.positions[0]!.valueChangeUsd, 4, "derived as book - fees when the column is absent");
  });

  it("an older database without the shadow / concentration columns renders — and a note, never zeros", () => {
    const dbPath = join(dir, "old-funnel.db");
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE scan_funnel_cycles (id INTEGER PRIMARY KEY, cycle_at TEXT, candidates INTEGER)`);
    old.prepare(`INSERT INTO scan_funnel_cycles (cycle_at, candidates) VALUES (?, 3)`).run(stamp(H));
    old.close();
    const ro = openReportDatabase(dbPath);
    let input: LiveReportInput;
    try {
      input = readLiveReportInput(ro);
    } finally {
      ro.close();
    }
    assert.ok(input.missing.includes("scan_funnel_cycles.llm_pick_pool"));
    assert.ok(input.missing.includes("scan_funnel_cycles.concentration_flagged"));
    const report = buildLiveReport(input, opts);
    assert.equal(report.shadow.available, false);
    assert.equal(report.shadow.allTime.decisions, 0);
    const today = report.dailyConcentration.days.at(-1)!;
    assert.equal(today.flagged, null);
    assert.equal(today.funnelCycles, 1);
    const text = renderLiveReport(report);
    assert.match(text, /— DB ini belum punya kolom shadow pick/);
    assert.match(text, /di-flag — · ditolak —/);
    assert.match(text, /Kolom\/tabel tidak ada di DB ini/);
  });

  it("includes both new sections in the JSON output", () => {
    const report = buildLiveReport({ positions: [], attempts: [], exitEconomics: [], missing: [] }, opts);
    const json = JSON.parse(JSON.stringify(report));
    assert.ok("shadow" in json && "dailyConcentration" in json);
    assert.equal(json.shadow.available, false, "a caller that read no funnel is not told there were zero decisions");
  });

  it("keeps its settled set identical to reconciliation's", () => {
    const src = readFileSync(join(HERE, "..", "services", "reconciliation.ts"), "utf8");
    const m = /SETTLED_SWEEPS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m, "reconciliation.ts no longer declares SETTLED_SWEEPS the same way");
    const theirs = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    assert.deepEqual([...SETTLED_SWEEPS].sort(), theirs);
  });
});
