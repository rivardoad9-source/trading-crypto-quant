/**
 * `--tvl-rpc-url` (15 Sep 2026). The on-chain TVL ingest used `SOLANA_RPC_URL` from `.env`, and on
 * the live host that is the SAME key the engine monitors positions with: the first run drew 429 on
 * 6 of 8 calls while the engine logged a 429 that cost it a candidate. These tests pin four promises:
 * the flag's host is the one called and the engine's is not; no flag = the `.env` URL exactly; an
 * unusable value fails BEFORE any ingest; and the key never reaches stdout/stderr or an Error.
 * No network: every fetch is a stub, the subprocesses fail before their first request.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { heliusTvlDeps } from "../backtest/onchainTvl.js";
import { describeTvlRpc, readTvlRpcUrlArg, resolveTvlRpc, rpcHostOf } from "../backtest/tvlRpc.js";

const ENV_KEY = "ENGINEKEYaaaa1111bbbb2222";
const FLAG_KEY = "INGESTKEYcccc3333dddd4444";
const ENV_URL = `https://mainnet.helius-rpc.com/?api-key=${ENV_KEY}`;
const FLAG_URL = `https://ingest.helius-rpc.com/?api-key=${FLAG_KEY}`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every 8-character window of a secret; any one of them in the output is a leak. */
function leaks(text: string, secret: string): string[] {
  const hits: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) hits.push(secret.slice(i, i + 8));
  return hits;
}

const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
});

function stubFetch(status: number, calls: string[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    const body = status === 200 ? { result: { data: [] } } : { error: { message: "nope" } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Captures stdout, stderr and console for the duration of `fn`, including a thrown message. */
async function capture(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (c: unknown) => {
    chunks.push(String(c));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  const cons = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  try {
    await fn();
  } catch (e) {
    chunks.push(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    Object.assign(console, cons);
  }
  return chunks.join("\n");
}

describe("--tvl-rpc-url: parsing and validation", () => {
  it("reads both the = form and the space form; absent is undefined", () => {
    assert.equal(readTvlRpcUrlArg(["--tvl=onchain", `--tvl-rpc-url=${FLAG_URL}`]), FLAG_URL);
    assert.equal(readTvlRpcUrlArg(["--tvl-rpc-url", FLAG_URL, "--tvl-rps=3"]), FLAG_URL);
    assert.equal(readTvlRpcUrlArg(["--tvl-rpc-url", "--tvl-rps=3"]), "", "a dangling flag is a given-but-empty value, not absent");
    assert.equal(readTvlRpcUrlArg(["--tvl=onchain"]), undefined);
  });

  it("(b) no flag resolves to the .env URL exactly", () => {
    assert.deepEqual(resolveTvlRpc(undefined, ENV_URL), { url: ENV_URL, host: "mainnet.helius-rpc.com", source: "env", sameAsEnv: false });
  });

  it("a valid flag wins, and a flag equal to .env is flagged as separating nothing", () => {
    const r = resolveTvlRpc(FLAG_URL, ENV_URL);
    assert.deepEqual([r.url, r.host, r.source, r.sameAsEnv], [FLAG_URL, "ingest.helius-rpc.com", "flag", false]);
    assert.equal(resolveTvlRpc(ENV_URL, ENV_URL).sameAsEnv, true);
    assert.match(describeTvlRpc(resolveTvlRpc(ENV_URL, ENV_URL)), /PERINGATAN/);
  });

  it("(c) refuses empty, 'true', unparseable, non-http(s) and hostless values — without echoing them", () => {
    const bad = ["", "   ", "true", `not a url ${FLAG_KEY}`, `ftp://ingest.helius-rpc.com/?api-key=${FLAG_KEY}`, `file:///tmp/${FLAG_KEY}`, `javascript:${FLAG_KEY}`];
    for (const v of bad) {
      let message = "";
      assert.throws(() => resolveTvlRpc(v, ENV_URL), (e: Error) => ((message = e.message), /--tvl-rpc-url/.test(e.message)));
      assert.deepEqual(leaks(message, FLAG_KEY), [], `the error for ${JSON.stringify(v.slice(0, 6))} leaked the key`);
      assert.deepEqual(leaks(message, ENV_KEY), []);
    }
  });

  it("the printable line is host + source, never the key", () => {
    for (const r of [resolveTvlRpc(undefined, ENV_URL), resolveTvlRpc(FLAG_URL, ENV_URL)]) {
      const line = describeTvlRpc(r);
      assert.deepEqual([...leaks(line, ENV_KEY), ...leaks(line, FLAG_KEY)], []);
      assert.ok(line.includes(r.host));
    }
    assert.match(describeTvlRpc(resolveTvlRpc(FLAG_URL, ENV_URL)), /\(dari --tvl-rpc-url\)/);
    assert.match(describeTvlRpc(resolveTvlRpc(undefined, ENV_URL)), /\(default \.env/);
    assert.equal(rpcHostOf("::::"), "unparseable-url");
  });
});

describe("--tvl-rpc-url: the reads go where the flag says", () => {
  it("(a) with the flag, every RPC request goes to the flag's host and never to .env's", async () => {
    const calls: string[] = [];
    stubFetch(200, calls);
    const rpc = resolveTvlRpc(FLAG_URL, ENV_URL);
    const deps = heliusTvlDeps(rpc.url, () => {}, ".cache", 50);
    assert.equal(await deps.reserveAt("ReserveAccount1", 1_700_000_000), null);
    assert.equal(await deps.reserveAt("ReserveAccount2", 1_700_000_000), null);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((u) => new URL(u).host === "ingest.helius-rpc.com"));
    assert.equal(calls.some((u) => u.includes(ENV_KEY) || new URL(u).host === "mainnet.helius-rpc.com"), false);
  });

  it("(b) without the flag, the reads go to .env's URL as before", async () => {
    const calls: string[] = [];
    stubFetch(200, calls);
    await heliusTvlDeps(resolveTvlRpc(undefined, ENV_URL).url, () => {}, ".cache", 50).reserveAt("ReserveAccount1", 1_700_000_000);
    assert.deepEqual(calls, [ENV_URL]);
  });

  it("(d) a failing call names the host and never the key — stdout, stderr and the Error included", async () => {
    const calls: string[] = [];
    stubFetch(403, calls);
    const deps = heliusTvlDeps(resolveTvlRpc(FLAG_URL, ENV_URL).url, (l) => console.log(l), ".cache", 50);
    const text = await capture(async () => {
      console.log(describeTvlRpc(resolveTvlRpc(FLAG_URL, ENV_URL)));
      await deps.reserveAt("ReserveAccount1", 1_700_000_000);
    });
    assert.match(text, /HTTP 403 from ingest\.helius-rpc\.com/);
    assert.deepEqual([...leaks(text, FLAG_KEY), ...leaks(text, ENV_KEY)], []);
  });

  it("a 429 that survives the retries names the host and suggests --tvl-rps, through the log AND the Error", async () => {
    const calls: string[] = [];
    stubFetch(429, calls);
    globalThis.setTimeout = ((fn: () => void) => (fn(), 0)) as unknown as typeof setTimeout; // skip the backoff
    const logged: string[] = [];
    const deps = heliusTvlDeps(resolveTvlRpc(FLAG_URL, ENV_URL).url, (l) => logged.push(l), ".cache", 7);
    await assert.rejects(deps.reserveAt("ReserveAccount1", 1_700_000_000), /HTTP 429 from ingest\.helius-rpc\.com .*--tvl-rps \(now 7\).*--tvl-rpc-url/);
    assert.equal(calls.length, 7, "six retries, then the refusal");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /429 from ingest\.helius-rpc\.com/);
    assert.deepEqual(leaks(logged[0]!, FLAG_KEY), []);
  });
});

describe("--tvl-rpc-url: wiring and fail-early, end to end", () => {
  const integrity = readFileSync(join(root, "backtest", "runIntegrity.ts"), "utf8");
  const validate = readFileSync(join(root, "scripts", "validateTvlModel.ts"), "utf8");

  it("neither script hands .env's URL to the TVL reads any more", () => {
    assert.equal(/heliusTvlDeps\(env\.SOLANA_RPC_URL/.test(integrity), false);
    assert.match(integrity, /heliusTvlDeps\(tvlRpc\.url,/);
    assert.equal(/fetch\(env\.SOLANA_RPC_URL/.test(validate), false);
    assert.match(validate, /fetch\(tvlRpc\.url,/);
  });

  it("runIntegrity resolves the endpoint before the first window is loaded", () => {
    const perWindow = integrity.slice(integrity.indexOf("async function runPerWindowUniverse("));
    const resolveAt = perWindow.indexOf("resolveTvlRpc(");
    assert.ok(resolveAt > 0 && resolveAt < perWindow.indexOf("loadWindowDataset("));
  });

  const run = (script: string, args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(root, script), ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, SOLANA_RPC_URL: ENV_URL, NODE_TEST_CONTEXT: "child-v8" },
    });

  it("(c) backtest:integrity exits non-zero on an invalid URL before any ingest, without printing either key", () => {
    const res = run("backtest/runIntegrity.ts", ["--per-window-universe", "--ingest-only", "--tvl=onchain", "--tvl-rpc-url", `ftp://x.example/?api-key=${FLAG_KEY}`]);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.equal(res.status, 1, text);
    assert.match(text, /--tvl-rpc-url must be http or https/);
    assert.equal(/\[window\]|\[integrity\] W\d|candidates/.test(text), false, "nothing was ingested");
    assert.deepEqual([...leaks(text, FLAG_KEY), ...leaks(text, ENV_KEY)], []);
  });

  it("(c) validate:tvl exits non-zero on a flag with no value, before any request", () => {
    const res = run("scripts/validateTvlModel.ts", ["--tvl-rpc-url"]);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.equal(res.status, 1, text);
    assert.match(text, /--tvl-rpc-url was given without a value/);
    assert.equal(text.includes("self-check"), false);
    assert.deepEqual(leaks(text, ENV_KEY), []);
  });

  it("backtest:integrity refuses the flag on a run that reads no on-chain TVL", () => {
    const res = run("backtest/runIntegrity.ts", ["--ingest-only", `--tvl-rpc-url=${FLAG_URL}`]);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.equal(res.status, 1, text);
    assert.match(text, /only applies to --per-window-universe/);
    assert.deepEqual([...leaks(text, FLAG_KEY), ...leaks(text, ENV_KEY)], []);
  });
});
