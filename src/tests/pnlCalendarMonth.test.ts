/**
 * `GET /api/pnl-calendar` must refuse a month that does not exist.
 *
 * `^\d{4}-\d{2}$` admits `2026-00`, `2026-13` and `2026-99`. Measured against the live API
 * on 16 Sep 2026, those did NOT return an empty calendar — they returned HTTP 500:
 *
 *   [api] GET /api/pnl-calendar?month=2026-13&cohort=all failed: RangeError: Invalid time value
 *       at DateTimeFormat.formatToParts (<anonymous>)
 *       at offsetMinutesAt (src/services/timezone.ts:40:6)
 *       at zonedDayStartUtc (src/services/timezone.ts:77:55)
 *       at aggregateClosedTradesByDate (src/database/repositories.ts:523:16)
 *
 * `new Date("2026-99-01T00:00:00Z")` is an Invalid Date, so the day-start resolver throws
 * before any SQL runs.
 *
 * The other half matters as much: a month that is REAL but has no trades must keep
 * answering 200 with an empty day list. "Measured, nothing traded" and "that month does not
 * exist" are different facts and must not collapse into one response.
 *
 * Runs offline against a temp database via Fastify's `inject` — no port is opened.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-pnlcal-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Server = Awaited<ReturnType<typeof makeServer>>;

async function makeServer() {
  const { initDatabase } = await import("../database/db.js");
  initDatabase();
  const { buildServer } = await import("../api/server.js");
  return buildServer();
}

let app: Server;

before(async () => {
  app = await makeServer();
});

after(async () => {
  await app.close();
  // The database handle must be released before the temp directory can go on Windows.
  const { closeDatabase } = await import("../database/db.js");
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

const get = (month: string) =>
  app.inject({ method: "GET", url: `/api/pnl-calendar?cohort=all&month=${month}` });

describe("GET /api/pnl-calendar — an impossible month is a 400, not a 500", () => {
  for (const month of ["2026-00", "2026-13", "2026-99"]) {
    it(`${month} is refused with 400`, async () => {
      const res = await get(month);
      assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
      assert.match(res.json<{ error: string }>().error, /month must be between 01 and 12/);
    });
  }

  it("a malformed month keeps its existing 400 and its existing wording", async () => {
    const res = await get("2026-9");
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /month must be formatted as YYYY-MM/);
  });

  it("a real month with no trades still answers 200 with a full, empty day list", async () => {
    /*
     * The regression this guards: refusing too much. An empty month is a MEASUREMENT and
     * must stay distinguishable from a rejected request.
     */
    const res = await get("2026-05");
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ days: Array<{ date: string; trades: number; netPnlUsd: number }> }>();
    assert.equal(body.days.length, 31, "May has 31 days and every one should be present");
    assert.ok(body.days.every((d) => d.trades === 0 && d.netPnlUsd === 0));
    assert.equal(body.days[0]!.date, "2026-05-01");
    assert.equal(body.days[30]!.date, "2026-05-31");
  });

  it("every month boundary is accepted", async () => {
    for (const month of ["2026-01", "2026-12"]) {
      assert.equal((await get(month)).statusCode, 200, `${month} should be valid`);
    }
    // February's length is still resolved from the calendar, not assumed.
    const feb = await get("2024-02");
    assert.equal(feb.statusCode, 200);
    assert.equal(feb.json<{ days: unknown[] }>().days.length, 29, "2024 is a leap year");
  });
});
