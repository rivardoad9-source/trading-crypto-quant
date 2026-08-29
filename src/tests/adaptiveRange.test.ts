/**
 * In-context learning: the loss-history block fed to DeepSeek when it picks a pool.
 *
 * DATABASE_PATH is set before any dynamic import because the agent module pulls in the
 * repository layer, which reads env on load. Keep every import in this file dynamic.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-prompt-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";
process.env.MIN_DOWNSIDE_COVER_PCT = "8";
process.env.MIN_UPSIDE_COVER_PCT = "8";

type Agent = typeof import("../agents/dlmmTraderAgent.js");
type Db = typeof import("../database/db.js");
type Row = import("../database/types.js").SimulatedPositionRow;

let agent: Agent;
let dbModule: Db;

before(async () => {
  // Importing the agent pulls in the repository layer, which opens the database.
  dbModule = await import("../database/db.js");
  agent = await import("../agents/dlmmTraderAgent.js");
});

after(() => {
  // Windows will not unlink an open SQLite file, so close before removing the dir.
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

/*
 * A closed losing row with only the fields the summariser reads.
 *
 * Typed loosely on purpose: SimulatedPositionRow declares realized_pnl_pct as a plain
 * number, but SQLite stores NULL for a row that never closed, which is exactly the case
 * the summariser has to survive. The overrides go in untyped so that case is reachable.
 */
const lossRow = (over: Record<string, unknown> = {}): Row =>
  ({
    pair_name: "WICK-SOL",
    status: "CLOSED_OUT_OF_RANGE",
    entry_price: 100,
    lower_bin_price: 90,
    upper_bin_price: 112,
    realized_pnl_pct: -9.4,
    opened_at: "2026-08-28 10:00:00",
    closed_at: "2026-08-28 12:30:00",
    close_reason: "Price left the bin range; position stopped earning fees.",
    post_mortem: "Range was too tight for the 1h volatility; wicked out and back.",
    ...over,
  }) as Row;

const candidate = () => ({
  address: "PooLAaa",
  pairName: "NEW-SOL",
  baseSymbol: "NEW",
  quoteSymbol: "SOL",
  baseMint: "mintNew",
  quoteMint: "mintSol",
  binStep: 20,
  baseFeePct: 0.2,
  tvlUsd: 120_000,
  currentPrice: 1.5,
  volume24hUsd: 400_000,
  volume1hUsd: 20_000,
  fees24hUsd: 900,
  feeTvlRatio24h: 0.0075,
  estimatedAprPct: 273,
  bothTokensVerified: true,
  isBlacklisted: false,
  ageHours: 300,
  tags: [],
  score: 1,
});

describe("summariseLossHistory", () => {
  it("reconstructs the realised range from the stored prices", () => {
    const headline = agent.summariseLossHistory([lossRow()])[0] ?? "";

    // -10% / +12% around an entry of 100, not whatever the model originally asked for.
    assert.match(headline, /range -10\.0%\/\+12\.0%/);
  });

  it("reports the outcome, the hold time and the lesson", () => {
    const lines = agent.summariseLossHistory([lossRow()]).join("\n");

    assert.match(lines, /WICK-SOL: closed CLOSED_OUT_OF_RANGE at -9\.40% after 2\.5h/);
    assert.match(lines, /reason: Price left the bin range/);
    assert.match(lines, /lesson: Range was too tight/);
  });

  it("says unknown rather than inventing a range or a return", () => {
    const lines = agent
      .summariseLossHistory([
        lossRow({ entry_price: 0, lower_bin_price: 0, upper_bin_price: 0, realized_pnl_pct: null }),
      ])
      .join("\n");

    assert.match(lines, /range unknown/);
    assert.match(lines, /at unknown after/);
  });

  it("returns nothing for an empty history", () => {
    assert.deepEqual(agent.summariseLossHistory([]), []);
  });
});

describe("buildCandidatePrompt — loss context", () => {
  it("quotes the engine's range floors so the model reasons inside them", () => {
    const prompt = agent.buildCandidatePrompt([candidate()], 200, null);

    assert.match(prompt, /downside >= 8%/);
    assert.match(prompt, /upside >= 8%/);
  });

  it("includes a RECENT LOSSES block when there is history", () => {
    const prompt = agent.buildCandidatePrompt([candidate()], 200, null, [lossRow()]);

    assert.match(prompt, /RECENT LOSSES \(your last 1 losing closes/);
    assert.match(prompt, /wicked out and back/);
  });

  it("states the history is UNAVAILABLE rather than omitting it silently", () => {
    const prompt = agent.buildCandidatePrompt([candidate()], 200, null, []);

    // Same contract as the macro metrics: absent data is named, never invented.
    assert.match(prompt, /RECENT LOSSES: UNAVAILABLE/);
    assert.doesNotMatch(prompt, /wicked out/);
  });
});
