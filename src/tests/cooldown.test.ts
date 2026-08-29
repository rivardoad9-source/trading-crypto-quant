/**
 * Pool cooldown, failure lockout, and pair-name display fallback.
 *
 * The cooldown maths is a pure function over a PoolExitRecord, so the timing rules
 * are asserted here against a fixed clock rather than against wall time. The
 * repository-backed half of the feature is covered in lifecycle.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessPoolCooldown,
  displaySymbol,
  filterPoolsOnCooldown,
  formatPairName,
  hoursSince,
  parseDbTimestamp,
  shortenMint,
  summarisePoolExits,
  type CooldownThresholds,
  type PoolExitRecord,
} from "../services/meteora.js";

const THRESHOLDS: CooldownThresholds = {
  cooldownHours: 4,
  lockoutConsecutiveFailures: 2,
  lockoutHours: 24,
};

const NOW = new Date("2026-08-28T12:00:00Z");

/** A SQLite-style 'YYYY-MM-DD HH:MM:SS' UTC timestamp `hours` before NOW. */
const agoSqlite = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString().replace("T", " ").slice(0, 19);

const record = (over: Partial<PoolExitRecord> = {}): PoolExitRecord => ({
  poolAddress: "poolAAA",
  lastClosedAt: agoSqlite(1),
  lastFailureAt: null,
  consecutiveFailures: 0,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Timestamp parsing                                                   */
/* ------------------------------------------------------------------ */

describe("parseDbTimestamp", () => {
  it("reads a bare SQLite timestamp as UTC, not local time", () => {
    const parsed = parseDbTimestamp("2026-08-28 10:00:00");
    assert.ok(parsed);
    assert.equal(parsed.toISOString(), "2026-08-28T10:00:00.000Z");
  });

  it("passes an explicit ISO instant through unchanged", () => {
    const parsed = parseDbTimestamp("2026-08-28T10:00:00.000Z");
    assert.ok(parsed);
    assert.equal(parsed.toISOString(), "2026-08-28T10:00:00.000Z");
  });

  it("returns null for empty and unparseable values", () => {
    assert.equal(parseDbTimestamp(null), null);
    assert.equal(parseDbTimestamp(""), null);
    assert.equal(parseDbTimestamp("   "), null);
    assert.equal(parseDbTimestamp("not a date"), null);
  });
});

describe("hoursSince", () => {
  it("measures a UTC-stored close correctly", () => {
    assert.equal(hoursSince(agoSqlite(3), NOW), 3);
  });

  it("collapses future and unreadable timestamps to zero", () => {
    assert.equal(hoursSince(agoSqlite(-5), NOW), 0);
    assert.equal(hoursSince("garbage", NOW), 0);
    assert.equal(hoursSince(null, NOW), 0);
  });
});

/* ------------------------------------------------------------------ */
/* Cooldown gate                                                       */
/* ------------------------------------------------------------------ */

describe("assessPoolCooldown — 4h cooldown after any close", () => {
  it("does not block a pool that has never traded", () => {
    assert.equal(assessPoolCooldown(undefined, NOW, THRESHOLDS).blocked, false);
  });

  it("blocks a pool closed less than 4h ago", () => {
    const verdict = assessPoolCooldown(record({ lastClosedAt: agoSqlite(0.5) }), NOW, THRESHOLDS);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.kind, "cooldown");
    assert.ok(Math.abs(verdict.hoursRemaining - 3.5) < 1e-6);
  });

  it("blocks a profitable close too — the bench is outcome-blind", () => {
    const verdict = assessPoolCooldown(
      record({ lastClosedAt: agoSqlite(1), consecutiveFailures: 0, lastFailureAt: null }),
      NOW,
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.kind, "cooldown");
  });

  it("releases the pool once 4h have elapsed", () => {
    assert.equal(
      assessPoolCooldown(record({ lastClosedAt: agoSqlite(4.01) }), NOW, THRESHOLDS).blocked,
      false,
    );
  });

  it("is exactly the 4h boundary, not 4h plus a tick", () => {
    assert.equal(
      assessPoolCooldown(record({ lastClosedAt: agoSqlite(4) }), NOW, THRESHOLDS).blocked,
      false,
    );
  });

  it("is disabled by a zero cooldown", () => {
    const verdict = assessPoolCooldown(record({ lastClosedAt: agoSqlite(0.1) }), NOW, {
      ...THRESHOLDS,
      cooldownHours: 0,
    });
    assert.equal(verdict.blocked, false);
  });
});

/* ------------------------------------------------------------------ */
/* Lockout circuit breaker                                             */
/* ------------------------------------------------------------------ */

describe("assessPoolCooldown — 24h lockout after 2 consecutive failures", () => {
  it("does not lock out after a single failure", () => {
    const verdict = assessPoolCooldown(
      record({ lastClosedAt: agoSqlite(6), lastFailureAt: agoSqlite(6), consecutiveFailures: 1 }),
      NOW,
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, false);
  });

  it("locks out on the second consecutive failure", () => {
    const verdict = assessPoolCooldown(
      record({ lastClosedAt: agoSqlite(6), lastFailureAt: agoSqlite(6), consecutiveFailures: 2 }),
      NOW,
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.kind, "lockout");
    assert.ok(Math.abs(verdict.hoursRemaining - 18) < 1e-6);
  });

  it("keeps the pool locked past the 4h cooldown window", () => {
    // 10h is well clear of the cooldown but still inside the lockout.
    const verdict = assessPoolCooldown(
      record({ lastClosedAt: agoSqlite(10), lastFailureAt: agoSqlite(10), consecutiveFailures: 3 }),
      NOW,
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.kind, "lockout");
  });

  it("releases the pool 24h after the last failure", () => {
    const verdict = assessPoolCooldown(
      record({
        lastClosedAt: agoSqlite(25),
        lastFailureAt: agoSqlite(25),
        consecutiveFailures: 4,
      }),
      NOW,
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, false);
  });

  it("is disabled by a zero failure threshold", () => {
    const verdict = assessPoolCooldown(
      record({ lastClosedAt: agoSqlite(10), lastFailureAt: agoSqlite(10), consecutiveFailures: 5 }),
      NOW,
      { ...THRESHOLDS, lockoutConsecutiveFailures: 0 },
    );
    assert.equal(verdict.blocked, false);
  });

  it("does not freeze the screener when the stored timestamp is unreadable", () => {
    const verdict = assessPoolCooldown(
      record({ lastClosedAt: "corrupt", lastFailureAt: "corrupt", consecutiveFailures: 9 }),
      NOW,
      THRESHOLDS,
    );
    assert.equal(verdict.blocked, false);
  });
});

/* ------------------------------------------------------------------ */
/* Run counting                                                        */
/* ------------------------------------------------------------------ */

describe("summarisePoolExits", () => {
  it("counts the trailing run of failing exits, newest first", () => {
    const summary = summarisePoolExits("poolAAA", [
      { status: "CLOSED_OUT_OF_RANGE", closed_at: agoSqlite(1) },
      { status: "CLOSED_LOSS", closed_at: agoSqlite(5) },
      { status: "CLOSED_PROFIT", closed_at: agoSqlite(9) },
      { status: "CLOSED_LOSS", closed_at: agoSqlite(13) },
    ]);

    assert.equal(summary.consecutiveFailures, 2);
    assert.equal(summary.lastClosedAt, agoSqlite(1));
    assert.equal(summary.lastFailureAt, agoSqlite(1));
  });

  it("resets the run when the most recent close was a profit", () => {
    const summary = summarisePoolExits("poolAAA", [
      { status: "CLOSED_PROFIT", closed_at: agoSqlite(1) },
      { status: "CLOSED_OUT_OF_RANGE", closed_at: agoSqlite(5) },
      { status: "CLOSED_OUT_OF_RANGE", closed_at: agoSqlite(9) },
    ]);

    assert.equal(summary.consecutiveFailures, 0);
    assert.equal(summary.lastFailureAt, null);
    assert.equal(summary.lastClosedAt, agoSqlite(1));
  });

  it("treats a timeout as neutral, not as a failure", () => {
    const summary = summarisePoolExits("poolAAA", [
      { status: "CLOSED_TIMEOUT", closed_at: agoSqlite(1) },
      { status: "CLOSED_LOSS", closed_at: agoSqlite(5) },
    ]);
    assert.equal(summary.consecutiveFailures, 0);
  });

  it("reports an empty history as untraded", () => {
    const summary = summarisePoolExits("poolAAA", []);
    assert.equal(summary.lastClosedAt, null);
    assert.equal(summary.consecutiveFailures, 0);
    assert.equal(assessPoolCooldown(summary, NOW, THRESHOLDS).blocked, false);
  });
});

/* ------------------------------------------------------------------ */
/* Candidate filtering                                                 */
/* ------------------------------------------------------------------ */

describe("filterPoolsOnCooldown", () => {
  const pools = [
    { address: "poolAAA", pairName: "AAA-SOL" },
    { address: "poolBBB", pairName: "BBB-SOL" },
    { address: "poolCCC", pairName: "CCC-SOL" },
  ];

  it("drops cooling and locked pools while preserving the ranking of the rest", () => {
    const history = new Map<string, PoolExitRecord>([
      ["poolAAA", record({ poolAddress: "poolAAA", lastClosedAt: agoSqlite(0.2) })],
      [
        "poolCCC",
        record({
          poolAddress: "poolCCC",
          lastClosedAt: agoSqlite(8),
          lastFailureAt: agoSqlite(8),
          consecutiveFailures: 2,
        }),
      ],
    ]);

    const result = filterPoolsOnCooldown(pools, history, NOW, THRESHOLDS);

    assert.deepEqual(
      result.allowed.map((p) => p.address),
      ["poolBBB"],
    );
    assert.equal(result.blocked.length, 2);
    assert.equal(result.blocked[0]?.verdict.kind, "cooldown");
    assert.equal(result.blocked[1]?.verdict.kind, "lockout");
  });

  it("passes everything through on an empty history", () => {
    const result = filterPoolsOnCooldown(pools, new Map(), NOW, THRESHOLDS);
    assert.equal(result.allowed.length, 3);
    assert.equal(result.blocked.length, 0);
  });

  it("keeps the screener's order intact", () => {
    const history = new Map<string, PoolExitRecord>([
      ["poolBBB", record({ poolAddress: "poolBBB", lastClosedAt: agoSqlite(0.5) })],
    ]);
    const result = filterPoolsOnCooldown(pools, history, NOW, THRESHOLDS);
    assert.deepEqual(
      result.allowed.map((p) => p.address),
      ["poolAAA", "poolCCC"],
    );
  });
});

/* ------------------------------------------------------------------ */
/* Display names                                                       */
/* ------------------------------------------------------------------ */

describe("pair name display fallback", () => {
  const CYBERLEEK = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg";
  const WSOL = "So11111111111111111111111111111111111111112";

  it("abbreviates a mint to four characters plus an ellipsis", () => {
    assert.equal(shortenMint(CYBERLEEK), "ApZu..");
    assert.equal(shortenMint("CMLqAbCdEf"), "CMLq..");
  });

  it("leaves a mint shorter than the lead length alone", () => {
    assert.equal(shortenMint("AB"), "AB");
  });

  it("prefers a real symbol over the mint", () => {
    assert.equal(displaySymbol("SOL", WSOL), "SOL");
  });

  it("falls back to the shortened mint for a blank symbol", () => {
    assert.equal(displaySymbol("", CYBERLEEK), "ApZu..");
    assert.equal(displaySymbol("   ", CYBERLEEK), "ApZu..");
    assert.equal(displaySymbol(undefined, CYBERLEEK), "ApZu..");
    assert.equal(displaySymbol(null, CYBERLEEK), "ApZu..");
  });

  it("never renders a half-empty pair label", () => {
    assert.equal(
      formatPairName({
        baseSymbol: "",
        quoteSymbol: "SOL",
        baseMint: CYBERLEEK,
        quoteMint: WSOL,
      }),
      "ApZu..-SOL",
    );
  });

  it("builds the label from symbols when both are present", () => {
    assert.equal(
      formatPairName({
        baseSymbol: "CYBERLEEK",
        quoteSymbol: "SOL",
        baseMint: CYBERLEEK,
        quoteMint: WSOL,
      }),
      "CYBERLEEK-SOL",
    );
  });

  it("degrades to UNKNOWN only when there is no mint either", () => {
    assert.equal(displaySymbol("", ""), "UNKNOWN");
  });
});
