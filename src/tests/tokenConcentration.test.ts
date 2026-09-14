/**
 * Measurement while the config is frozen (14 Sep 2026): the token-concentration gate and the
 * shadow rule pick. Both exist to produce EVIDENCE while nothing about entries changes, so
 * the tests pin two things above all — report mode keeps the pool, and the funnel still
 * reconciles when enforce mode removes one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assessTokenConcentration, type OpenedAttempt } from "../services/tokenConcentration.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T13:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString().replace("T", " ").slice(0, 19);
const src = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");

const EMBER = "EMBERmint";
const opens = (hoursAgo: number[], over: Partial<OpenedAttempt> = {}): OpenedAttempt[] =>
  hoursAgo.map((h) => ({ attemptedAt: at(h), poolAddress: "POOL_A", tokenMint: EMBER, pairName: "EMBER-SOL", ...over }));

describe("assessTokenConcentration", () => {
  const base = { poolAddress: "POOL_B", nowMs: NOW, limit: 2, windowHours: 24 };

  it("the EMBER run: the third open of one token inside 24h is flagged, even through a SIBLING pool", () => {
    // 12 Sep 15:00, 19:36 → two opens before 13 Sep 06:32.
    const v = assessTokenConcentration({ ...base, attempts: opens([22, 17.4]), tokenMint: EMBER });
    assert.equal(v.flagged, true);
    assert.equal(v.entries, 2);
    assert.match(v.reason ?? "", /opened 2x in the last 24h \(limit 2\)/);
  });

  it("counts only inside the window, and never another token", () => {
    assert.equal(assessTokenConcentration({ ...base, attempts: opens([30, 25, 3]), tokenMint: EMBER }).entries, 1);
    assert.equal(assessTokenConcentration({ ...base, attempts: opens([1, 2]), tokenMint: "OTHERmint" }).flagged, false);
  });

  it("a row without a mint matches on its own pool only, and says so", () => {
    const legacy = opens([1, 2], { tokenMint: null, poolAddress: "POOL_B" });
    const v = assessTokenConcentration({ ...base, attempts: legacy, tokenMint: EMBER });
    assert.equal(v.entries, 2);
    assert.equal(v.matchedByPoolOnly, 2);
    assert.match(v.reason ?? "", /matched by pool only/);
    const sibling = assessTokenConcentration({ ...base, attempts: opens([1, 2], { tokenMint: null, poolAddress: "POOL_A" }), tokenMint: EMBER });
    assert.equal(sibling.entries, 0, "no mint = no sibling propagation");
  });

  it("fails OPEN on an unparseable timestamp", () => {
    const v = assessTokenConcentration({ ...base, attempts: opens([1], { attemptedAt: "not a time" }), tokenMint: EMBER });
    assert.equal(v.entries, 0);
  });
});

describe("shadowRulePick", () => {
  it("picks the highest fee/TVL deterministically and never invents a pick", async () => {
    const { shadowRulePick } = await import("../agents/dlmmTraderAgent.js");
    assert.deepEqual(
      shadowRulePick([
        { address: "B", pairName: "B-SOL", feeTvlRatio24h: 0.2 },
        { address: "A", pairName: "A-SOL", feeTvlRatio24h: 0.2 },
        { address: "C", pairName: "C-SOL", feeTvlRatio24h: 0.1 },
        { address: "D", pairName: "D-SOL", feeTvlRatio24h: Number.NaN },
      ]),
      { poolAddress: "A", pairName: "A-SOL" },
    );
    assert.equal(shadowRulePick([]), null);
  });
});

describe("wiring in the engine", () => {
  const agent = src("agents/dlmmTraderAgent.ts");
  const seek = agent.slice(agent.indexOf("async function seekNewEntry("), agent.indexOf("function recordFunnel("));

  it("runs inside the live-only execution guard, so a dry run is untouched", () => {
    const guard = seek.slice(seek.indexOf("if (isLiveExecutionActive()) {"), seek.indexOf("fresh = executable;"));
    assert.ok(guard.includes("assessTokenConcentration("), "the gate is not inside the live-only block");
    assert.ok(guard.includes("listRecentOpenedAttempts("));
  });

  it("REPORT mode keeps the pool; only ENFORCE removes it, and then it counts in executionRejected", () => {
    const block = seek.slice(seek.indexOf("if (concentration.flagged) {"), seek.indexOf("THE TOKEN-2022 TRANSFER-FEE SCREEN"));
    assert.match(block, /const enforced = env\.LIVE_TOKEN_CONCENTRATION_MODE === "enforce";/);
    assert.match(block, /if \(enforced\) \{[\s\S]*kind: "tokenConcentration"[\s\S]*continue;\s*\}/);
    // The report-mode path falls through to the remaining gates: no `continue` after the enforce block.
    const afterEnforce = block.slice(block.lastIndexOf("continue;") + "continue;".length);
    assert.equal(afterEnforce.includes("continue;"), false);
  });

  it("records the shadow pick before the decision is acted on, and never acts on it", () => {
    const shadowAt = seek.indexOf("summary.shadowPick = {");
    const declineAt = seek.indexOf('if (decision.action !== "ENTER" || decision.selectedPool === "NONE") {\n    summary.skipReason');
    assert.ok(shadowAt > 0 && (declineAt === -1 || shadowAt < declineAt));
    assert.equal((seek.match(/rulePickPool/g) ?? []).length, 1, "the rule's pick is only ever recorded");
  });

  it("the default mode is report, and a zero limit is refused at boot", () => {
    const envSrc = src("config/env.ts");
    assert.match(envSrc, /LIVE_TOKEN_CONCENTRATION_MODE: z\.enum\(\["report", "enforce"\]\)\.default\("report"\)/);
    assert.match(envSrc, /LIVE_MAX_ENTRIES_PER_TOKEN must be a whole number of at least 1/);
  });
});

describe("the funnel row carries the new fields", () => {
  it("stores the concentration counts and both picks, and reads them back (null, not empty string, when absent)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "flowmetrix-concentration-"));
    process.env.DATABASE_PATH = join(dir, "t.db");
    const dbModule = await import("../database/db.js");
    const repos = await import("../database/repositories.js");
    dbModule.initDatabase();
    try {
      const row = {
        scanned: 600, screenRejections: {}, screenerCandidates: 10, heldExcluded: 0, candidates: 7,
        cooldownRejected: 0, executionRejected: 3, execDenylistRejected: 0, execBreakerRejected: 0,
        execBinCapRejected: 2, execNoWsolRejected: 0, execTokenBenchRejected: 0, execTransferFeeRejected: 0,
        execTokenConcentrationRejected: 1, concentrationFlagged: 1,
        shortlistSize: 4, llmPickPool: "P1", llmPickPair: "X-SOL", rulePickPool: "P2", rulePickPair: "Y-SOL",
        antirugPassed: 7, antirugRejected: 0, volatilityRejected: 0, coverageRejected: 0, microRejected: 0,
        reachedDecision: true, opened: false, skipReason: null, positionsChecked: 0, positionsClosed: 0, durationMs: 1,
      };
      repos.recordScanFunnel(row);
      const [back] = repos.getScanFunnel(1);
      assert.ok(back);
      assert.equal(back.execTokenConcentrationRejected, 1);
      assert.equal(back.concentrationFlagged, 1);
      assert.deepEqual([back.llmPickPool, back.rulePickPool, back.shortlistSize], ["P1", "P2", 4]);
      assert.equal(
        back.execDenylistRejected + back.execBreakerRejected + back.execBinCapRejected + back.execNoWsolRejected +
          back.execTokenBenchRejected + back.execTransferFeeRejected + (back.execTokenConcentrationRejected ?? 0),
        back.executionRejected,
      );
      repos.recordScanFunnel({ ...row, execTokenConcentrationRejected: undefined, concentrationFlagged: undefined, shortlistSize: undefined, llmPickPool: undefined, llmPickPair: undefined, rulePickPool: undefined, rulePickPair: undefined });
      const [legacy] = repos.getScanFunnel(1);
      assert.equal(legacy?.llmPickPool, null);
      assert.equal(legacy?.concentrationFlagged, 0);
    } finally {
      dbModule.closeDatabase();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // not a test result
      }
    }
  });
});
