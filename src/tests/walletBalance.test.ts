/**
 * Live wallet balance behind the portfolio hero.
 *
 * Three failures here are silent and expensive, and they are what this file is for:
 * an unreadable balance rendering as $0.00 (indistinguishable from a drained wallet),
 * a probe per request turning a status widget into the rate limiter it then reports,
 * and the RPC URL — which carries the provider API key on Helius — reaching a browser.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  WALLET_BALANCE_TTL_MS,
  readWalletBalance,
  resetWalletBalanceCache,
  walletLabel,
  type WalletSnapshot,
} from "../services/walletBalance.js";

function snapshot(overrides: Partial<WalletSnapshot> = {}): WalletSnapshot {
  return {
    status: "ok",
    armed: true,
    floorSol: 0.2,
    address: "SoLWa11etAddressForTestsOnly1111111111111111",
    label: "Main Wallet",
    sol: 1.15,
    lamports: 1_150_000_000,
    usd: 116.08,
    solPriceUsd: 100.94,
    endpoint: "mainnet.helius-rpc.com",
    checkedAt: new Date().toISOString(),
    detail: null,
    ...overrides,
  };
}

describe("wallet balance — caching and single flight", () => {
  beforeEach(() => resetWalletBalanceCache());

  it("probes once and serves the cache to later readers", async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return snapshot();
    };

    await readWalletBalance(probe);
    await readWalletBalance(probe);
    await readWalletBalance(probe);

    assert.equal(calls, 1, "each dashboard poll hit the chain");
  });

  it("shares one in-flight probe between concurrent readers", async () => {
    // N open tabs polling at the same moment must not become N chain reads.
    let calls = 0;
    const probe = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return snapshot();
    };

    const results = await Promise.all([
      readWalletBalance(probe),
      readWalletBalance(probe),
      readWalletBalance(probe),
    ]);

    assert.equal(calls, 1);
    assert.equal(results.length, 3);
    for (const r of results) assert.equal(r.sol, 1.15);
  });

  it("serves a stale reading immediately rather than blocking on the network", async () => {
    const stale = snapshot({
      checkedAt: new Date(Date.now() - WALLET_BALANCE_TTL_MS - 5_000).toISOString(),
      sol: 9.99,
    });
    await readWalletBalance(async () => stale);

    // The refresh is fired in the background; this read must not wait for it.
    let resolveSlow: (v: WalletSnapshot) => void = () => {};
    const slow = new Promise<WalletSnapshot>((r) => (resolveSlow = r));
    const served = await readWalletBalance(() => slow);

    assert.equal(served.sol, 9.99, "a stale-cache read blocked on the network");
    resolveSlow(snapshot());
  });

  it("does not cache a throwing probe, so the next read retries", async () => {
    const first = await readWalletBalance(async () => {
      throw new Error("connect ETIMEDOUT");
    });
    assert.equal(first.status, "unavailable");
    assert.equal(first.sol, null);

    const second = await readWalletBalance(async () => snapshot());
    assert.equal(second.status, "ok", "a failed first read poisoned the cache");
  });

  it("never throws, even when the probe rejects", async () => {
    // A portfolio card that 500s because a third party timed out announces the wrong
    // outage. The caller gets a reading with a timestamp and decides for itself.
    await assert.doesNotReject(() =>
      readWalletBalance(async () => {
        throw new Error("boom");
      }),
    );
  });
});

describe("wallet balance — unknown is never zero", () => {
  beforeEach(() => resetWalletBalanceCache());

  it("reports null, not 0, when the balance cannot be read", async () => {
    const r = await readWalletBalance(async () => {
      throw new Error("429 Too Many Requests");
    });
    assert.equal(r.sol, null);
    assert.equal(r.usd, null);
    assert.equal(r.lamports, null);
    assert.notEqual(r.sol, 0, "an unreadable wallet was reported as empty");
  });

  it("keeps a real zero balance distinguishable from an unknown one", async () => {
    const r = await readWalletBalance(async () =>
      snapshot({ sol: 0, lamports: 0, usd: 0 }),
    );
    assert.equal(r.status, "ok");
    assert.equal(r.sol, 0, "a genuinely empty wallet must still read as 0");
  });

  it("reports unconfigured rather than empty when no address is set", async () => {
    const r = await readWalletBalance(async () =>
      snapshot({ status: "unconfigured", address: null, sol: null, usd: null }),
    );
    assert.equal(r.status, "unconfigured");
    assert.equal(r.sol, null);
  });

  it("keeps the SOL figure when only the USD price is missing", async () => {
    // A price outage must not throw away the number that actually matters.
    const r = await readWalletBalance(async () =>
      snapshot({ usd: null, solPriceUsd: null }),
    );
    assert.equal(r.sol, 1.15);
    assert.equal(r.usd, null, "a USD figure was invented without a price");
  });
});

describe("wallet balance — the RPC key never leaves the process", () => {
  beforeEach(() => resetWalletBalanceCache());

  it("publishes only the endpoint host", async () => {
    const r = await readWalletBalance(async () => snapshot());
    assert.equal(r.endpoint, "mainnet.helius-rpc.com");
    assert.ok(!r.endpoint.includes("?"), "a query string reached the payload");
    assert.ok(!/api[-_]?key/i.test(JSON.stringify(r)), "the payload mentions an api key");
    assert.ok(!r.endpoint.startsWith("http"), "a full URL reached the payload");
  });

  it("builds the host with URL parsing, not string slicing", () => {
    // Asserted against source: a hand-rolled trim is what lets a query string slip
    // through on the one URL shape nobody tested.
    const text = readFileSync(
      fileURLToPath(new URL("../services/walletBalance.ts", import.meta.url)),
      "utf8",
    );
    assert.match(text, /new URL\(url\)\.host/);
    assert.ok(!/SOLANA_RPC_URL\}/.test(text), "the raw RPC URL is interpolated somewhere");
  });
});

describe("wallet balance — the label is configured, never derived", () => {
  it("defaults to a neutral name rather than inferring one", () => {
    const prev = process.env.WALLET_LABEL;
    delete process.env.WALLET_LABEL;
    assert.equal(walletLabel(), "Main Wallet");
    if (prev !== undefined) process.env.WALLET_LABEL = prev;
  });

  it("uses WALLET_LABEL when set, and bounds its length", () => {
    const prev = process.env.WALLET_LABEL;

    process.env.WALLET_LABEL = "Zemiz";
    assert.equal(walletLabel(), "Zemiz");

    process.env.WALLET_LABEL = "x".repeat(200);
    assert.equal(walletLabel().length, 32, "an unbounded label can break the header layout");

    process.env.WALLET_LABEL = "   ";
    assert.equal(walletLabel(), "Main Wallet", "whitespace counted as a name");

    if (prev === undefined) delete process.env.WALLET_LABEL;
    else process.env.WALLET_LABEL = prev;
  });
});
