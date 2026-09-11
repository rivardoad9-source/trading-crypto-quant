/**
 * One page per condition, not one per hourly check.
 *
 * `reportCapitalHealth` ran on `CRON.CAPITAL_HEALTH` (every hour) and paged on every
 * breach, so one standing condition was a message an hour forever — the same pattern as
 * the 10 Sep 2026 watchdog spam. The rule: dedupe on the SET of violation classes, hold a
 * repeat for up to 6 hours, announce the return to normal exactly once.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STANDING_ALERT_REPEAT_MS,
  decideStandingAlert,
  initialStandingAlertState,
  violationKey,
  type StandingAlertState,
} from "../services/standingAlert.js";

const HOUR = 60 * 60 * 1000;

/** Runs a sequence of hourly checks and returns what was sent. */
function run(
  ticks: Array<{ at: number; violations: string[]; message?: string }>,
): Array<{ at: number; kind: string; text: string }> {
  let state: StandingAlertState = initialStandingAlertState();
  const sent: Array<{ at: number; kind: string; text: string }> = [];
  for (const t of ticks) {
    const { decision, next } = decideStandingAlert(state, {
      violations: t.violations,
      message: t.message ?? `alert @${t.at}`,
      recoveredMessage: "✅ drift normal lagi",
      nowMs: t.at,
    });
    state = next;
    if (decision.send) sent.push({ at: t.at, kind: decision.kind, text: decision.text });
  }
  return sent;
}

describe("standing alerts — dedupe on the condition", () => {
  it("the same breach twice in a row pages ONCE", () => {
    const sent = run([
      { at: 0, violations: ["drift:short:sol"], message: "-0.050001 SOL" },
      // Different numbers, same condition: must not re-page.
      { at: 1 * HOUR, violations: ["drift:short:sol"], message: "-0.050007 SOL" },
    ]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.kind, "first");
    assert.equal(sent[0]?.text, "-0.050001 SOL", "the first alert lost its numbers");
  });

  it("a standing breach pages once, then ONE repeat when the 6h window has passed", () => {
    const ticks = Array.from({ length: 13 }, (_, h) => ({ at: h * HOUR, violations: ["sizing:over-capital"] }));
    const sent = run(ticks);
    assert.deepEqual(
      sent.map((s) => [s.kind, s.at / HOUR]),
      [
        ["first", 0],
        ["repeat", 6],
        ["repeat", 12],
      ],
    );
    assert.equal(STANDING_ALERT_REPEAT_MS, 6 * HOUR);
  });

  it("breach -> normal sends exactly one 'normal lagi' line, and normal after that sends nothing", () => {
    const sent = run([
      { at: 0, violations: ["drift:short:sol"] },
      { at: 1 * HOUR, violations: [] },
      { at: 2 * HOUR, violations: [] },
      { at: 3 * HOUR, violations: [] },
    ]);
    assert.deepEqual(sent.map((s) => s.kind), ["first", "recovered"]);
    assert.match(sent[1]?.text ?? "", /normal lagi/);
  });

  it("normal from the start sends nothing at all", () => {
    assert.equal(run([{ at: 0, violations: [] }, { at: HOUR, violations: [] }]).length, 0);
  });

  it("a DIFFERENT breach pages at once — another class, or another channel's condition", () => {
    const sent = run([
      { at: 0, violations: ["drift:short:sol"] },
      { at: 1 * HOUR, violations: ["drift:short:sol", "drift:short:pct"] },
      { at: 2 * HOUR, violations: ["drift:surplus:sol"] },
    ]);
    assert.deepEqual(sent.map((s) => s.kind), ["first", "changed", "changed"]);

    const sizing = run([
      { at: 0, violations: ["sizing:over-capital"] },
      { at: 1 * HOUR, violations: ["sizing:balance-unknown"] },
    ]);
    assert.deepEqual(sizing.map((s) => s.kind), ["first", "changed"]);
  });

  it("a breach that clears and comes back pages again", () => {
    const sent = run([
      { at: 0, violations: ["drift:short:sol"] },
      { at: 1 * HOUR, violations: [] },
      { at: 2 * HOUR, violations: ["drift:short:sol"] },
    ]);
    assert.deepEqual(sent.map((s) => s.kind), ["first", "recovered", "first"]);
  });

  it("keys on the SET: order and duplicates do not make a new condition", () => {
    assert.equal(violationKey(["b", "a"]), violationKey(["a", "b", "a"]));
    assert.notEqual(violationKey(["a"]), violationKey(["a", "b"]));
    assert.equal(violationKey([]), null);
  });
});

describe("reportCapitalHealth pages through the dedupe, on BOTH checks", () => {
  const source = readFileSync("src/index.ts", "utf8");
  const start = source.indexOf("async function reportCapitalHealth");
  const body = source.slice(start, source.indexOf("async function main"));

  it("no direct sendMessage is left in the capital checks", () => {
    assert.ok(start > 0);
    assert.equal(body.includes("sendMessage("), false, "a capital alert bypasses the dedupe");
    assert.equal((body.match(/decideStandingAlert\(/g) ?? []).length, 2, "sizing AND drift must both be deduped");
  });
});
