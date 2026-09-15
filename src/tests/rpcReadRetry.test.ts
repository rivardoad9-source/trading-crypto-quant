/**
 * Bounded retry on READ-ONLY Solana RPC calls (15 Sep 2026).
 *
 * The incident: `[antirug] rejected LEVERCAT-SOL (UNKNOWN): authority check unavailable:
 * AxiosError … 429` — a candidate lost to a rate limit on a key shared with a backtest
 * ingest, not to anything about the token, because `rpc()` was a single POST.
 *
 * What these tests pin:
 *  (a) 429 then 200 → the verdict follows the DATA (PASS or FAIL), after 2 attempts;
 *  (b) 429 forever → UNKNOWN, attempts = the cap, and the reason names the last status;
 *  (c) timeout then 200 → as (a);
 *  (d) a permanent failure is never PASS and never runs past the budget; a 429 that
 *      persists across calls drops to single attempts and is logged ONCE;
 *  (e) send-path methods get exactly one attempt;
 *  plus: the no-error path makes exactly the calls it made before, and the funnel row
 *  carries "lost to the RPC" apart from "the data was unreadable".
 *
 * The HTTP transport is `axios.post`, stubbed with node:test's mock. The URL is a closed
 * local port, so an unstubbed call could not reach a network either. Sleeps go through the
 * module's clock seam, so nothing here actually waits.
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios, { AxiosError, AxiosHeaders } from "axios";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-rpcretry-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";
process.env.SOLANA_RPC_URL = "http://127.0.0.1:1/v1?api-key=RETRYTESTKEY";

type Solana = typeof import("../services/solana.js");
let solana: Solana;

const MINT = "RetryTestMint1111111111111111111111111111";

before(async () => {
  solana = await import("../services/solana.js");
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/* ---------- transport stub ---------- */

type Reply = { status: number; data?: unknown } | { timeout: true } | { network: string };
const calls: string[] = [];
let script: Record<string, Reply[]> = {};
let fallback: Record<string, Reply> = {};
/** Simulated milliseconds each attempt takes (advances the fake clock). */
let attemptCostMs = 0;
let clock = 0;
const waits: number[] = [];

const config = { headers: new AxiosHeaders() } as ConstructorParameters<typeof AxiosError>[2];

function httpError(status: number): AxiosError {
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", config, {}, {
    status,
    statusText: String(status),
    data: {},
    headers: {},
    config: config!,
  });
}

const OK = {
  mintRevoked: { status: 200, data: { result: { value: { data: { parsed: { type: "mint", info: { decimals: 6, freezeAuthority: null, mintAuthority: null, supply: "1000" } } } } } } },
  largestSpread: { status: 200, data: { result: { value: [{ address: "a", amount: "10", decimals: 6, uiAmount: 0 }] } } },
  largestConcentrated: { status: 200, data: { result: { value: [{ address: "a", amount: "900", decimals: 6, uiAmount: 0 }] } } },
  supply: { status: 200, data: { result: { value: { amount: "1000", decimals: 6 } } } },
} satisfies Record<string, Reply>;

beforeEach(() => {
  calls.length = 0;
  waits.length = 0;
  script = {};
  fallback = {};
  attemptCostMs = 0;
  clock = 1_000_000;
  solana.resetRpcReadState();
  solana.rpcRetryClock.now = () => clock;
  solana.rpcRetryClock.sleep = async (ms: number) => {
    waits.push(ms);
    clock += ms;
  };
  solana.rpcRetryClock.random = () => 0.5; // jitter factor exactly 1
  mock.method(axios, "post", async (_url: string, body: { method: string }) => {
    calls.push(body.method);
    clock += attemptCostMs;
    const reply = script[body.method]?.shift() ?? fallback[body.method];
    if (!reply) throw new Error(`unscripted RPC ${body.method}`);
    if ("timeout" in reply) throw new AxiosError("timeout of 20000ms exceeded", "ECONNABORTED", config, {});
    if ("network" in reply) throw new AxiosError("connect failed", reply.network, config, {});
    if (reply.status !== 200) throw httpError(reply.status);
    return { status: 200, data: reply.data };
  });
});

afterEach(() => {
  mock.restoreAll();
});

const count = (method: string) => calls.filter((m) => m === method).length;

/** Healthy concentration reads, so a verdict turns on the authority check alone. */
function concentration(kind: "spread" | "concentrated" = "spread"): void {
  fallback.getTokenLargestAccounts = kind === "spread" ? OK.largestSpread : OK.largestConcentrated;
  fallback.getTokenSupply = OK.supply;
}

describe("read retry — the verdict follows the data, not the transient", () => {
  it("(a) 429 then 200 → PASS after 2 attempts, not UNKNOWN", async () => {
    script.getAccountInfo = [{ status: 429 }, OK.mintRevoked];
    concentration("spread");
    const report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "PASS", report.reasons.join("; "));
    assert.equal(count("getAccountInfo"), 2);
    assert.deepEqual(waits, [500], "one backoff before the second attempt");
    assert.equal(report.unknownCause, undefined);
  });

  it("(a') 429 then 200 on data that breaches a rule → FAIL, still not UNKNOWN", async () => {
    script.getAccountInfo = [{ status: 429 }, OK.mintRevoked];
    concentration("concentrated");
    const report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "FAIL");
    assert.equal(count("getAccountInfo"), 2);
  });

  it("(c) timeout then 200 → PASS after 2 attempts", async () => {
    script.getAccountInfo = [{ timeout: true }, OK.mintRevoked];
    concentration("spread");
    const report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "PASS", report.reasons.join("; "));
    assert.equal(count("getAccountInfo"), 2);
  });

  it("a connection reset then 200, and a 503 then 200, are retried the same way", async () => {
    script.getAccountInfo = [{ network: "ECONNRESET" }, { status: 503 }, OK.mintRevoked];
    concentration("spread");
    const report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "PASS");
    assert.equal(count("getAccountInfo"), 3);
    assert.deepEqual(waits, [500, 1500]);
  });
});

describe("read retry — exhausted stays fail-closed and says why", () => {
  it("(b) 429 forever → UNKNOWN, 3 attempts, reason names the last status, cause = rpc_unavailable", async () => {
    fallback.getAccountInfo = { status: 429 };
    concentration("spread");
    const report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "UNKNOWN");
    assert.equal(count("getAccountInfo"), solana.RPC_READ_RETRY_POLICY.maxAttempts);
    assert.ok(
      report.reasons.includes("authority check unavailable: 3 attempts, last HTTP 429 (getAccountInfo)"),
      report.reasons.join("; "),
    );
    assert.equal(report.unknownCause, "rpc_unavailable");
  });

  it("(d) a permanent refusal (HTTP 403) is one attempt, UNKNOWN, cause = unreadable — never PASS", async () => {
    fallback.getAccountInfo = { status: 403 };
    concentration("spread");
    const report = await solana.screenTokenSafety(MINT);
    assert.notEqual(report.verdict, "PASS");
    assert.equal(report.verdict, "UNKNOWN");
    assert.equal(count("getAccountInfo"), 1, "a 403 will not change on retry");
    assert.equal(report.unknownCause, "unreadable");
  });

  it("(d) a JSON-RPC error and a non-mint account are unreadable data, not a rate limit", async () => {
    fallback.getAccountInfo = { status: 200, data: { error: { code: -32602, message: "Invalid param" } } };
    concentration("spread");
    let report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "UNKNOWN");
    assert.equal(report.unknownCause, "unreadable");
    assert.equal(count("getAccountInfo"), 1);

    fallback.getAccountInfo = { status: 200, data: { result: { value: null } } };
    report = await solana.screenTokenSafety(MINT);
    assert.equal(report.unknownCause, "unreadable");
  });

  it("(d) a slow, failing endpoint never runs past the retry budget", async () => {
    fallback.getAccountInfo = { status: 503 };
    attemptCostMs = 2_500; // each attempt burns 2.5 s of the clock before failing
    const started = clock;
    await assert.rejects(solana.readRpc("getAccountInfo", [MINT]), (err: Error) => {
      assert.ok(err instanceof solana.RpcReadError);
      return true;
    });
    const elapsed = clock - started;
    const { budgetMs } = solana.RPC_READ_RETRY_POLICY;
    // The first attempt keeps the caller's timeout; everything after it fits the budget.
    assert.ok(elapsed <= attemptCostMs + budgetMs, `took ${elapsed} ms`);
    assert.ok(count("getAccountInfo") < solana.RPC_READ_RETRY_POLICY.maxAttempts, "the budget cut a retry short");
  });

  it("a retry's own timeout is clamped to what is left of the budget", async () => {
    const timeouts: number[] = [];
    mock.restoreAll();
    let n = 0;
    mock.method(axios, "post", async (_u: string, body: { method: string }, cfg: { timeout: number }) => {
      calls.push(body.method);
      timeouts.push(cfg.timeout);
      if (n++ === 0) throw httpError(429);
      return { status: 200, data: OK.supply.data };
    });
    await solana.readRpc("getTokenSupply", [MINT]);
    assert.equal(timeouts[0], 20_000, "the first attempt keeps the caller's timeout");
    assert.ok(timeouts[1]! <= solana.RPC_READ_RETRY_POLICY.budgetMs);
  });

  it("(d) a 429 that persists across calls drops to single attempts and is logged once", async () => {
    fallback.getTokenLargestAccounts = { status: 429 };
    const warn = mock.method(console, "warn", () => undefined);
    const { persistentAfter, maxAttempts } = solana.RPC_READ_RETRY_POLICY;
    for (let i = 0; i < persistentAfter; i++) {
      await assert.rejects(solana.readRpc("getTokenLargestAccounts", [MINT]));
    }
    assert.equal(count("getTokenLargestAccounts"), persistentAfter * maxAttempts);
    assert.deepEqual(solana.pausedRpcMethods(), ["getTokenLargestAccounts"]);

    calls.length = 0;
    for (let i = 0; i < 5; i++) {
      await assert.rejects(solana.readRpc("getTokenLargestAccounts", [MINT]), /1 attempt \(retries paused: HTTP 429 persisted across calls\), last HTTP 429/);
    }
    assert.equal(count("getTokenLargestAccounts"), 5, "paused: one attempt per call, no backoff");
    const persistentLogs = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("persistent endpoint limit"));
    assert.equal(persistentLogs.length, 1, "logged once, not per candidate");

    // A success resumes retries.
    clock += solana.RPC_READ_RETRY_POLICY.pauseMs + 1;
    fallback.getTokenLargestAccounts = OK.largestSpread;
    await solana.readRpc("getTokenLargestAccounts", [MINT]);
    assert.deepEqual(solana.pausedRpcMethods(), []);
  });
});

describe("read retry — scope", () => {
  for (const method of ["sendTransaction", "sendRawTransaction", "simulateTransaction", "getSlot", "getRecentPrioritizationFees"]) {
    it(`(e) ${method} gets exactly one attempt and its original error`, async () => {
      fallback[method] = { status: 429 };
      await assert.rejects(solana.readRpc(method, []), (err: unknown) => axios.isAxiosError(err) && err.response?.status === 429);
      assert.equal(count(method), 1);
      assert.deepEqual(waits, []);
    });
  }

  it("(e) a method nobody put on the allowlist is not retried either", async () => {
    fallback.getProgramAccounts = { status: 429 };
    await assert.rejects(solana.readRpc("getProgramAccounts", []));
    assert.equal(count("getProgramAccounts"), 1);
  });

  it("the priority-fee estimate and the health probe still make a single request", async () => {
    fallback.getRecentPrioritizationFees = { status: 429 };
    const warn = mock.method(console, "warn", () => undefined);
    assert.equal(await solana.getPriorityFeeEstimateSafe(), null);
    assert.equal(count("getRecentPrioritizationFees"), 1);
    fallback.getSlot = { status: 429 };
    const health = await solana.measureRpcHealth();
    assert.equal(health.status, "degraded", "a 429 is still reported, not retried away");
    assert.equal(count("getSlot"), 1);
    warn.mock.restore();
  });

  it("no error → exactly the calls made before: one per read, no waits", async () => {
    fallback.getAccountInfo = OK.mintRevoked;
    concentration("spread");
    const report = await solana.screenTokenSafety(MINT);
    assert.equal(report.verdict, "PASS");
    assert.deepEqual([...calls].sort(), ["getAccountInfo", "getTokenLargestAccounts", "getTokenSupply"]);
    assert.deepEqual(waits, []);

    calls.length = 0;
    fallback.getBalance = { status: 200, data: { result: { context: { slot: 1 }, value: 2_000_000_000 } } };
    assert.equal((await solana.getWalletBalanceSol("Wallet1111")).sol, 2);
    assert.deepEqual(calls, ["getBalance"]);
  });

  it("every read in solana.ts goes through readRpc; only the two exclusions call rpc() directly", () => {
    const src = readFileSync(new URL("../services/solana.ts", import.meta.url), "utf8");
    const direct = [...src.matchAll(/await rpc<[\s\S]*?>\(\s*(?:\n\s*)?"?([A-Za-z_]+)"?/g)].map((m) => m[1]);
    // `method` is readRpc's own single-attempt call inside its loop.
    assert.deepEqual(direct.sort(), ["RPC_PROBE_METHOD", "getRecentPrioritizationFees", "method"]);
    assert.equal(/sendTransaction|sendRawTransaction/.test(src.replace(/RPC_NEVER_RETRY_METHODS[\s\S]*?\]\);/, "").replace(/\/\*\*[\s\S]*?\*\//g, "")), false, "solana.ts sends nothing");
  });
});

describe("anti-rug funnel — a rate limit is counted apart from the data", () => {
  it("countAntiRugRejections splits FAIL / rpc-unavailable / unreadable", async () => {
    const agent = await import("../agents/dlmmTraderAgent.js");
    assert.deepEqual(
      agent.countAntiRugRejections([
        { verdict: "FAIL" },
        { verdict: "UNKNOWN", unknownCause: "rpc_unavailable" },
        { verdict: "UNKNOWN", unknownCause: "rpc_unavailable" },
        { verdict: "UNKNOWN", unknownCause: "unreadable" },
        { verdict: "UNKNOWN" }, // cause unrecorded → not claimed as a rate limit
      ]),
      { failed: 1, rateLimited: 2, unreadable: 2 },
    );
  });

  it("the funnel row stores and reads back both counts", async () => {
    const dbModule = await import("../database/db.js");
    const repos = await import("../database/repositories.js");
    dbModule.initDatabase();
    repos.recordScanFunnel({
      scanned: 600, screenRejections: {}, screenerCandidates: 5, heldExcluded: 0, candidates: 5,
      cooldownRejected: 0, executionRejected: 0, execDenylistRejected: 0, execBreakerRejected: 0,
      execBinCapRejected: 0, execNoWsolRejected: 0, execTokenBenchRejected: 0, execTransferFeeRejected: 0,
      antirugPassed: 2, antirugRejected: 3, antirugRpcUnavailable: 2, antirugUnreadable: 0,
      volatilityRejected: 0, coverageRejected: 0, microRejected: 0, reachedDecision: false, opened: false,
      skipReason: null, positionsChecked: 0, positionsClosed: 0, durationMs: 1,
    });
    const [row] = repos.getScanFunnel(1);
    assert.equal(row!.antirugRpcUnavailable, 2);
    assert.equal(row!.antirugUnreadable, 0);
    dbModule.closeDatabase();
  });

  it("the cycle log line prints the split next to the antirug stage", () => {
    const src = readFileSync(new URL("../agents/dlmmTraderAgent.ts", import.meta.url), "utf8");
    const line = src.slice(src.indexOf("`[funnel] scanned "));
    assert.ok(line.indexOf("rpc-unavailable ${rugByCause.rateLimited}") > line.indexOf("antirug ${entry.safeCandidates}"));
    assert.match(src, /antirugRpcUnavailable: rugByCause\.rateLimited/);
  });
});
