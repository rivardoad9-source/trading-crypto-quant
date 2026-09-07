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
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { isLiveTradingEnabled } from "../config/env.js";
import {
  DLMM_BINS_PER_INIT,
  DLMM_MAX_BINS_PER_POSITION,
  DLMM_POSITION_BIN_DATA_SIZE,
  DLMM_POSITION_MIN_SIZE,
  HARD_MAX_SLIPPAGE_BPS,
  DlmmExecutionError,
  DlmmPartialExecutionError,
  ExecutionLimitError,
  ExecutionNotArmedError,
  SOLANA_MAX_COMPUTE_UNITS,
  USDC_MINT,
  WSOL_MINT,
  assertWithinSpendLimit,
  authorizeExecution,
  computeBudgetInstructions,
  positionAccountBytes,
  binRangeFromPrices,
  dlmmExecutor,
  isExecutionArmable,
  planPriorityFee,
  readRequestedComputeUnits,
  resolveComputeUnitLimit,
  resolveOnchainConfig,
  resolveSlippageBps,
  solSide,
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
  function importGraph(entry: string, cut: Set<string> = new Set()): Set<string> {
    const seen = new Set<string>();
    const queue = [resolve(entry)];

    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || seen.has(file)) continue;
      // `cut` severs a module: it is not visited and its imports are not followed, so
      // the walk answers "what is reachable if this file did not exist".
      if (cut.has(file)) continue;
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

  /*
   * THE RULE CHANGED, AND NARROWED.
   *
   * It used to be "the engine cannot reach the executor at all". Live execution made
   * that false by design: `src/index.ts` now reaches the signer. What replaced it is
   * not a weaker rule but a more specific one — the engine may reach the executor
   * through EXACTLY ONE module, `services/liveExecution.ts`, and through nothing else.
   *
   * That edge is the whole point. One file means one place to review "can this spend
   * money, and under what conditions", instead of a signer reachable from wherever an
   * import happened to be convenient. Deleting this test to make a new import compile
   * removes the only structural guarantee left.
   */
  it("is reachable from src/index.ts through liveExecution.ts and nothing else", () => {
    const graph = importGraph(join(srcDir, "index.ts"));
    const executor = join(srcDir, "services", "onchainExecutor.ts");
    const bridge = join(srcDir, "services", "liveExecution.ts");

    assert.ok(graph.size > 10, "the import walker found almost nothing; it is broken");
    assert.ok(
      graph.has(join(srcDir, "agents", "dlmmTraderAgent.ts")),
      "sanity: the walker should reach the trading agent",
    );
    assert.ok(graph.has(bridge), "the engine no longer reaches the live-execution bridge");

    // Remove the bridge and the signer must become unreachable again. That is what
    // "through liveExecution.ts and nothing else" means, tested rather than asserted.
    const withoutBridge = importGraph(join(srcDir, "index.ts"), new Set([bridge]));
    assert.ok(
      !withoutBridge.has(executor),
      "the engine reaches onchainExecutor by some path OTHER than liveExecution.ts. " +
        "Execution must enter the engine through exactly one reviewed edge.",
    );
  });

  it("is imported only by its own test, the bridge, and the isolated PoC script", () => {
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
    /*
     * Four entries, and the list is the security boundary — every addition widens who
     * can move funds. `liveExecution.ts` is the bridge the engine goes through; if a
     * fifth file ever needs to be added here, that is the moment to ask whether it
     * should instead call the bridge.
     */
    const allowed = new Set([
      join(srcDir, "services", "onchainExecutor.ts"),
      join(srcDir, "services", "liveExecution.ts"),
      join(srcDir, "tests", "onchainExecutor.test.ts"),
      join(repoRoot, "scripts", "testMicroSwap.ts"),
    ]);

    for (const f of importers) {
      assert.ok(allowed.has(f), `${f.slice(repoRoot.length)} references the on-chain executor`);
    }
  });

  it("requires BOTH switches for isLiveTradingEnabled, never one", () => {
    /*
     * This used to assert the flag was a `false` literal. Live execution made that
     * false on purpose; what survives is the property that actually protects anything
     * — the flag is the AND of two independent switches, so neither one alone can arm
     * live trading.
     *
     * The dangerous half is silent: an engine that believes it is live while nothing
     * can sign would take entry decisions and fail every execution. `env.ts` refuses
     * to boot on that combination rather than running in it.
     */
    const envSource = readFileSync(join(srcDir, "config", "env.ts"), "utf8");
    assert.match(
      envSource,
      /export const isLiveTradingEnabled: boolean = !env\.DRY_RUN && armedInEnvironment\(\);/,
      "isLiveTradingEnabled no longer requires both DRY_RUN=false and the executor armed",
    );

    // On this machine DRY_RUN is true, so the flag must be false whatever else is set.
    assert.equal(isLiveTradingEnabled, false, "this machine has live trading armed");

    const executorSource = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
    assert.ok(
      !/isLiveTradingEnabled\s*=/.test(executorSource),
      "the executor assigns to isLiveTradingEnabled",
    );
  });

  it("refuses to boot on half-armed live mode", () => {
    // DRY_RUN=false without an armed executor, or without a key, must not start.
    const envSource = readFileSync(join(srcDir, "config", "env.ts"), "utf8");
    assert.match(
      envSource,
      /if \(!cfg\.DRY_RUN && !armedInEnvironment\(\)\)/,
      "DRY_RUN=false no longer requires ONCHAIN_EXECUTION_ARMED",
    );
    assert.match(
      envSource,
      /if \(!cfg\.DRY_RUN && !cfg\.SOLANA_PRIVATE_KEY\)/,
      "DRY_RUN=false no longer requires a signing key",
    );
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

describe("onchain executor — DLMM adapter refuses before it reaches the network", () => {
  /*
   * Stage 2 is implemented, so the old "everything throws NotImplementedError" suite
   * no longer describes this module. What still needs guarding is the part a unit test
   * can actually reach: every refusal that must happen BEFORE an RPC call, and the
   * unit conversion that fails silently rather than loudly.
   *
   * The end-to-end path needs a cluster and is `scripts/testMicroSwap.ts`'s job. These
   * tests deliberately never open a socket — each one asserts a rejection that occurs
   * before `DLMM.create` is reached.
   */
  const openParams = {
    poolAddress: "ErwEeF8y8uLR7LkJcL3xRUuN1d8SrMLZJB92Ydq8vfdw",
    amountLamports: 10_000_000,
    lowerBinPrice: 1,
    upperBinPrice: 2,
    strategy: "SPOT" as const,
  };

  it("checks the spend ceiling before doing anything else", async () => {
    // Ordering matters: a ceiling checked after the RPC round trip is a ceiling that
    // has already told a third party what we intend to do.
    await assert.rejects(
      () => dlmmExecutor.openPosition(auth(), { ...openParams, amountLamports: 20_000_001 }),
      ExecutionLimitError,
    );
  });

  it("rejects a nonsense deposit rather than coercing it", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await assert.rejects(
        () => dlmmExecutor.openPosition(auth(), { ...openParams, amountLamports: bad }),
        ExecutionLimitError,
      );
    }
  });

  it("rejects a slippage request it cannot honour, before quoting anything", async () => {
    await assert.rejects(
      () => dlmmExecutor.openPosition(auth(), { ...openParams, slippageBps: 0 }),
      ExecutionLimitError,
    );
  });

  it("converts prices to bins through the SDK, never by reimplementing the maths", () => {
    /*
     * The silent failure this prevents. `getBinIdFromPrice` takes a price PER LAMPORT
     * and does no decimal conversion — handing it a human price places the position in
     * an unrelated bin range, off by the ratio of the two mints' decimals, without
     * throwing. The adapter must route through `toPricePerLamport` first.
     */
    const seen: Array<{ price: number; min: boolean }> = [];
    const pool = {
      toPricePerLamport: (price: number) => String(price / 1_000),
      getBinIdFromPrice: (price: number, min: boolean) => {
        seen.push({ price, min });
        return min ? 10 : 20;
      },
    };

    const range = binRangeFromPrices(pool, 2, 4);
    assert.deepEqual(range, { minBinId: 10, maxBinId: 20 });
    assert.deepEqual(
      seen,
      [
        { price: 0.002, min: true },
        { price: 0.004, min: false },
      ],
      "the human price reached getBinIdFromPrice without the per-lamport conversion",
    );
  });

  it("floors the lower bound and ceils the upper, so the range contains the prices", () => {
    const mins: boolean[] = [];
    binRangeFromPrices(
      {
        toPricePerLamport: (p: number) => String(p),
        getBinIdFromPrice: (_p: number, min: boolean) => {
          mins.push(min);
          return min ? 1 : 2;
        },
      },
      1,
      2,
    );
    assert.deepEqual(mins, [true, false], "the range truncates inward instead of containing");
  });

  it("refuses a range that is not positive and increasing", () => {
    const pool = {
      toPricePerLamport: (p: number) => String(p),
      getBinIdFromPrice: (_p: number, min: boolean) => (min ? 1 : 2),
    };
    for (const [lo, hi] of [
      [0, 1],
      [-1, 1],
      [2, 2],
      [3, 1],
      [Number.NaN, 1],
    ]) {
      assert.throws(
        () => binRangeFromPrices(pool, lo as number, hi as number),
        DlmmExecutionError,
        `accepted range [${lo}, ${hi}]`,
      );
    }
  });

  it("identifies the wSOL side rather than assuming one", () => {
    const wsol = new PublicKey(WSOL_MINT);
    const usdc = new PublicKey(USDC_MINT);
    assert.equal(solSide({ tokenX: { publicKey: wsol }, tokenY: { publicKey: usdc } }), "X");
    assert.equal(solSide({ tokenX: { publicKey: usdc }, tokenY: { publicKey: wsol } }), "Y");
    // Neither side is SOL: `amountLamports` has no meaning, and guessing would be a
    // decimals bug that does not throw.
    assert.equal(
      solSide({ tokenX: { publicKey: usdc }, tokenY: { publicKey: Keypair.generate().publicKey } }),
      null,
    );
  });

  it("does not fabricate a signature", async () => {
    // Unchanged from Stage 1: a no-op returning {signature: "..."} would read as a
    // working integration in every log, right up until the engine books a position it
    // never opened. Every signature must come from sendAndConfirm.
    const source = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
    const adapter = source.slice(source.indexOf("export const dlmmExecutor"));
    assert.ok(!/signature:\s*["'`]/.test(adapter), "the DLMM adapter fabricates a signature");
    assert.ok(
      !/sent:\s*\[\s*\]/.test(adapter),
      "an operation returns an empty success rather than raising",
    );
  });

  it("still demands an authorization on every fund-moving method", () => {
    // The type-level lock. A convenience overload without ExecutionAuthorization would
    // turn "are we allowed to spend?" back into a code-review question.
    const source = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
    for (const method of ["openPosition", "claimFees", "closePosition"]) {
      assert.match(
        source,
        new RegExp(`${method}\\(\\s*\\n?\\s*auth: ExecutionAuthorization`),
        `${method} no longer requires an ExecutionAuthorization`,
      );
    }
  });

  it("reports a partial multi-transaction run instead of a clean success", () => {
    /*
     * claimSwapFee and removeLiquidity return Transaction[] — a position spanning many
     * bins does not fit in one. If the third of four lands and the fourth fails, the
     * fees are partly claimed and the caller must NOT retry blindly.
     */
    const landed = [
      { signature: "sig-a", slot: 1, buildAttempts: 1, priorityMicroLamports: 20_000 },
    ];
    const err = new DlmmPartialExecutionError("claimFees", "pos-1", landed, new Error("boom"));
    assert.match(err.message, /landed 1 of its transactions/);
    assert.match(err.message, /sig-a/, "the landed signatures are not reported");
    assert.match(err.message, /CHECK THE POSITION ON-CHAIN BEFORE RETRYING/);
    assert.deepEqual(err.landed, landed);
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

/*
 * These are the tests that would have caught the 7 Sep 2026 outage before it cost
 * 0.4 SOL, and they are the ones that stop it recurring after an SDK upgrade.
 *
 * The engine had `MAX_BIN_PER_POSITION = 70` hand-written in `liveExecution.ts`. 70 is
 * real — it is `DEFAULT_BIN_PER_POSITION`, all one `initializePosition` allocates — but
 * it is not what a position account can HOLD, which is 1400. Nothing failed at build
 * time or at boot; the number was simply wrong, and the cost showed up as entries
 * dying after the balancing swap had already spent the SOL.
 *
 * The defence is not a better-chosen constant. It is refusing to let our copy and the
 * SDK's disagree silently: every value below is asserted against the installed SDK, so
 * a version bump that moves any of them fails the build instead of the wallet.
 */
describe("onchain executor — DLMM position limits track the SDK, not a hand-written guess", () => {
  /** The SDK ships a broken ESM build; the CJS one is what the executor loads too. */
  async function sdkConstants(): Promise<Record<string, unknown>> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    return require("@meteora-ag/dlmm") as Record<string, unknown>;
  }

  it("mirrors DEFAULT_BIN_PER_POSITION and POSITION_MAX_LENGTH exactly", async () => {
    const sdk = await sdkConstants();

    assert.equal(
      Number(String(sdk.DEFAULT_BIN_PER_POSITION)),
      DLMM_BINS_PER_INIT,
      "DLMM_BINS_PER_INIT drifted from the SDK's DEFAULT_BIN_PER_POSITION",
    );
    assert.equal(
      Number(String(sdk.POSITION_MAX_LENGTH)),
      DLMM_MAX_BINS_PER_POSITION,
      "DLMM_MAX_BINS_PER_POSITION drifted from the SDK's POSITION_MAX_LENGTH",
    );
  });

  it("mirrors the account size constants", async () => {
    const sdk = await sdkConstants();
    assert.equal(Number(sdk.POSITION_MIN_SIZE), DLMM_POSITION_MIN_SIZE);
    assert.equal(Number(sdk.POSITION_BIN_DATA_SIZE), DLMM_POSITION_BIN_DATA_SIZE);
  });

  it("computes the same account size the SDK does, at and either side of the 70-bin step", async () => {
    const sdk = await sdkConstants();
    const calculatePositionSize = sdk.calculatePositionSize as (bn: unknown) => { toString(): string };
    const { default: BN } = await import("bn.js");

    // 69/70/71 straddle the point where the account stops being fixed-size, which is
    // exactly where an off-by-one would hide.
    for (const width of [1, 69, 70, 71, 91, 161, 278, 700, 1400]) {
      assert.equal(
        positionAccountBytes(width),
        Number(calculatePositionSize(new BN(width)).toString()),
        `account size disagrees with the SDK at width ${width}`,
      );
    }
  });

  it("keeps the resize step under Solana's 10240-byte realloc cap", async () => {
    const sdk = await sdkConstants();
    const maxResize = Number(String(sdk.MAX_RESIZE_LENGTH));

    /*
     * This is the arithmetic the whole wide-position path rests on: one
     * `increasePositionLength` grows the account by MAX_RESIZE_LENGTH bins, and Solana
     * refuses a realloc above 10240 bytes per instruction. If an SDK bump raised
     * MAX_RESIZE_LENGTH past this, every wide open would fail on-chain.
     */
    assert.ok(
      maxResize * DLMM_POSITION_BIN_DATA_SIZE <= 10_240,
      `MAX_RESIZE_LENGTH=${maxResize} x ${DLMM_POSITION_BIN_DATA_SIZE}B exceeds the ` +
        `10240-byte realloc cap`,
    );
  });

  it("rejects a nonsense width rather than returning a plausible size", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => positionAccountBytes(bad), DlmmExecutionError, `width ${bad}`);
    }
  });
});

describe("onchain executor — the SDK's compute budget is a floor to raise, never a cap to override", () => {
  /*
   * These tests exist because of a defect that cost real money on 7 Sep 2026, and they
   * are written to fail if it is reintroduced.
   *
   * `asVersionedTransaction` has to strip the SDK's compute-budget instructions —
   * two `setComputeUnitLimit`s in one transaction is a runtime rejection, and the
   * priority fee has to be ours for `sendAndConfirm`'s escalation to mean anything.
   * What it did was strip them WITHOUT READING THEM, replacing an estimate the SDK had
   * sized per call (usually by simulating against the cluster) with one flat constant.
   * Every operation the SDK had sized above that constant then died on the compute
   * meter — after the balancing swap had already spent.
   */
  const floor = 400_000;

  it("keeps the configured floor when the SDK asked for less, or asked for nothing", () => {
    assert.deepEqual(resolveComputeUnitLimit(null, floor), { units: floor, source: "floor" });
    assert.deepEqual(resolveComputeUnitLimit(30_000, floor), { units: floor, source: "floor" });
    assert.deepEqual(resolveComputeUnitLimit(floor, floor), { units: floor, source: "floor" });
  });

  it("takes the SDK's figure whenever it is larger — the actual bug", () => {
    // 1,000,000 is the SDK's DEFAULT_ADD_LIQUIDITY_CU: the budget the wide funding
    // path carries, and the one a flat 400k truncated.
    assert.deepEqual(resolveComputeUnitLimit(1_000_000, floor), {
      units: 1_000_000,
      source: "sdk",
    });
    // 350,000 x 2 is two InitializeBinArray instructions, which is what actually blew
    // the meter on 7 Sep 2026.
    assert.equal(resolveComputeUnitLimit(700_000, floor).units, 700_000);
  });

  it("never exceeds Solana's per-transaction ceiling, whoever asked", () => {
    assert.equal(SOLANA_MAX_COMPUTE_UNITS, 1_400_000);
    assert.equal(resolveComputeUnitLimit(5_000_000, floor).units, SOLANA_MAX_COMPUTE_UNITS);
    assert.equal(resolveComputeUnitLimit(null, 9_000_000).units, SOLANA_MAX_COMPUTE_UNITS);
  });

  it("treats a nonsense request as 'no limit stated' rather than as zero", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        resolveComputeUnitLimit(bad, floor).units,
        floor,
        `a requested ${bad} must not starve the transaction`,
      );
    }
  });

  it("is a MAX and not a MIN — the one-line inversion that would restore the bug", () => {
    /*
     * Stated as its own assertion because the inversion is a plausible-looking
     * "optimisation": taking the smaller number does read as cheaper, and the priority
     * fee genuinely is price x REQUESTED units. It is also exactly the defect.
     */
    for (const asked of [1, 100, 399_999, 400_001, 1_000_000, 1_400_000]) {
      const { units } = resolveComputeUnitLimit(asked, floor);
      assert.ok(
        units >= Math.min(asked, SOLANA_MAX_COMPUTE_UNITS),
        `resolved ${units} CU is below the ${asked} CU the SDK asked for`,
      );
      assert.ok(units >= floor, `resolved ${units} CU is below the configured floor`);
    }
  });

  it("reads a limit back out of a built instruction, and is not fooled by a price", async () => {
    const { ComputeBudgetProgram } = await import("@solana/web3.js");

    assert.equal(readRequestedComputeUnits([]), null);
    assert.equal(
      readRequestedComputeUnits([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 777 })]),
      null,
      "a unit PRICE was read as a unit COUNT — they share a programId",
    );
    assert.equal(
      readRequestedComputeUnits([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 777 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 654_321 }),
      ]),
      654_321,
    );
  });

  it("emits exactly one limit and one price, at the resolved figure", async () => {
    const { ComputeBudgetInstruction, ComputeBudgetProgram } = await import("@solana/web3.js");

    const ixs = computeBudgetInstructions(
      { microLamportsPerCu: 50_000, computeUnitLimit: floor, estimatedLamports: 1, source: "floor" },
      1_000_000,
    );

    const limits = ixs.filter(
      (ix) => ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitLimit",
    );
    const prices = ixs.filter(
      (ix) => ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitPrice",
    );

    assert.equal(limits.length, 1, "two compute-unit limits in one transaction is a hard reject");
    assert.equal(prices.length, 1);
    assert.ok(ixs.every((ix) => ix.programId.equals(ComputeBudgetProgram.programId)));
    assert.equal(
      ComputeBudgetInstruction.decodeSetComputeUnitLimit(limits[0]!).units,
      1_000_000,
      "the SDK's larger budget did not reach the built instruction",
    );
  });
});

describe("onchain executor — the bin-array helpers this depends on still exist in the SDK", () => {
  /*
   * The same guard the position-size constants get, for the same reason: an SDK bump
   * that renames one of these makes a destructure yield `undefined`, and the throw
   * lands mid-open — after the balancing swap, with a position account already funded.
   * That is precisely the 0.2657 SOL failure mode. Failing the BUILD is the fix; the
   * runtime check in `preCreateMissingBinArrays` only covers a node_modules that
   * disagrees with the test run.
   */
  it("exports deriveBinArray, getBinArrayIndexesCoverage and BIN_ARRAY_FEE", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const sdk = require("@meteora-ag/dlmm") as Record<string, unknown>;

    assert.equal(typeof sdk.deriveBinArray, "function", "deriveBinArray is gone from the SDK");
    assert.equal(
      typeof sdk.getBinArrayIndexesCoverage,
      "function",
      "getBinArrayIndexesCoverage is gone from the SDK",
    );
    assert.equal(typeof sdk.BIN_ARRAY_FEE, "number", "BIN_ARRAY_FEE is gone from the SDK");
    assert.ok(
      (sdk.BIN_ARRAY_FEE as number) > 0 && (sdk.BIN_ARRAY_FEE as number) < 1,
      "BIN_ARRAY_FEE is meant to be a SOL amount per array (~0.0714)",
    );
  });

  it("still holds 70 bins per array, which is what makes a narrow range span two", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const sdk = require("@meteora-ag/dlmm") as Record<string, unknown>;

    /*
     * Load-bearing for the rehearsal's cost estimate and for reasoning about the
     * narrow path: a range of up to 70 bins straddles TWO bin arrays unless it happens
     * to align to the array boundary, so "narrow" never meant "at most one array".
     */
    assert.equal(Number(String(sdk.MAX_BIN_ARRAY_SIZE)), 70);
  });
});

describe("onchain executor — the SDK still sizes its own transactions on every path we use", () => {
  /*
   * The compute-budget fix rests on one assumption: that the SDK attaches a
   * `setComputeUnitLimit` sized for the call, which `resolveComputeUnitLimit` can then
   * honour. If an SDK bump stopped doing that, every transaction would silently fall
   * back to our configured floor — which is precisely the state that cost real money —
   * and nothing else in the build would notice.
   *
   * Asserted against the shipped build rather than mocked, because the claim is about
   * the installed dependency, not about our code. A failure here is a prompt to
   * re-measure, not necessarily a bug.
   */
  async function sdkSource(): Promise<string> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@meteora-ag/dlmm");
    return readFileSync(entry, "utf8");
  }

  function methodBody(source: string, name: string): string {
    const start = source.indexOf(`async ${name}(`);
    assert.ok(start > 0, `the SDK no longer exposes ${name}`);
    const rest = source.slice(start);
    const end = rest.indexOf("\n  async ", 1);
    return end > 0 ? rest.slice(0, end) : rest.slice(0, 20_000);
  }

  it("sizes the NARROW open path, which is the one a 70-bin range still takes", async () => {
    /*
     * `initializePositionAndAddLiquidityByStrategy` fuses the position create, any
     * missing bin-array inits and the deposit into ONE transaction. A range of up to 70
     * bins spans two bin arrays unless it aligns to the array boundary, so on a thin
     * pool this single transaction can carry two inits at 350k CU each — over any
     * 400k floor. It survives only because the SDK simulates the whole instruction set
     * and asks for what it measured.
     */
    const body = methodBody(await sdkSource(), "initializePositionAndAddLiquidityByStrategy");
    assert.ok(
      body.includes("getEstimatedComputeUnitIxWithBuffer"),
      "the narrow open path no longer attaches a simulated compute budget: it would " +
        "fall back to ONCHAIN_COMPUTE_UNIT_LIMIT, which is the 7 Sep 2026 defect",
    );
    assert.ok(
      body.includes("createBinArraysIfNeeded"),
      "the narrow path no longer inlines bin-array creation — re-check whether " +
        "preCreateMissingBinArrays should now cover it too",
    );
  });

  it("sizes the CLOSE path, where a starved budget is worse than a failed open", async () => {
    /*
     * A close that will not fit its compute budget is the worst failure in the system:
     * the capital is already committed, the row stays ACTIVE, and the stop-loss is what
     * stops being enforceable. This path has never executed against a cluster, so the
     * only evidence available before it does is that the SDK sizes it itself.
     */
    const source = await sdkSource();
    for (const method of ["removeLiquidity", "claimSwapFee"]) {
      assert.ok(
        methodBody(source, method).includes("getEstimatedComputeUnitIxWithBuffer"),
        `${method} no longer attaches a simulated compute budget`,
      );
    }
  });

  it("keeps its own ceiling at Solana's, so our clamp is not silently lowering it", async () => {
    const source = await sdkSource();
    assert.ok(
      source.includes("var MAX_CU = 14e5"),
      "the SDK's MAX_CU moved; SOLANA_MAX_COMPUTE_UNITS should be re-checked against it",
    );
    /*
     * The SDK adds a buffer to its simulated estimate WITHOUT re-clamping to MAX_CU, so
     * a heavy transaction can be handed back above 1.4M and be rejected outright. Our
     * clamp is what stops that, which makes it load-bearing rather than defensive.
     */
    assert.ok(source.includes("var MAX_CU_BUFFER = 2e5"));
  });
});

describe("onchain executor — every builder pins the blockhash the retry loop tracks", () => {
  /*
   * The rebroadcast rule in `sendAndConfirm` is the double-spend guard: the same signed
   * bytes are re-broadcast while their blockhash lives, and a NEW transaction is built
   * only once that blockhash is definitively expired, which makes the old signature
   * permanently unlandable.
   *
   * That argument holds only if the transaction actually CARRIES the blockhash the loop
   * is tracking. `confirmTransaction` is given the loop's blockhash and
   * lastValidBlockHeight, so a transaction stamped with a NEWER one stays landable for
   * a few slots after the loop has declared expiry and moved on to a rebuild — and both
   * can land. CLAUDE.md states this as an invariant; until 7 Sep 2026 the Jupiter swap
   * silently broke it, because Jupiter builds the transaction server-side and stamps its
   * own (necessarily younger) blockhash.
   *
   * Asserted at source level because it is a rule about every FUTURE builder too. A
   * behavioural test cannot reach it: signing requires a private key that CI does not
   * have, by design.
   */
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SOURCE = readFileSync(resolve(HERE, "../services/onchainExecutor.ts"), "utf8");

  it("destructures blockhash in every sendAndConfirm builder", () => {
    // The builder is the callback passed to sendAndConfirm: `async ({ ... }) =>`.
    const builders = [...SOURCE.matchAll(/async \(\{([^}]*)\}\) =>/g)].map((m) => m[1] ?? "");
    assert.ok(builders.length >= 5, `expected several builders, found ${builders.length}`);

    for (const params of builders) {
      assert.ok(
        params.includes("blockhash"),
        `a sendAndConfirm builder takes { ${params.trim()} } and never sees the loop's ` +
          `blockhash: the transaction it builds cannot be pinned to the expiry the ` +
          `retry loop is tracking`,
      );
    }
  });

  it("re-pins the Jupiter transaction BEFORE signing it", () => {
    /*
     * Order matters and is not cosmetic: the signature covers the message, so setting
     * `recentBlockhash` after `signTransaction` would produce bytes the cluster rejects
     * — a change that would look correct in review and fail every live swap.
     */
    const build = SOURCE.slice(
      SOURCE.indexOf("export async function buildJupiterSwap"),
      SOURCE.indexOf("export async function executeJupiterSwap"),
    );
    const pin = build.indexOf("tx.message.recentBlockhash = blockhash.blockhash");
    const sign = build.indexOf("return signTransaction(tx)");

    assert.ok(pin > 0, "the Jupiter swap no longer re-pins to the retry loop's blockhash");
    assert.ok(sign > pin, "the blockhash is pinned AFTER signing, which invalidates the signature");

    /*
     * Required, not optional. Optional made the fix depend on every caller remembering
     * to pass it, policed only by the source-level test above; required makes a caller
     * that forgets a compile error, which is a stronger guard than any test here.
     */
    assert.ok(
      /blockhash: BlockhashWithExpiryBlockHeight,/.test(build),
      "buildJupiterSwap's blockhash parameter is optional again — the compiler no " +
        "longer enforces that callers pin it",
    );
    assert.ok(!build.includes("if (blockhash)"), "the re-pin is guarded, so it can be skipped");
  });
});
