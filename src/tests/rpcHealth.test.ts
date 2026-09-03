/**
 * The Solana RPC health probe behind `/api/health`.
 *
 * The probe exists so the dashboard can show a latency figure that is actually a
 * measurement of the Solana endpoint rather than a round-trip to our own API. That makes
 * three properties load-bearing, and they are what these tests pin:
 *
 *  - It never invents a number. An endpoint that did not answer reports `latencyMs: null`,
 *    not 0 — the same rule that keeps `est_gas_cost_usd` null when the estimate is missing.
 *  - It never leaks the endpoint's credentials. `SOLANA_RPC_URL` carries the API key in
 *    its path or query on Helius, Triton and QuickNode, and this payload is served to a
 *    browser, so only the host may escape the process.
 *  - It cannot take the health route down or turn it into a source of rate limiting. The
 *    reading is cached and single-flighted, only the first read ever waits, and a probe
 *    that throws still yields a reading instead of a 500.
 *
 * The URL points at a closed local port, so the suite makes no external network call.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-rpchealth-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";
// Closed port, plus a credential in the query string that must never reach the payload.
process.env.SOLANA_RPC_URL = "http://127.0.0.1:1/v1?api-key=SUPERSECRETKEY";

type Solana = typeof import("../services/solana.js");
type RpcHealth = import("../services/solana.js").RpcHealth;

let solana: Solana;

before(async () => {
  solana = await import("../services/solana.js");
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  solana.resetRpcHealthCache();
});

/** A reading that is already older than the TTL, so the next read treats it as stale. */
const staleReading = (slot: number, ageMs: number): RpcHealth => ({
  status: "ok",
  latencyMs: 11,
  slot,
  endpoint: "stub.example",
  method: "getSlot",
  checkedAt: new Date(Date.now() - ageMs).toISOString(),
  detail: null,
});

const freshReading = (slot: number): RpcHealth => ({ ...staleReading(slot, 0) });

/** Drains the microtask queue so a background refresh can land. */
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("RPC health — measurement", () => {
  it("reports an endpoint that never answered as unreachable, with no latency", async () => {
    const health = await solana.measureRpcHealth();

    assert.equal(health.status, "unreachable");
    // The whole point: unmeasured is null, never a zero that renders as an instant node.
    assert.equal(health.latencyMs, null);
    assert.equal(health.slot, null);
    assert.equal(health.method, "getSlot");
    assert.ok(health.detail && health.detail.length > 0, "an unreachable endpoint states why");
  });

  it("publishes the host only, never the credential in the URL", async () => {
    const health = await solana.measureRpcHealth();

    assert.equal(health.endpoint, "127.0.0.1:1");
    assert.ok(
      !JSON.stringify(health).includes("SUPERSECRETKEY"),
      "the API key must not appear anywhere in the served payload",
    );
    assert.ok(!health.endpoint.includes("?"), "no query string, which is where keys live");
    assert.ok(!health.endpoint.includes("/"), "no path, which is the other place they live");
  });
});

describe("RPC health — caching", () => {
  it("measures once and serves the cache for the rest of the TTL", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return freshReading(100 + calls);
    };

    const first = await solana.readRpcHealth(probe);
    const second = await solana.readRpcHealth(probe);
    const third = await solana.readRpcHealth(probe);

    assert.equal(calls, 1, "a poll per open dashboard tab must not become a probe per tab");
    assert.equal(first.slot, 101);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  });

  it("shares one measurement between concurrent readers", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const probe = async () => {
      calls += 1;
      await gate;
      return freshReading(200);
    };

    const readers = [
      solana.readRpcHealth(probe),
      solana.readRpcHealth(probe),
      solana.readRpcHealth(probe),
    ];
    release();
    const results = await Promise.all(readers);

    assert.equal(calls, 1, "three simultaneous readers must not race the node three times");
    for (const r of results) assert.equal(r.slot, 200);
  });

  it("serves a stale reading immediately and refreshes behind it", async () => {
    const stale = staleReading(300, solana.RPC_PROBE_TTL_MS + 5_000);
    await solana.readRpcHealth(async () => stale);

    let refreshCalls = 0;
    const refresh = async () => {
      refreshCalls += 1;
      return freshReading(301);
    };

    // The stale value comes back on this read: a liveness route must not wait on a third
    // party once it already has something to say.
    const served = await solana.readRpcHealth(refresh);
    assert.equal(served.slot, 300);
    assert.equal(refreshCalls, 1, "but the refresh was started");

    await settle();
    const afterRefresh = await solana.readRpcHealth(refresh);
    assert.equal(afterRefresh.slot, 301, "the background refresh replaced the cache");
    assert.equal(refreshCalls, 1, "and did not probe again inside the TTL");
  });
});

describe("RPC health — failure never reaches the route", () => {
  it("keeps the last good reading when a refresh throws", async () => {
    const stale = staleReading(400, solana.RPC_PROBE_TTL_MS + 5_000);
    await solana.readRpcHealth(async () => stale);

    const served = await solana.readRpcHealth(async () => {
      throw new Error("probe exploded");
    });

    assert.equal(served.slot, 400, "a failed refresh must not erase what we knew");
    // An unhandled rejection here would take the process down; reaching this line is the
    // assertion that the background refresh's rejection was absorbed.
    await settle();
  });

  it("still yields a reading when the very first probe throws", async () => {
    const health = await solana.readRpcHealth(async () => {
      throw new Error("probe exploded on a cold cache");
    });

    assert.equal(health.status, "unreachable");
    assert.equal(health.latencyMs, null);
    assert.equal(health.endpoint, "127.0.0.1:1");
    assert.match(health.detail ?? "", /probe exploded/);
  });

  it("retries after a thrown first probe rather than caching the failure", async () => {
    await solana.readRpcHealth(async () => {
      throw new Error("cold failure");
    });

    const recovered = await solana.readRpcHealth(async () => freshReading(500));
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.slot, 500);
  });
});
