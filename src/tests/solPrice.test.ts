/**
 * The SOL/USD fallback chain.
 *
 * SOL/USD had a single source. When CoinGecko rate-limited, position sizing had no
 * price and the engine opened nothing — correct, but one third-party API could stop
 * trading entirely. These tests pin the two properties that make the chain safe: it
 * degrades rather than failing, and it never lets an implausible quote through.
 *
 * Every source here is a stub, so the suite makes no network calls.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-solprice-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type MarketData = typeof import("../services/marketData.js");
type Source = import("../services/marketData.js").SolPriceSource;

let market: MarketData;

before(async () => {
  market = await import("../services/marketData.js");
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const quote = (name: string, value: number | null): Source => ({
  name,
  fetch: async () => value,
});

const throws = (name: string): Source => ({
  name,
  fetch: async () => {
    throw new Error("simulated upstream failure");
  },
});

describe("fetchSolPriceUsdFrom — degradation", () => {
  it("uses the first source when it works", async () => {
    const price = await market.fetchSolPriceUsdFrom([quote("primary", 150), quote("second", 999)]);
    assert.equal(price, 150);
  });

  it("falls through to the next source when the primary has no price", async () => {
    const price = await market.fetchSolPriceUsdFrom([quote("primary", null), quote("second", 150)]);
    assert.equal(price, 150);
  });

  it("survives a source that throws rather than returning null", async () => {
    // getJsonSafe swallows HTTP errors, but a malformed payload can still throw.
    const price = await market.fetchSolPriceUsdFrom([throws("primary"), quote("second", 150)]);
    assert.equal(price, 150);
  });

  it("returns null when every source fails, and never invents a price", async () => {
    // The contract callers depend on: no price means refuse to size a position.
    const price = await market.fetchSolPriceUsdFrom([
      quote("a", null),
      throws("b"),
      quote("c", null),
    ]);
    assert.equal(price, null);
  });

  it("returns null for an empty source list", async () => {
    assert.equal(await market.fetchSolPriceUsdFrom([]), null);
  });
});

describe("fetchSolPriceUsdFrom — implausible quotes", () => {
  /*
   * Validated by the CHAIN, not only inside each source. A source that forgets to
   * validate must not be able to feed 0 or NaN into position sizing: notional is fixed
   * at entry, so a bad price is baked into that trade's PnL permanently.
   */
  for (const [label, value] of [
    ["zero", 0],
    ["negative", -5],
    ["absurdly large", 1e30],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const) {
    it(`rejects a ${label} quote and keeps looking`, async () => {
      const price = await market.fetchSolPriceUsdFrom([quote("bad", value), quote("good", 150)]);
      assert.equal(price, 150);
    });
  }

  it("returns null when every source is implausible", async () => {
    const price = await market.fetchSolPriceUsdFrom([quote("a", 0), quote("b", Number.NaN)]);
    assert.equal(price, null);
  });

  it("accepts a real price at the edges of the plausibility band", async () => {
    // Wide bounds on purpose: they reject garbage without asserting a market view,
    // which would silently reject genuine prices in a violent move.
    assert.equal(await market.fetchSolPriceUsdFrom([quote("low", 0.01)]), 0.01);
    assert.equal(await market.fetchSolPriceUsdFrom([quote("high", 99_999)]), 99_999);
  });
});

describe("SOL_PRICE_SOURCES", () => {
  it("keeps CoinGecko first and has real fallbacks behind it", () => {
    const names = market.SOL_PRICE_SOURCES.map((s) => s.name);
    assert.equal(names[0], "coingecko", "CoinGecko also feeds BTC/ETH and 24h change");
    assert.ok(names.length >= 3, `expected fallbacks, got ${names.join(", ")}`);
    assert.equal(new Set(names).size, names.length, "source names must be distinct for the logs");
  });
});
