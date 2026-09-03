/**
 * On-chain executor: guardlock and limits.
 *
 * The interesting failures here are not "does a swap work" — that needs a cluster and
 * is what `scripts/testMicroSwap.ts` is for. They are the ones where code that can
 * move real funds becomes reachable, or a bound that looks enforced turns out to be
 * advisory. Those are silent, and they are the whole reason this module is isolated.
 *
 * The import-graph test is the load-bearing one: everything else in this file checks a
 * rule inside the executor, but that test checks that the ENGINE cannot get to the
 * executor at all.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { isLiveTradingEnabled } from "../config/env.js";
import {
  HARD_MAX_SLIPPAGE_BPS,
  ExecutionLimitError,
  ExecutionNotArmedError,
  NotImplementedError,
  assertWithinSpendLimit,
  authorizeExecution,
  dlmmExecutor,
  isExecutionArmable,
  planPriorityFee,
  resolveOnchainConfig,
  resolveSlippageBps,
  type ExecutionAuthorization,
  type OnchainConfig,
} from "../services/onchainExecutor.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(srcDir, "..");

/** A stand-in authorization. Never carries a key — only the public half. */
function auth(overrides: Partial<ExecutionAuthorization> = {}): ExecutionAuthorization {
  return {
    wallet: Keypair.generate().publicKey,
    maxLamportsPerTx: 20_000_000,
    maxSlippageBps: 50,
    armedAt: new Date().toISOString(),
    ...overrides,
  } as ExecutionAuthorization;
}

describe("onchain executor — the engine cannot reach it", () => {
  /**
   * Walks the relative-import graph from a root file and returns every module in it.
   * Relative specifiers only: a package import can never be one of our modules.
   */
  function importGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [resolve(entry)];

    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || seen.has(file)) continue;
      seen.add(file);

      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      // Compiled-style specifiers: "./foo.js" on disk is "./foo.ts".
      for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const spec = m[1];
        if (!spec) continue;
        queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
    return seen;
  }

  it("is absent from every module reachable from src/index.ts", () => {
    const graph = importGraph(join(srcDir, "index.ts"));
    const executor = join(srcDir, "services", "onchainExecutor.ts");

    assert.ok(graph.size > 10, "the import walker found almost nothing; it is broken");
    assert.ok(
      graph.has(join(srcDir, "agents", "dlmmTraderAgent.ts")),
      "sanity: the walker should reach the trading agent",
    );
    assert.ok(
      !graph.has(executor),
      "the running engine can now reach onchainExecutor. The engine is paper-only; " +
        "an execution path must be reviewed deliberately, not acquired by an import.",
    );
  });

  it("is imported only by its own test and the isolated PoC script", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcDir);
    walk(join(repoRoot, "scripts"));

    // Import specifiers only, not any textual mention: another test's allowlist may
    // legitimately name this module in a string without importing it. What matters is
    // who can CALL it.
    const importsExecutor = /(?:from\s*|import\s*\(\s*)["'][^"']*onchainExecutor(?:\.js)?["']/;
    const importers = files.filter((f) => importsExecutor.test(readFileSync(f, "utf8")));
    const allowed = new Set([
      join(srcDir, "services", "onchainExecutor.ts"),
      join(srcDir, "tests", "onchainExecutor.test.ts"),
      join(repoRoot, "scripts", "testMicroSwap.ts"),
    ]);

    for (const f of importers) {
      assert.ok(allowed.has(f), `${f.slice(repoRoot.length)} references the on-chain executor`);
    }
  });

  it("leaves isLiveTradingEnabled false, and never assigns to it", () => {
    assert.equal(isLiveTradingEnabled, false);

    const envSource = readFileSync(join(srcDir, "config", "env.ts"), "utf8");
    assert.match(
      envSource,
      /export const isLiveTradingEnabled = false as const;/,
      "the live-trading literal was changed",
    );

    const executorSource = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
    assert.ok(
      !/isLiveTradingEnabled\s*=/.test(executorSource),
      "the executor assigns to isLiveTradingEnabled",
    );
  });

  it("keeps DRY_RUN=false unbootable", () => {
    const envSource = readFileSync(join(srcDir, "config", "env.ts"), "utf8");
    assert.match(envSource, /if \(!cfg\.DRY_RUN\)/, "the DRY_RUN boot refusal is gone");
  });
});

describe("onchain executor — arming is explicit", () => {
  const cfg = (o: Partial<OnchainConfig> = {}): OnchainConfig =>
    ({ ...resolveOnchainConfig({}), ...o }) as OnchainConfig;

  it("is disarmed by default", () => {
    assert.equal(resolveOnchainConfig({}).armed, false);
    assert.equal(isExecutionArmable(cfg({ armed: false })), false);
  });

  it("refuses to authorize when not armed, before touching the key", () => {
    assert.throws(
      () => authorizeExecution(cfg({ armed: false })),
      (err: unknown) =>
        err instanceof ExecutionNotArmedError && /ONCHAIN_EXECUTION_ARMED/.test(err.message),
    );
  });

  it("refuses to authorize when armed but no key is configured", () => {
    // The suite runs with whatever .env holds. Either outcome is correct as long as an
    // absent key is refused rather than silently producing an authorization.
    try {
      const a = authorizeExecution(cfg({ armed: true }));
      assert.ok(a.wallet, "authorization produced without a wallet");
    } catch (err) {
      assert.ok(err instanceof ExecutionNotArmedError);
    }
  });

  it("refuses a zero or negative spend ceiling", () => {
    assert.throws(
      () => authorizeExecution(cfg({ armed: true, maxLamportsPerTx: 0 })),
      ExecutionNotArmedError,
    );
  });

  it("refuses a hand-built config that tries to widen the slippage cap", () => {
    assert.throws(
      () => authorizeExecution(cfg({ armed: true, maxSlippageBps: 300 })),
      (err: unknown) => err instanceof ExecutionNotArmedError && /hard cap/.test(err.message),
    );
  });
});

describe("onchain executor — slippage is bounded, not suggested", () => {
  it("caps at 0.5% (50 bps)", () => {
    assert.equal(HARD_MAX_SLIPPAGE_BPS, 50);
  });

  it("clamps a configured value DOWN and never up", () => {
    assert.equal(resolveOnchainConfig({ ONCHAIN_MAX_SLIPPAGE_BPS: "500" }).maxSlippageBps, 50);
    assert.equal(resolveOnchainConfig({ ONCHAIN_MAX_SLIPPAGE_BPS: "10" }).maxSlippageBps, 10);
  });

  it("clamps a caller's request down to the authorized bound", () => {
    assert.equal(resolveSlippageBps(auth(), 5000), 50);
    assert.equal(resolveSlippageBps(auth(), 25), 25);
    assert.equal(resolveSlippageBps(auth({ maxSlippageBps: 10 }), 40), 10);
  });

  it("defaults to the authorized bound when the caller asks for nothing", () => {
    assert.equal(resolveSlippageBps(auth()), 50);
  });

  it("rejects a nonsensical request rather than falling back to the cap", () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => resolveSlippageBps(auth(), bad), ExecutionLimitError);
    }
  });
});

describe("onchain executor — the spend ceiling", () => {
  it("permits a spend at or under the ceiling", () => {
    assert.doesNotThrow(() => assertWithinSpendLimit(auth(), 10_000_000, "t"));
    assert.doesNotThrow(() => assertWithinSpendLimit(auth(), 20_000_000, "t"));
  });

  it("blocks a spend above the ceiling", () => {
    assert.throws(() => assertWithinSpendLimit(auth(), 20_000_001, "t"), ExecutionLimitError);
    assert.throws(() => assertWithinSpendLimit(auth(), 5_000_000_000, "t"), ExecutionLimitError);
  });

  it("blocks a non-finite or negative amount instead of coercing it", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.throws(() => assertWithinSpendLimit(auth(), bad, "t"), ExecutionLimitError);
    }
  });

  it("defaults to 0.02 SOL — a bug's blast radius, not a position size", () => {
    assert.equal(resolveOnchainConfig({}).maxLamportsPerTx, 20_000_000);
  });
});

describe("onchain executor — priority fee escalation", () => {
  const base = resolveOnchainConfig({});

  it("never returns zero, because a zero-fee transaction is the one that hangs", async () => {
    const plan = await planPriorityFee(0, base);
    assert.ok(plan.microLamportsPerCu > 0);
  });

  it("escalates with each rebuild and stops at the ceiling", async () => {
    const cfg: OnchainConfig = {
      ...base,
      minPriorityMicroLamports: 1_000,
      maxPriorityMicroLamports: 8_000,
      priorityEscalation: 2,
    };
    const fees: number[] = [];
    for (let i = 0; i < 5; i++) fees.push((await planPriorityFee(i, cfg)).microLamportsPerCu);

    for (let i = 1; i < fees.length; i++) {
      assert.ok((fees[i] ?? 0) >= (fees[i - 1] ?? 0), `fee went down at attempt ${i}`);
    }
    assert.ok(Math.max(...fees) <= 8_000, "escalation blew past the ceiling");
    assert.ok((fees[3] ?? 0) > (fees[0] ?? 0), "no escalation happened at all");
  });

  it("reports a compute unit limit so the fee is actually priced", async () => {
    const plan = await planPriorityFee(0, base);
    assert.ok(plan.computeUnitLimit > 0);
    assert.ok(plan.estimatedLamports > 0);
  });
});

describe("onchain executor — DLMM adapter is honestly unimplemented", () => {
  it("throws on every operation rather than silently succeeding", async () => {
    const a = auth();
    await assert.rejects(
      () => dlmmExecutor.openPosition(a, {
        poolAddress: "p", amountLamports: 1, lowerBinPrice: 1, upperBinPrice: 2, strategy: "SPOT",
      }),
      NotImplementedError,
    );
    await assert.rejects(
      () => dlmmExecutor.claimFees(a, { poolAddress: "p", positionAddress: "x" }),
      NotImplementedError,
    );
    await assert.rejects(
      () => dlmmExecutor.closePosition(a, { poolAddress: "p", positionAddress: "x" }),
      NotImplementedError,
    );
  });

  it("does not return a fake success shape", async () => {
    // A no-op stub returning {signature: "..."} would read as a working integration in
    // every log and every test, right up until the engine books a position that was
    // never opened.
    const source = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
    const stub = source.slice(source.indexOf("export const dlmmExecutor"));
    assert.ok(!/signature:\s*["'`]/.test(stub), "the DLMM stub fabricates a signature");
  });
});

describe("onchain executor — the key stays in the environment", () => {
  it("never returns or logs the secret key", () => {
    const source = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");

    // Precise, not blunt: `return Boolean(env.SOLANA_PRIVATE_KEY)` in isExecutionArmable
    // is fine — it discloses only WHETHER a key exists. Returning the value is not.
    assert.ok(
      !/return\s+env\.SOLANA_PRIVATE_KEY/.test(source),
      "the key value is returned to a caller",
    );
    assert.ok(!/return\s+(secret|raw)\s*[;,)]/.test(source), "decoded key material is returned");
    for (const m of source.matchAll(/return\s+([^;]*SOLANA_PRIVATE_KEY[^;]*);/g)) {
      const expr = m[1] ?? "";
      // The key may only leave a function wrapped in Boolean(): that discloses
      // whether a key exists, never a byte of it.
      assert.ok(
        expr.includes("Boolean(env.SOLANA_PRIVATE_KEY)"),
        `a function returns the key rather than a boolean about it: ${expr}`,
      );
      assert.ok(
        !expr.replace(/Boolean\(env\.SOLANA_PRIVATE_KEY\)/g, "").includes("SOLANA_PRIVATE_KEY"),
        `the key also appears unwrapped in a return: ${expr}`,
      );
    }
    assert.ok(
      !/console\.(log|warn|error)\([^)]*SOLANA_PRIVATE_KEY/.test(source),
      "the key reaches a log line",
    );
    // loadWallet is module-private: the Keypair never leaves the module, so no caller
    // can read .secretKey off an exported value.
    assert.ok(!/export function loadWallet/.test(source), "loadWallet is exported");
    assert.ok(!/export\s+.*\bkeypair\b/i.test(source), "a Keypair is exported");
  });

  it("carries only the PUBLIC key on the authorization object", () => {
    const a = auth();
    assert.ok(!("secretKey" in (a as object)));
    assert.ok(!("keypair" in (a as object)));
    assert.equal(typeof a.wallet.toBase58(), "string");
  });

  it("still has no base58 secret literal anywhere in src/ or scripts/", () => {
    const base58Secret = /['"`][1-9A-HJ-NP-Za-km-z]{86,90}['"`]/;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) {
          assert.ok(
            !base58Secret.test(readFileSync(full, "utf8")),
            `${full.slice(repoRoot.length)} contains what looks like a hardcoded secret key`,
          );
        }
      }
    };
    walk(srcDir);
    walk(join(repoRoot, "scripts"));
  });

  it("round-trips a generated key without ever widening its exposure", () => {
    // Guards the loader's assumptions: 64 bytes, 87-88 base58 chars. A change to
    // either would make loadWallet reject valid keys or accept malformed ones.
    const kp = Keypair.generate();
    const encoded = bs58.encode(kp.secretKey);
    assert.equal(kp.secretKey.length, 64);
    assert.ok(encoded.length >= 86 && encoded.length <= 90, `unexpected length ${encoded.length}`);
    assert.ok(Keypair.fromSecretKey(bs58.decode(encoded)).publicKey.equals(kp.publicKey));
  });
});

describe("onchain executor — the PoC script is safe by default", () => {
  const script = readFileSync(join(repoRoot, "scripts", "testMicroSwap.ts"), "utf8");

  it("requires an explicit --execute flag to spend anything", () => {
    assert.match(script, /includes\("--execute"\)/);
    assert.match(script, /if \(!args\.execute\)/, "no dry-run early return");
  });

  it("authorizes only after the dry-run branch has returned", () => {
    assert.ok(
      script.indexOf("if (!args.execute)") < script.indexOf("authorizeExecution()"),
      "the script arms execution before deciding whether this is a dry run",
    );
  });

  it("checks the per-transaction ceiling before anything else", () => {
    assert.match(script, /maxLamportsPerTx/);
    assert.ok(
      script.indexOf("maxLamportsPerTx") < script.indexOf("authorizeExecution()"),
      "the amount ceiling is checked after arming rather than before",
    );
  });

  it("tells the operator to check the chain before retrying a failure", () => {
    // The one instruction that prevents a double spend after an ambiguous failure.
    assert.match(script, /CHECK IT ON-CHAIN BEFORE RETRYING/);
  });
});
