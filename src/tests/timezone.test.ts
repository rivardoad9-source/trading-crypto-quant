/**
 * Timezone conversion for stored timestamps.
 *
 * These pin the behaviour that SQLite's `'localtime'` could not give us portably: the
 * same day key on every host, and a correct one across a DST transition. Zones other
 * than the project default are used deliberately — Asia/Jakarta has no DST, so it can
 * never exercise the case that actually bites.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  offsetMinutesAt,
  parseStoredUtc,
  toSqlUtc,
  zonedDayEndUtc,
  zonedDayKey,
  zonedDayStartUtc,
  zonedHour,
} from "../services/timezone.js";

const JKT = "Asia/Jakarta";

describe("parseStoredUtc", () => {
  it("reads a zone-less stored timestamp as UTC, never as local", () => {
    // The whole bug class: `new Date("2026-09-02 19:45:22")` is LOCAL time in JS.
    assert.equal(parseStoredUtc("2026-09-02 19:45:22")?.toISOString(), "2026-09-02T19:45:22.000Z");
  });

  it("accepts a value that already carries a zone", () => {
    assert.equal(parseStoredUtc("2026-09-02T19:45:22Z")?.toISOString(), "2026-09-02T19:45:22.000Z");
  });

  it("returns null for empty or unparseable input rather than an Invalid Date", () => {
    assert.equal(parseStoredUtc(""), null);
    assert.equal(parseStoredUtc("   "), null);
    assert.equal(parseStoredUtc("not a timestamp"), null);
  });
});

describe("offsetMinutesAt", () => {
  it("reads a fixed-offset zone", () => {
    assert.equal(offsetMinutesAt(new Date("2026-09-02T19:45:22Z"), JKT), 420);
  });

  it("follows a DST transition instead of assuming one offset for all time", () => {
    // London: +60 in summer, 0 in winter. An offset looked up once would be wrong for
    // half the year, which is exactly what a single 'localtime' assumption does.
    assert.equal(offsetMinutesAt(new Date("2026-07-01T12:00:00Z"), "Europe/London"), 60);
    assert.equal(offsetMinutesAt(new Date("2026-01-01T12:00:00Z"), "Europe/London"), 0);
  });

  it("treats UTC as zero", () => {
    assert.equal(offsetMinutesAt(new Date("2026-09-02T19:45:22Z"), "UTC"), 0);
  });
});

describe("zonedDayKey", () => {
  it("rolls a late-UTC close into the next Jakarta day", () => {
    // 19:45 UTC is 02:45 the next morning in Jakarta. Getting this wrong is what made
    // the dashboard file a trade under the wrong day.
    assert.equal(zonedDayKey(new Date("2026-09-02T19:45:22Z"), JKT), "2026-09-03");
  });

  it("keeps an early-UTC close on the same Jakarta day", () => {
    assert.equal(zonedDayKey(new Date("2026-09-02T03:00:00Z"), JKT), "2026-09-02");
  });

  it("is unaffected by the host's own timezone", () => {
    // Same instant, explicit zones: the answer follows the argument, not the machine.
    const instant = new Date("2026-09-02T19:45:22Z");
    assert.equal(zonedDayKey(instant, "UTC"), "2026-09-02");
    assert.equal(zonedDayKey(instant, JKT), "2026-09-03");
    assert.equal(zonedDayKey(instant, "America/New_York"), "2026-09-02");
  });
});

describe("zonedHour", () => {
  it("reports the local hour, not the UTC one", () => {
    assert.equal(zonedHour(new Date("2026-09-02T19:45:22Z"), JKT), "02");
    assert.equal(zonedHour(new Date("2026-09-02T19:45:22Z"), "UTC"), "19");
  });

  it("renders midnight as 00, not 24", () => {
    assert.equal(zonedHour(new Date("2026-09-02T17:00:00Z"), JKT), "00");
  });
});

describe("zonedDayStartUtc / zonedDayEndUtc", () => {
  it("puts the Jakarta day boundary at 17:00 UTC the day before", () => {
    assert.equal(zonedDayStartUtc("2026-09-03", JKT).toISOString(), "2026-09-02T17:00:00.000Z");
    assert.equal(zonedDayEndUtc("2026-09-03", JKT).toISOString(), "2026-09-03T17:00:00.000Z");
  });

  it("spans exactly 24 hours on an ordinary day", () => {
    const start = zonedDayStartUtc("2026-09-03", JKT).getTime();
    const end = zonedDayEndUtc("2026-09-03", JKT).getTime();
    assert.equal(end - start, 24 * 3600_000);
  });

  it("spans 23 hours on a spring-forward day", () => {
    // 2026-03-29, Europe/London: clocks jump 01:00 -> 02:00, so the day is an hour short.
    const start = zonedDayStartUtc("2026-03-29", "Europe/London").getTime();
    const end = zonedDayEndUtc("2026-03-29", "Europe/London").getTime();
    assert.equal(end - start, 23 * 3600_000);
  });

  it("spans 25 hours on a fall-back day", () => {
    const start = zonedDayStartUtc("2026-10-25", "Europe/London").getTime();
    const end = zonedDayEndUtc("2026-10-25", "Europe/London").getTime();
    assert.equal(end - start, 25 * 3600_000);
  });

  it("brackets every instant that belongs to the day it names", () => {
    const day = "2026-09-03";
    const start = zonedDayStartUtc(day, JKT);
    const end = zonedDayEndUtc(day, JKT);
    assert.equal(zonedDayKey(start, JKT), day, "first instant is inside the day");
    assert.equal(zonedDayKey(new Date(end.getTime() - 1), JKT), day, "last instant is inside");
    assert.notEqual(zonedDayKey(end, JKT), day, "upper bound is exclusive");
    assert.notEqual(zonedDayKey(new Date(start.getTime() - 1), JKT), day, "lower bound is tight");
  });
});

describe("toSqlUtc", () => {
  it("matches SQLite's storage shape so bound values sort lexicographically", () => {
    assert.equal(toSqlUtc(new Date("2026-09-02T19:45:22.987Z")), "2026-09-02 19:45:22");
  });

  it("orders as strings the way the instants order", () => {
    const a = toSqlUtc(new Date("2026-09-02T23:59:59Z"));
    const b = toSqlUtc(new Date("2026-09-03T00:00:00Z"));
    assert.ok(a < b, `${a} should sort before ${b}`);
  });
});
