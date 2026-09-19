/**
 * The drain contract behind `shutdown()`.
 *
 * A cycle that is mid-swap must be allowed to finish before the process exits: the open
 * path runs 26 s to 8.4 minutes, the swap is submitted before its outcome is recorded,
 * and `live_execution_attempts` gets no row until that outcome is known. These tests pin
 * the three properties the fix depends on — the registry forgets settled work, the drain
 * waits for what is still running, and the drain gives up on schedule instead of hanging
 * the process past the supervisor's kill timeout.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  describeInFlight,
  drain,
  pendingCount,
  resetInFlightForTests,
  track,
} from "../services/inFlight.js";

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("inFlight registry", () => {
  beforeEach(() => resetInFlightForTests());

  it("counts tracked work by name and forgets it once it settles", async () => {
    assert.equal(pendingCount(), 0);

    const p = track("dlmm", tick(5));
    assert.deepEqual(describeInFlight(), { count: 1, labels: ["dlmm"] });

    await p;
    await tick(5); // let the observer chain run
    assert.equal(pendingCount(), 0);
  });

  it("reports concurrent work of the same name with a multiplier", async () => {
    const a = track("dlmm", tick(20));
    const b = track("dlmm", tick(20));
    const c = track("fast-monitor", tick(20));

    const report = describeInFlight();
    assert.equal(report.count, 3);
    assert.deepEqual(report.labels, ["dlmm x2", "fast-monitor"]);

    await Promise.all([a, b, c]);
  });

  it("forgets rejected work too, and hands the rejection to the caller", async () => {
    const boom = track("dlmm", Promise.reject(new Error("open failed after the swap")));
    await assert.rejects(boom, /open failed after the swap/);
    await tick(5);
    assert.equal(pendingCount(), 0, "a rejected attempt must not leave the registry dirty");
  });

  it("returns the caller's promise untouched", async () => {
    const value = await track("snapshot", Promise.resolve("done"));
    assert.equal(value, "done");
  });

  it("drains immediately when nothing is running", async () => {
    const result = await drain(1_000);
    assert.equal(result.drained, true);
    assert.equal(result.pending, 0);
    assert.equal(result.labels.length, 0);
  });

  it("waits for in-flight work instead of exiting under it", async () => {
    let finished = false;
    const cycle = track(
      "dlmm",
      tick(80).then(() => {
        finished = true;
      }),
    );

    const result = await drain(2_000);
    assert.equal(finished, true, "the drain must let a mid-swap cycle finish");
    assert.equal(result.drained, true);
    assert.equal(result.pending, 0);
    assert.ok(result.waitedMs >= 50, `expected to have waited, got ${result.waitedMs}ms`);
    await cycle;
  });

  it("gives up on schedule when work never settles, and names it", async () => {
    track("dlmm", new Promise<void>(() => {})); // wedged RPC: never settles

    const started = Date.now();
    const result = await drain(60, 10);
    const elapsed = Date.now() - started;

    assert.equal(result.drained, false);
    assert.equal(result.pending, 1);
    assert.deepEqual(result.labels, ["dlmm"]);
    assert.ok(elapsed < 1_000, `must not hang the process: ${elapsed}ms`);
  });

  it("waits for work that registers while the drain is already running", async () => {
    const first = track("dlmm", tick(40));
    const late = setTimeout(() => track("dlmm", tick(40)), 20);

    const result = await drain(2_000);
    clearTimeout(late);
    assert.equal(result.drained, true);
    await first;
  });
});
