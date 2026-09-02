import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeDays,
  buildDailyCurve,
  curveToCsv,
  type CurveTrade,
} from "../backtest/annualCurve.js";
import { parseHttpStatus } from "../backtest/historicalData.js";

const day = (iso: string): number => Date.parse(iso);

describe("buildDailyCurve", () => {
  it("emits every calendar day in the window, including days with no close", () => {
    const curve = buildDailyCurve(
      [],
      100,
      day("2025-09-01T13:00:00.000Z"),
      day("2025-09-10T04:00:00.000Z"),
    );

    assert.equal(curve.length, 10);
    assert.equal(curve[0]!.date, "2025-09-01");
    assert.equal(curve.at(-1)!.date, "2025-09-10");
    // A gap in the series would make monthly aggregation and drawdown-duration
    // counts silently wrong, so absence of activity must still produce a row.
    assert.ok(curve.every((d) => d.dailyReturn === 0 && d.closes === 0));
    assert.ok(curve.every((d) => d.equityUsd === 100));
  });

  it("books a trade on its EXIT day, not its entry day", () => {
    const trades: CurveTrade[] = [
      { exitTime: "2025-09-03T09:00:00.000Z", netPnlUsd: 10 },
    ];
    const curve = buildDailyCurve(trades, 100, day("2025-09-01"), day("2025-09-04"));

    assert.deepEqual(
      curve.map((d) => d.equityUsd),
      [100, 100, 110, 110],
    );
    assert.equal(curve[2]!.dailyReturn, 0.1);
    assert.equal(curve[2]!.closes, 1);
  });

  it("aggregates several closes landing on the same day", () => {
    const trades: CurveTrade[] = [
      { exitTime: "2025-09-02T01:00:00.000Z", netPnlUsd: 5 },
      { exitTime: "2025-09-02T23:59:59.000Z", netPnlUsd: -2 },
    ];
    const curve = buildDailyCurve(trades, 100, day("2025-09-01"), day("2025-09-02"));

    assert.equal(curve[1]!.closes, 2);
    assert.equal(curve[1]!.realizedPnlUsd, 3);
    assert.equal(curve[1]!.equityUsd, 103);
    // The return is measured against the PREVIOUS day's close, so two same-day
    // trades compose into one 3% day rather than 5% then -1.9%.
    assert.ok(Math.abs(curve[1]!.dailyReturn - 0.03) < 1e-12);
  });

  it("compounds across days off the running equity, not the starting balance", () => {
    const trades: CurveTrade[] = [
      { exitTime: "2025-09-01T12:00:00.000Z", netPnlUsd: 100 },
      { exitTime: "2025-09-02T12:00:00.000Z", netPnlUsd: 100 },
    ];
    const curve = buildDailyCurve(trades, 100, day("2025-09-01"), day("2025-09-02"));

    assert.equal(curve[0]!.dailyReturn, 1.0);
    assert.equal(curve[1]!.dailyReturn, 0.5);
    assert.equal(curve[1]!.equityUsd, 300);
  });

  it("reports 0 rather than Infinity when the account is already wiped out", () => {
    const trades: CurveTrade[] = [
      { exitTime: "2025-09-01T12:00:00.000Z", netPnlUsd: -100 },
      { exitTime: "2025-09-02T12:00:00.000Z", netPnlUsd: 5 },
    ];
    const curve = buildDailyCurve(trades, 100, day("2025-09-01"), day("2025-09-02"));

    assert.equal(curve[0]!.equityUsd, 0);
    assert.equal(curve[1]!.dailyReturn, 0);
    assert.ok(Number.isFinite(curve[1]!.dailyReturn));
  });

  it("ignores a trade with an unparseable exit timestamp instead of throwing", () => {
    const curve = buildDailyCurve(
      [{ exitTime: "not-a-date", netPnlUsd: 25 }],
      100,
      day("2025-09-01"),
      day("2025-09-02"),
    );
    assert.ok(curve.every((d) => d.equityUsd === 100));
  });

  it("uses UTC day boundaries, so a late-evening close does not slide a day", () => {
    // 23:30Z on the 1st is 06:30 on the 2nd in Asia/Jakarta. Booking it on the local
    // date would move the trade into the wrong day, month and potentially year.
    const curve = buildDailyCurve(
      [{ exitTime: "2025-09-01T23:30:00.000Z", netPnlUsd: 10 }],
      100,
      day("2025-09-01T00:00:00.000Z"),
      day("2025-09-02T00:00:00.000Z"),
    );
    assert.equal(curve[0]!.date, "2025-09-01");
    assert.equal(curve[0]!.closes, 1);
    assert.equal(curve[1]!.closes, 0);
  });

  it("counts only days on which a position closed as active", () => {
    const curve = buildDailyCurve(
      [
        { exitTime: "2025-09-02T00:00:00.000Z", netPnlUsd: 1 },
        { exitTime: "2025-09-04T00:00:00.000Z", netPnlUsd: -1 },
      ],
      100,
      day("2025-09-01"),
      day("2025-09-05"),
    );
    assert.equal(activeDays(curve), 2);
  });
});

describe("curveToCsv", () => {
  it("writes the header the Python tear sheet reads, plus one row per day", () => {
    const curve = buildDailyCurve(
      [{ exitTime: "2025-09-02T00:00:00.000Z", netPnlUsd: 10 }],
      100,
      day("2025-09-01"),
      day("2025-09-02"),
    );
    const lines = curveToCsv(curve).trim().split("\n");

    assert.equal(lines[0], "date,equity_usd,daily_return,realized_pnl_usd,closes");
    assert.equal(lines.length, 3);
    assert.ok(lines[2]!.startsWith("2025-09-02,110.000000,0.1000000000,"));
  });
});

describe("parseHttpStatus", () => {
  const failure = (url: string, detail: string): string =>
    `[http] GET ${url} failed: ${detail}`;

  it("reads the status even when the URL itself contains those digits", () => {
    // This is the bug the function exists to prevent: `before_timestamp` is a
    // ten-digit epoch, and 1770260401 contains "401". A substring search over the
    // whole message would call an ordinary rate-limit a plan boundary and silently
    // truncate that pool's history.
    const url =
      "https://api.geckoterminal.com/api/v2/networks/solana/pools/ABC/ohlcv/hour" +
      "?aggregate=1&limit=1000&before_timestamp=1770260401";

    assert.equal(parseHttpStatus(failure(url, "429 Request failed with status code 429")), 429);
    assert.equal(parseHttpStatus(failure(url, "401 Request failed with status code 401")), 401);
  });

  it("reads 401 and 403 as the plan-boundary statuses they are", () => {
    assert.equal(parseHttpStatus(failure("https://x/y", "401 Unauthorized")), 401);
    assert.equal(parseHttpStatus(failure("https://x/y", "403 Forbidden")), 403);
  });

  it("returns null for a transport failure, which carries no status", () => {
    assert.equal(parseHttpStatus(failure("https://x/y", "network timeout of 15000ms")), null);
    assert.equal(parseHttpStatus("something else entirely"), null);
  });
});
