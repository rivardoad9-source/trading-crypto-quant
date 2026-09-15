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
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { isLiveTradingEnabled } from "../config/env.js";
import {
  DLMM_BIN_ARRAY_RENT_SOL,
  DLMM_BINS_PER_INIT,
  DLMM_MAX_BINS_PER_POSITION,
  DLMM_POSITION_BIN_DATA_SIZE,
  DLMM_POSITION_MIN_SIZE,
  HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS,
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
  depositSlippage,
  isInsufficientFundsRejection,
  isSlippageRejection,
  isStaleActiveBinRejection,
  positionHoldsValue,
  dlmmExecutor,
  maxDepositLamports,
  isExecutionArmable,
  DLMM_FUNDING_CU_PER_CHUNK,
  DLMM_FUNDING_CU_PER_BIN_ARRAY_INIT,
  fundingComputeUnits,
  partitionFundingInstructions,
  planPriorityFee,
  readRequestedComputeUnits,
  resolveComputeUnitLimit,
  resolveOnchainConfig,
  resolveSlippageBps,
  solSide,
  type ExecutionAuthorization,
  type OnchainConfig,
  closeRebuildDecision,
  assertQuoteWithinSlippageBound,
  buildJupiterSwap,
  shrinkWideFundingDeposit,
  swapSlippageBoundBps,
  WIDE_FUNDING_MIDFLIGHT_SHRINKS,
  isWithheldFeeCloseRefusal,
  type JupiterQuote,
  type PriorityFeePlan,
} from "../services/onchainExecutor.js";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(srcDir, "..");

/**
 * The executor's own source, for the rules that are only visible at source level —
 * a bound handed to the wrong parameter compiles and runs, it just never lands.
 */
const executorSourceText = readFileSync(join(srcDir, "services/onchainExecutor.ts"), "utf8");

/** A stand-in authorization. Never carries a key — only the public half. */
function auth(overrides: Partial<ExecutionAuthorization> = {}): ExecutionAuthorization {
  return {
    wallet: Keypair.generate().publicKey,
    maxLamportsPerTx: 20_000_000,
    maxSlippageBps: 50,
    maxActiveBinSlippageBps: 300,
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
     * Five entries, and the list is the security boundary — every addition widens who
     * can move funds. `liveExecution.ts` is the bridge the engine goes through; if a
     * sixth file ever needs to be added here, that is the moment to ask whether it
     * should instead call the bridge.
     *
     * `scripts/recoverFundedOrphan.ts` (added 12 Sep 2026) is the same shape of exception
     * as `testMicroSwap.ts`: an operator-run tool, deliberately NOT part of the engine's
     * import graph, with a dry run as its default and `--execute` as the only way to spend.
     * It goes through the executor rather than the bridge because the position it recovers
     * is an ORPHAN — a half-landed open leaves a funded position account with NO
     * `simulated_positions` row, and every bridge entry point keys off a tracked position.
     * The engine itself grew no new caller: it is the operator's tool for the case the
     * engine already gave up on (see docs/incidents/2026-09-12-half-landed-open-orphan-manlet.md).
     *
     * `scripts/retryResidualSweep.ts` (added 12 Sep 2026) is the same shape again: the
     * operator/cron fallback for a residual-token sweep the close could not finish. It is
     * NOT in the engine's import graph, it defaults to a dry run (resolve + read + quote,
     * nothing signed), and it deliberately adds NO swap path of its own — it calls the
     * engine's `sweepResidualPairedToken` + `defaultResidualSweepDeps` from
     * `liveExecution.ts`, so the executor edge here is the same reviewed code the close
     * path uses, not a second implementation. The bridge cannot host it: its close entry
     * point owns a close, and by the time this tool runs the close has already landed and
     * the row is closed.
     */
    const allowed = new Set([
      join(srcDir, "services", "onchainExecutor.ts"),
      join(srcDir, "services", "liveExecution.ts"),
      join(srcDir, "tests", "onchainExecutor.test.ts"),
      join(repoRoot, "scripts", "testMicroSwap.ts"),
      join(repoRoot, "scripts", "recoverFundedOrphan.ts"),
      join(repoRoot, "scripts", "retryResidualSweep.ts"),
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

    // At the CODE defaults DRY_RUN is true, so the flag must be false whatever else is set.
    // No .env is read under the test runner, so a live host cannot turn this red; the armed
    // posture is proven by injection in liveConfig.test.ts "hermetic posture".
    assert.equal(isLiveTradingEnabled, false, "live trading is armed by default");

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

  it("keeps rebuilding long enough for the escalating fee to reach the ceiling", async () => {
    /*
     * 12 Sep 2026, real money. The recovery for a half-landed open — first the Jupiter
     * auto-unwind, then `closeOrphanPosition` — lost THREE rebuilds in a row to
     * `blockhash expired`, at 20 000 / 40 000 / 80 000 micro-lamports per CU (about
     * 0.000016 SOL of priority fee), and gave up. 1.802543 SOL of live capital stayed in
     * a funded position nothing was watching until an operator closed it by hand.
     *
     * The escalation could always reach the ceiling; three attempts just never got there.
     * This binds the budget to the thing that matters: the LAST rebuild is priced at the
     * ceiling, so an expiry there is not a fee problem.
     */
    assert.ok(
      base.maxBuildAttempts >= 8,
      `rebuild budget is ${base.maxBuildAttempts}; a recovery that keeps expiring needs more ` +
        `rounds than the fee needs doublings (8)`,
    );
    const last = await planPriorityFee(base.maxBuildAttempts - 1, base);
    assert.equal(
      last.microLamportsPerCu,
      base.maxPriorityMicroLamports,
      "the last rebuild is not priced at the ceiling, so it can expire for the same reason",
    );
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

  it("mirrors the SDK's bin-array rent, and the live profile agrees with it", async () => {
    /*
     * The one UNRECOVERABLE cost the engine pays. A bin array is a pool-level account
     * shared by every LP: `close_bin_array` is in the IDL, the SDK exposes no wrapper,
     * and nothing here can reclaim the rent. The position account's rent comes back on
     * close; this never does.
     *
     * Bound to the SDK for the same reason the four constants above are, and bound to
     * `liveConfig.ts` as well because the import allowlist forbids that file from
     * reading the executor. So the number is written down in two places by necessity,
     * and this is what stops them drifting apart in silence.
     */
    const sdk = await sdkConstants();
    assert.equal(
      Number(sdk.BIN_ARRAY_FEE),
      DLMM_BIN_ARRAY_RENT_SOL,
      "the SDK's bin-array rent moved; the friction gates are pricing the old figure",
    );

    const liveConfigSource = readFileSync(join(srcDir, "config", "liveConfig.ts"), "utf8");
    const documented = /one bin array is (0\.\d+) SOL/.exec(liveConfigSource);
    if (documented) {
      assert.equal(Number(documented[1]), DLMM_BIN_ARRAY_RENT_SOL);
    }
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

/*
 * THE 8 SEP 2026 ROOT CAUSE, in two halves.
 *
 * The wide (create-then-fund) path had never completed a single live open across three
 * real-money incidents. The standing hypothesis was that the SDK expands the bin range
 * past [minBinId, maxBinId] and touches arrays the probe never checked. It does not —
 * `chunkBinRange` partitions the range contiguously and `getBinArrayIndexesCoverage`
 * returns a contiguous run, so the probe's coverage IS the funding path's coverage.
 *
 * What actually happens is that `addLiquidityByStrategyChunkable` calls
 * `chunkDepositWithRebalanceEndpoint` with `isParallel: true`, and that flag disables
 * two things at once: the existence check before emitting `initializeBinArray`, and the
 * branch that attaches a compute budget at all. So every funding transaction carried
 * full-price no-op inits AND ran on our 400,000 CU floor.
 *
 * These tests bind both facts to the installed SDK bundle, because the constants
 * involved are private to it and cannot be imported.
 */
describe("onchain executor — the wide funding path is sized and stripped by us, not the SDK", () => {
  async function sdkBundle(): Promise<string> {
    const { createRequire } = await import("node:module");
    const req = createRequire(join(repoRoot, "package.json"));
    return readFileSync(req.resolve("@meteora-ag/dlmm"), "utf8");
  }

  it("still finds the SDK's private CU constants at the values we mirror", async () => {
    const source = await sdkBundle();

    /*
     * `DEFAULT_ADD_LIQUIDITY_CU` and `DEFAULT_INIT_BIN_ARRAY_CU` are NOT exported, so
     * they cannot be asserted the way DEFAULT_BIN_PER_POSITION is. Asserting them
     * against the bundle text is the closest binding available, and it is the point of
     * this test: an SDK bump that moves either number should fail the build rather
     * than silently under-size a funding transaction.
     */
    assert.match(
      source,
      /DEFAULT_ADD_LIQUIDITY_CU\s*=\s*1e6/,
      `the SDK's DEFAULT_ADD_LIQUIDITY_CU is no longer 1,000,000 — ` +
        `DLMM_FUNDING_CU_PER_CHUNK (${DLMM_FUNDING_CU_PER_CHUNK}) must be re-derived`,
    );
    assert.match(
      source,
      /DEFAULT_INIT_BIN_ARRAY_CU\s*=\s*35e4/,
      `the SDK's DEFAULT_INIT_BIN_ARRAY_CU is no longer 350,000 — ` +
        `DLMM_FUNDING_CU_PER_BIN_ARRAY_INIT (${DLMM_FUNDING_CU_PER_BIN_ARRAY_INIT}) ` +
        `must be re-derived`,
    );
  });

  it("still exports neither constant, which is why they are hand-written here", async () => {
    const { createRequire } = await import("node:module");
    const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm") as Record<string, unknown>;

    /*
     * If a future SDK starts exporting these, the hand-written copies above should be
     * replaced by the real values and this test deleted. Failing here is good news.
     */
    assert.equal(sdk.DEFAULT_ADD_LIQUIDITY_CU, undefined);
    assert.equal(sdk.DEFAULT_INIT_BIN_ARRAY_CU, undefined);
  });

  it("still builds the chunked funding path with isParallel=true, which suppresses the CU ix", async () => {
    const source = await sdkBundle();

    /*
     * The load-bearing sentence of the whole investigation.
     * `chunkDepositWithRebalanceEndpoint` only attaches setComputeUnitLimit under
     * `if (!isParallel)`, and `addLiquidityByStrategyChunkable` passes true. If a bump
     * changes either, our override becomes redundant rather than wrong —
     * `asVersionedTransaction` takes the MAX of the two — but the reasoning in this
     * file would be stale and should be revisited.
     */
    assert.match(
      source,
      /if \(!isParallel\) \{\s*addLiquidityIxs\.unshift\(/,
      "the SDK no longer gates its funding compute-budget instruction on !isParallel",
    );
  });

  it("sizes a funding chunk at the SDK's own figures, clamped to Solana's ceiling", () => {
    assert.equal(fundingComputeUnits(0), 1_000_000);
    assert.equal(fundingComputeUnits(1), 1_350_000);
    // 1,000,000 + 2 x 350,000 = 1,700,000, above the 1.4M ceiling a tx may request.
    assert.equal(fundingComputeUnits(2), SOLANA_MAX_COMPUTE_UNITS);
    assert.equal(fundingComputeUnits(9), SOLANA_MAX_COMPUTE_UNITS);
    // Nonsense counts must not shrink the budget below one chunk's worth.
    for (const bad of [-1, Number.NaN]) {
      assert.equal(fundingComputeUnits(bad), 1_000_000, `count ${bad}`);
    }
  });

  it("is never the 400,000 floor that killed all three live attempts", () => {
    /*
     * The regression this whole change exists to prevent, written so that it FAILS
     * against the pre-fix code rather than merely passing against the new code.
     *
     * Before the fix, funding transactions carried no budget at all, so `null` reached
     * the resolver and it returned the bare 400,000 floor. Each ComputeBudget
     * instruction costs the runtime 150 CU, so 400,000 - 300 = 399,700 was left for
     * the program — the exact figure the cluster printed in all three incident logs,
     * and reproduced by simulation on 8 Sep 2026 ("consumed 202242 of 399700").
     *
     * A `units > 399_700` assertion would NOT have caught it: the floor itself is
     * 400,000. The assertion has to be that a whole chunk's SDK sizing fits.
     */
    const COMPUTE_BUDGET_IX_COST = 150;
    const preFix = resolveComputeUnitLimit(null, 400_000);
    assert.equal(preFix.source, "floor");
    assert.equal(
      preFix.units - 2 * COMPUTE_BUDGET_IX_COST,
      399_700,
      "the pre-fix budget is the 399,700 from the incident logs; if this moves, the " +
        "story below no longer describes the numbers",
    );

    const { units, source } = resolveComputeUnitLimit(fundingComputeUnits(0), 400_000);
    assert.equal(source, "sdk");
    assert.ok(
      units >= DLMM_FUNDING_CU_PER_CHUNK,
      `a funding chunk must carry at least the ${DLMM_FUNDING_CU_PER_CHUNK} CU the SDK ` +
        `sizes it at, never the ${preFix.units} floor it ran on for three live attempts`,
    );
  });
});

describe("onchain executor — redundant InitializeBinArray instructions are dropped, safely", () => {
  const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const OTHER_PROGRAM = new PublicKey("11111111111111111111111111111111");

  /** Deterministic stand-ins for bin arrays; only identity matters here. */
  const arrayFor = new Map<string, PublicKey>([
    ["-82", new PublicKey("So11111111111111111111111111111111111111112")],
    ["-81", new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")],
    ["-80", new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")],
  ]);
  const derive = (index: string): PublicKey | null => arrayFor.get(index) ?? null;

  function initIx(index: string, binArray: PublicKey | null = null): TransactionInstruction {
    // IDL order: lb_pair, bin_array, funder, system_program.
    return new TransactionInstruction({
      programId: DLMM_PROGRAM,
      keys: [
        { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: binArray ?? derive(index)!, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(index, "utf8"),
    });
  }

  const rebalance = new TransactionInstruction({
    programId: DLMM_PROGRAM,
    keys: [],
    data: Buffer.from("rebalance"),
  });
  const foreign = new TransactionInstruction({
    programId: OTHER_PROGRAM,
    keys: [],
    data: Buffer.from("wrap sol"),
  });

  /** Stands in for the Anchor coder: the instruction's data IS its bin-array index. */
  const decode = (data: Buffer) => {
    const text = data.toString("utf8");
    if (text === "rebalance") return { name: "rebalanceLiquidity" };
    return { name: "initializeBinArray", data: { index: text } };
  };

  it("drops the inits for arrays already on-chain and keeps everything else", () => {
    const existing = new Set([derive("-82")!.toBase58(), derive("-81")!.toBase58()]);
    const { kept, dropped, keptBinArrayInits } = partitionFundingInstructions(
      [initIx("-82"), initIx("-81"), foreign, rebalance],
      DLMM_PROGRAM,
      decode,
      derive,
      existing,
    );

    assert.deepEqual(dropped, ["-82", "-81"]);
    assert.equal(keptBinArrayInits, 0);
    assert.deepEqual(kept, [foreign, rebalance]);
  });

  it("KEEPS an init for an array that genuinely does not exist, and pays for it", () => {
    const { kept, dropped, keptBinArrayInits } = partitionFundingInstructions(
      [initIx("-82"), initIx("-80"), rebalance],
      DLMM_PROGRAM,
      decode,
      derive,
      new Set([derive("-82")!.toBase58()]),
    );

    assert.deepEqual(dropped, ["-82"]);
    assert.equal(keptBinArrayInits, 1, "the missing array's init must survive");
    assert.equal(kept.length, 2);
    // And the budget must grow to cover the init that survived.
    assert.equal(fundingComputeUnits(keptBinArrayInits), 1_350_000);
  });

  it("keeps an init whose named account disagrees with the derived one", () => {
    /*
     * Fail-safe against an IDL reordering. If the account we would derive is not the
     * account the instruction actually names, we do not understand the instruction, and
     * dropping one we do not understand strands the funding. Wasting compute is the
     * cheaper mistake.
     */
    const wrongSlot = initIx("-82", derive("-80")!);
    const { kept, dropped, keptBinArrayInits } = partitionFundingInstructions(
      [wrongSlot, rebalance],
      DLMM_PROGRAM,
      decode,
      derive,
      new Set([derive("-82")!.toBase58(), derive("-80")!.toBase58()]),
    );

    assert.deepEqual(dropped, []);
    assert.equal(keptBinArrayInits, 1);
    assert.equal(kept.length, 2);
  });

  it("keeps everything when the coder throws or returns null", () => {
    const brokenCoders: Array<(d: Buffer) => { name: string } | null> = [
      () => {
        throw new Error("no coder");
      },
      () => null,
    ];
    for (const broken of brokenCoders) {
      const { kept, dropped } = partitionFundingInstructions(
        [initIx("-82"), rebalance],
        DLMM_PROGRAM,
        broken,
        derive,
        new Set([derive("-82")!.toBase58()]),
      );
      assert.deepEqual(dropped, []);
      assert.equal(kept.length, 2);
    }
  });

  it("never touches another program's instructions", () => {
    const { kept, dropped } = partitionFundingInstructions(
      [foreign, foreign],
      DLMM_PROGRAM,
      () => {
        throw new Error("must not be called for a foreign program");
      },
      derive,
      new Set(),
    );
    assert.deepEqual(dropped, []);
    assert.equal(kept.length, 2);
  });
});

/*
 * THE ACTIVE-BIN RACE (9 Sep 2026, real money).
 *
 * The compute-budget defects were fixed on 8 Sep and the next funded wide open still
 * did not land. The funding transactions were rejected by the PROGRAM, not the meter:
 * `ExceededBinSlippageTolerance` (custom 6004).
 *
 * One line of the SDK explains it. `addLiquidityByStrategyChunkable` derives the
 * program's active-bin tolerance from the same `slippage` field that bounds a price:
 *
 *     maxActiveBinSlippage = ceil(slippagePercent / (binStep / 100))
 *
 * and we were handing it Jupiter's 0.5% SWAP bound. On any pool of bin_step 50 or more
 * that ceils to ONE BIN — and the instructions carry the active bin as read at BUILD
 * time, across a window that includes a blockhash lifetime and, on expiry, a rebuild
 * that re-sent the same stale bin with a fresh blockhash and a higher fee.
 *
 * These tests live in this file rather than beside the volatility gate they shipped
 * with because they import the executor, and that import list is a security boundary
 * with four entries. The third fix is in `activeBinSlippage.test.ts`.
 */

async function sdkBundleText(): Promise<string> {
  const { createRequire } = await import("node:module");
  const req = createRequire(join(repoRoot, "package.json"));
  return readFileSync(req.resolve("@meteora-ag/dlmm"), "utf8");
}

describe("active-bin slippage — a bin count, not a loss bound", () => {
  it("mirrors the SDK's tolerance formula, ceil included", async () => {
    const source = await sdkBundleText();

    /*
     * The whole fix rests on this expression. Note it is `getAndCapMaxActiveBinSlippage`
     * but the cap only applies to the DEFAULT branch — a supplied percentage is not
     * capped by the SDK at all, which is why our own hard ceiling has to exist.
     */
    assert.match(
      source,
      /return slippagePercentage \? Math\.ceil\(slippagePercentage \/ \(binStep \/ 100\)\)/,
      "the SDK no longer derives maxActiveBinSlippage as ceil(pct / (binStep/100)) — " +
        "depositSlippage().bins must be re-derived",
    );
  });

  it("buys bins in the units the program rejects on", () => {
    // 3% at bin_step 100 (1% per bin) is 3 bins.
    assert.equal(depositSlippage(auth(), 100).bins, 3);
    // bin_step 20 is 0.2% per bin, so the same 3% is 15 bins.
    assert.equal(depositSlippage(auth(), 20).bins, 15);
    // A sub-bin tolerance still buys one whole bin — that is the ceil, not a rounding
    // convenience, and it is what made the old 0.5% survive at all.
    assert.equal(depositSlippage(auth({ maxActiveBinSlippageBps: 50 }), 250).bins, 1);
  });

  it("is the number the OLD code could not send: 0.5% was one bin on most pools", () => {
    /*
     * The regression this file exists for. At Jupiter's bound, every pool from
     * bin_step 50 up got a single bin of tolerance — including the whole band the
     * 70-bin cap used to admit (bin_step 106 and above).
     */
    for (const binStep of [50, 100, 106, 250]) {
      assert.equal(
        depositSlippage(auth({ maxActiveBinSlippageBps: HARD_MAX_SLIPPAGE_BPS }), binStep).bins,
        1,
        `bin_step ${binStep} at the swap bound`,
      );
    }
    // And what the new default buys on the same pools.
    assert.equal(depositSlippage(auth(), 106).bins, 3);
  });

  it("keeps the two bounds separate, and neither can be widened by configuration", () => {
    assert.notEqual(HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS, HARD_MAX_SLIPPAGE_BPS);

    // Clamped DOWN only, exactly like the swap bound.
    assert.equal(
      resolveOnchainConfig({ ONCHAIN_MAX_ACTIVE_BIN_SLIPPAGE_BPS: "5000" })
        .maxActiveBinSlippageBps,
      HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS,
    );
    assert.equal(
      resolveOnchainConfig({ ONCHAIN_MAX_ACTIVE_BIN_SLIPPAGE_BPS: "120" })
        .maxActiveBinSlippageBps,
      120,
    );
    // Widening the bin tolerance must not touch the swap bound.
    assert.equal(
      resolveOnchainConfig({ ONCHAIN_MAX_ACTIVE_BIN_SLIPPAGE_BPS: "1000" }).maxSlippageBps,
      HARD_MAX_SLIPPAGE_BPS,
    );

    // A hand-built config cannot get past authorizeExecution either.
    const overWide = {
      armed: true,
      maxLamportsPerTx: 1_000,
      maxSlippageBps: HARD_MAX_SLIPPAGE_BPS,
      maxActiveBinSlippageBps: HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS + 1,
      computeUnitLimit: 400_000,
      minPriorityMicroLamports: 1,
      maxPriorityMicroLamports: 2,
      priorityEscalation: 2,
      maxBuildAttempts: 3,
      jupiterSwapApiUrl: "https://example.invalid",
    } as OnchainConfig;
    assert.throws(() => authorizeExecution(overWide), /active-bin slippage/);
  });

  it("refuses a nonsense tolerance or bin step rather than sending one", () => {
    for (const bad of [0, -1, Number.NaN]) {
      assert.throws(() => depositSlippage(auth(), 100, bad), ExecutionLimitError, `bps ${bad}`);
    }
    for (const bad of [0, -100, Number.NaN]) {
      assert.throws(() => depositSlippage(auth(), bad), ExecutionLimitError, `binStep ${bad}`);
    }
  });

  it("no longer hands the swap bound to the deposit", () => {
    /*
     * Source-level, because the defect was invisible at runtime: both numbers are
     * "slippage", both are valid, and the wrong one produced a position that simply
     * never funded. A reintroduction would look like a cleanup.
     */
    assert.doesNotMatch(
      executorSourceText,
      /slippage:\s*slippageBps\s*\/\s*100/,
      "the DLMM deposit is taking Jupiter's price-slippage bound again",
    );
    assert.match(executorSourceText, /slippage:\s*slip\.percent/);
  });
});

describe("active-bin slippage — widening it widens what the program may pull", () => {
  it("mirrors the SDK's max-deposit formula", async () => {
    const source = await sdkBundleText();
    assert.match(
      source,
      /mul\(new \(0, _decimaljs2\.default\)\(100 \+ slippage\)\)\.div\(new \(0, _decimaljs2\.default\)\(100\)\)\.floor\(\)/,
      "the SDK no longer sizes maxDepositAmount as floor(amount x (100 + pct) / 100)",
    );
  });

  it("charges the widened figure, not the nominal one", () => {
    const { depositCeilingFactor } = depositSlippage(auth(), 100);
    // 3% over 1 SOL.
    assert.equal(maxDepositLamports(1_000_000_000, depositCeilingFactor), 1_030_000_000);
    // Floor, like the SDK's.
    assert.equal(maxDepositLamports(101, depositCeilingFactor), 104);

    /*
     * The reason this matters at all: the spend ceiling has to face the number the
     * transaction can actually move. Charging the nominal deposit while authorising a
     * 3% larger pull is the same defect class this file already fixed for bin-array
     * rent — an advertised bound that is not the enforced one.
     */
    assert.match(
      executorSourceText,
      /maxDepositLamports\(params\.amountLamports, slip\.depositCeilingFactor\) \+\s*\n\s*positionRentLamports/,
      "the narrow path is charging the nominal deposit to the spend ceiling again",
    );
    assert.match(
      executorSourceText,
      /maxDepositLamports\(params\.amountLamports, slip\.depositCeilingFactor\) \+\s*\n\s*binArrayRentLamports/,
      "the wide path is charging the nominal deposit to the spend ceiling again",
    );
  });
});

describe("wide funding — a rebuild carries a fresh active bin", () => {
  it("refetches pool state before rebuilding, or the rebuild is a no-op", () => {
    /*
     * The SDK builds from `this.lbPair`, which it CACHES. Without the refetch,
     * `addLiquidityByStrategyChunkable` hands back byte-identical instructions and the
     * only thing the rebuild changes is the fee — escalating the price of a
     * transaction that is going to be rejected for the same reason.
     */
    const rebuild = executorSourceText.slice(
      executorSourceText.indexOf("rebuild: async (index, attempt)"),
      executorSourceText.indexOf("prepare: (legacy)"),
    );
    assert.ok(rebuild.length > 0, "the wide funding path no longer passes a rebuild");
    assert.match(rebuild, /await pool\.refetchStates\(\)/);
    assert.ok(
      rebuild.indexOf("refetchStates") < rebuild.indexOf("addLiquidityByStrategyChunkable"),
      "the pool is rebuilt from state it read BEFORE refetching",
    );
  });

  it("treats the OTC-SOL rejection as rebuildable, by name and by raw code", () => {
    /*
     * The exact text from the 9 Sep 2026 incident. It is matched two ways because the
     * two layers report it differently: the cluster's simulation LOGS carry the Anchor
     * name, while the error MESSAGE that reaches us usually carries only the hex.
     * Matching one and not the other passes a unit test and fails on the wallet.
     */
    const message =
      "Transaction simulation failed: Error processing Instruction 6: " +
      "custom program error: 0x1774";
    const logs = [
      "Program log: Instruction: RebalanceLiquidity",
      "Program log: AnchorError: ExceededBinSlippageTolerance. Error Number: 6004.",
    ];

    assert.equal(isStaleActiveBinRejection(logs, message), true);
    assert.equal(isStaleActiveBinRejection(null, message), true, "raw hex alone");
    assert.equal(isStaleActiveBinRejection(logs, ""), true, "logs alone");

    // Everything else stays terminal. A compute overflow rebuilt identically is the
    // 7 Sep failure repeated at a higher fee.
    assert.equal(
      isStaleActiveBinRejection(
        ["Program failed to complete: exceeded CUs meter at BPF instruction"],
        "Transaction simulation failed: exceeded compute budget",
      ),
      false,
    );
    assert.equal(isStaleActiveBinRejection(null, "custom program error: 0x1775"), false);
  });

  it("rebuilds a PREFLIGHT rejection, which is where the incident actually died", () => {
    /*
     * Without this the rebuild is dead code on the incident it was written for.
     * `sendAndConfirm` rebuilds only after a blockhash EXPIRES, and the OTC-SOL funding
     * transaction never got that far — it was refused in simulation, so the terminal
     * branch threw on the first and only attempt.
     *
     * Rebuilding here is SAFER than the expiry path, not looser: preflight means
     * nothing was broadcast, where expiry only means the old bytes can no longer land.
     */
    const guard = executorSourceText.slice(
      executorSourceText.indexOf("const preflight = preflightRejection(err);"),
      executorSourceText.indexOf("const status = await conn.getSignatureStatus(signature)"),
    );
    assert.match(guard, /options\.rebuildableRejection\?\.\(preflight\.logs, message\) === true/);
    assert.match(guard, /attempt \+ 1 < config\.maxBuildAttempts/);
    // It must CONTINUE the loop, not fall through to the terminal throw.
    // Anchored on the TERMINAL message, not on "rejected at preflight" — the new
    // warn line contains that phrase too, and matching it would pass either way.
    assert.ok(guard.indexOf("continue;") < guard.indexOf("so it never reached the network"));

    // And the wide funding path is what supplies it — the stale-bin rejection still, and
    // since 15 Sep 2026 the mid-flight shortfall as well (see the LEVERCAT-SOL block below).
    assert.match(executorSourceText, /rebuildableRejection: fundingRejection/);
    const handler = executorSourceText.slice(
      executorSourceText.indexOf("const fundingRejection = "),
      executorSourceText.indexOf("const { deriveBinArray } = await loadDlmmSdk();"),
    );
    assert.match(handler, /if \(isStaleActiveBinRejection\(logs, message\)\) return true;/);
  });

  it("only rebuilds on a later attempt, which is what keeps the retry rule intact", () => {
    /*
     * `sendAndConfirm` invokes its builder on the first attempt and then only after the
     * previous blockhash EXPIRED, which makes the previous signature permanently
     * unlandable. Rebuilding there is as safe as re-blockhashing, which that loop
     * already does — but only there. A rebuild on any other path would be building a
     * second transaction on top of one that may still be in flight.
     */
    assert.match(executorSourceText, /if \(attempt > 0 && context\.rebuild\)/);
  });

  it("refuses a rebuild that partitions the deposit differently", () => {
    /*
     * The chunk index is a position in a sequence, and part of that sequence may
     * already have landed. If a rebuild returns a different number of chunks, index i
     * no longer means the same bin range, and funding it would deposit into the wrong
     * one. Fail-closed: the partial-execution error names what landed.
     */
    assert.match(
      executorSourceText,
      /if \(fresh\.length !== transactions\.length\) \{[\s\S]{0,400}?refusing to map/,
    );
  });

  it("re-prepares the rebuilt transaction, so the CU budget and init-drop still apply", () => {
    /*
     * `prepare` supplies the compute budget the SDK declines to attach and drops the
     * redundant `initializeBinArray` instructions. Running it only on the first build
     * would send a rebuilt transaction with neither — reintroducing the 8 Sep failure
     * on the retry path only, where it would look like a different bug.
     */
    const loop = executorSourceText.slice(
      executorSourceText.indexOf("for (const [index, original] of transactions.entries())"),
      executorSourceText.indexOf("return landed;"),
    );
    assert.ok(loop.indexOf("source = replacement") < loop.indexOf("context.prepare?.(source)"));
  });
});

/**
 * The executor's half of the 10 Sep 2026 KNOTS-SOL failure — a wide open whose funding
 * transactions HALF-LANDED, leaving a real, funded, unmonitored position on-chain.
 *
 * The bridge's half (what to do about it, and in what order) is
 * `src/tests/orphanRecovery.test.ts`. These are the executor's: reading a position by
 * ADDRESS rather than by owner scan, recovering it with a withdraw-claim-close rather
 * than a close that cannot withdraw, and — on the narrow path, which is atomic and was
 * therefore never suspected — not sending the fused open blind in the first place.
 */
describe("onchain executor — recovering a position the owner index cannot see", () => {
  const executorSource = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");

  /** The body of one method of the `dlmmExecutor` object literal. */
  function adapterMethod(name: string): string {
    const adapter = executorSource.slice(executorSource.indexOf("export const dlmmExecutor"));
    const start = adapter.indexOf(`  async ${name}(`);
    assert.ok(start > 0, `the adapter no longer defines ${name}`);
    const rest = adapter.slice(start);
    const end = rest.indexOf("\n  async ", 1);
    return end > 0 ? rest.slice(0, end) : rest;
  }

  it("does not route the orphan close through the owner scan", () => {
    /*
     * `getPositionsByUserAndLbPair` is a getProgramAccounts scan, and an index can lag an
     * account created seconds ago. `requirePosition`'s fail-closed refusal is right when
     * the caller knows only the owner, and wrong here, where the caller already holds the
     * address the failure named — that refusal IS the bug being fixed: the engine cannot
     * close what it cannot see.
     */
    const body = adapterMethod("closeOrphanPosition");
    assert.ok(!body.includes("requirePosition"), "the orphan close uses the owner-scan lookup");
    assert.ok(
      !body.includes("getPositionsByUserAndLbPair"),
      "the orphan close scans by owner instead of reading the account",
    );
    assert.match(body, /readPositionDirect\(/);
  });

  it("verifies identity with the SDK's own memcmp offsets, never hand-written ones", () => {
    /*
     * A direct read loses the scan's implicit proof of ownership, so it is re-established
     * explicitly — and from `positionLbPairFilter` / `positionOwnerFilter`, which are
     * exactly what the scan filters on, so an SDK that moves the layout moves both
     * together. Hand-writing 8 and 40 would keep compiling after such a change and
     * silently compare the wrong bytes, and a check that always passes is worse than no
     * check at all.
     */
    const direct = executorSource.slice(
      executorSource.indexOf("async function readPositionDirect"),
      executorSource.indexOf("export function positionHoldsValue"),
    );
    assert.ok(direct.length > 0, "readPositionDirect is gone");
    assert.match(direct, /positionLbPairFilter\(pool\.pubkey\)/);
    assert.match(direct, /positionOwnerFilter\(owner\)/);
    assert.match(direct, /memcmp\.offset/);
    assert.ok(
      !/subarray\(\s*(8|40)\s*,/.test(direct),
      "the position layout offsets are hand-written again",
    );
    // An account that is there but is not ours must throw, not be acted on.
    assert.match(direct, /Refusing to act on it/);
  });

  it("still demands an authorization to close anything", () => {
    assert.match(
      executorSource,
      /closeOrphanPosition\(\s*\n?\s*auth: ExecutionAuthorization/,
      "closeOrphanPosition no longer requires an ExecutionAuthorization",
    );
  });

  it("withdraws and claims rather than closing, through the same helper as a real close", () => {
    /*
     * `closePosition` does not withdraw — which is why the wide path's own auto-close was
     * refused by the program on the KNOTS-SOL account while logging "could not auto-close
     * unfunded position" about a position that was funded and earning. Recovery needs
     * removeLiquidity(10 000 bps) + shouldClaimAndClose, and it shares ONE implementation
     * with the tracked close so the recovery path cannot drift into closing without
     * claiming the fees the close would otherwise discard with the account.
     */
    assert.match(adapterMethod("closeOrphanPosition"), /withdrawClaimAndClose\(/);
    assert.match(adapterMethod("closePosition"), /withdrawClaimAndClose\(/);
    const helper = executorSource.slice(
      executorSource.indexOf("async function withdrawClaimAndClose"),
      executorSource.indexOf("export const dlmmExecutor"),
    );
    assert.match(helper, /bps: new BN\(10_000\)/);
    assert.match(helper, /shouldClaimAndClose: true/);
  });

  it("does not send a doomed close at a position it can see is funded", () => {
    // The wide path's own auto-close now ASKS whether the position is empty instead of
    // assuming it. A read that fails still falls through to attempting the close.
    const wide = executorSource.slice(executorSource.indexOf("BEST-EFFORT AUTO-CLOSE"), -1);
    assert.match(wide.slice(0, 3_000), /positionHoldsValue\(existing\.positionData\)/);
    assert.match(wide.slice(0, 3_000), /NOT auto-closing/);
  });

  it("counts UNCLAIMED FEES as worth recovering, not only liquidity", () => {
    /*
     * An empty-binned position can still carry unclaimed swap fees, and closing it
     * without claiming throws them away with the account. `shouldClaimAndClose` takes
     * both in one operation, which is why one predicate answers both questions.
     */
    const zero = { isZero: () => true };
    const some = { isZero: () => false };
    assert.equal(
      positionHoldsValue({ totalXAmount: "0", totalYAmount: "0", feeX: some, feeY: zero }),
      true,
    );
    assert.equal(
      positionHoldsValue({ totalXAmount: "0", totalYAmount: "0", feeX: zero, feeY: some }),
      true,
    );
    assert.equal(
      positionHoldsValue({ totalXAmount: "0", totalYAmount: "0", feeX: zero, feeY: zero }),
      false,
    );
  });

  it("reads held amounts exactly, past the precision Number would lose", () => {
    // Base units routinely exceed 2^53. A comparison routed through Number could read a
    // held balance as zero and abandon the position this whole path exists to recover.
    const zero = { isZero: () => true };
    assert.equal(
      positionHoldsValue({
        totalXAmount: "9007199254740993",
        totalYAmount: "0",
        feeX: zero,
        feeY: zero,
      }),
      true,
    );
    assert.equal(
      positionHoldsValue({ totalXAmount: "000", totalYAmount: "0", feeX: zero, feeY: zero }),
      false,
    );
  });
});

describe("onchain executor — the narrow fused open is no longer sent blind", () => {
  const executorSource = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
  const narrow = executorSource.slice(
    executorSource.indexOf("SIMULATE BEFORE SENDING"),
    executorSource.indexOf("Wide range: create the account first"),
  );

  it("tells a shortfall apart from a stale active bin", () => {
    /*
     * Two rejections, two remedies, and the codes look alike in a log. The SPL token
     * program's InsufficientFunds is custom 0x1; the active-bin one is 0x1774. Matching
     * 0x1 loosely would send the active-bin failure down the re-quote path, shrinking a
     * deposit that was never short while leaving the real cause unaddressed.
     */
    assert.equal(
      isInsufficientFundsRejection(
        null,
        "Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1",
      ),
      true,
    );
    assert.equal(
      isInsufficientFundsRejection(["Program log: Error: insufficient funds"], "failed"),
      true,
    );
    // The form a SIMULATION actually returns — structured JSON, not a log line, and this
    // is read from a simulation. Missing it would send the fixable failure down the
    // terminal branch whenever the RPC returned no logs.
    assert.equal(
      isInsufficientFundsRejection(null, JSON.stringify({ InstructionError: [4, { Custom: 1 }] })),
      true,
    );

    assert.equal(isInsufficientFundsRejection(null, "custom program error: 0x1774"), false);
    assert.equal(
      isInsufficientFundsRejection(
        null,
        JSON.stringify({ InstructionError: [4, { Custom: 6004 }] }),
      ),
      false,
    );
    assert.equal(isStaleActiveBinRejection(null, "custom program error: 0x1774"), true);
    assert.equal(
      isInsufficientFundsRejection(
        ["Error Number: 6004. Error Message: ExceededBinSlippageTolerance."],
        "x",
      ),
      false,
    );
  });

  it("tells a stale SWAP QUOTE apart from the stale-active-bin and shortfall refusals", () => {
    /*
     * Third sibling, third remedy. Jupiter's `SlippageToleranceExceeded` is 0x1771 (6001);
     * the DLMM active-bin refusal is 0x1774 (6004). One hex digit apart, opposite fixes: a
     * stale QUOTE has to be re-fetched (rebuilding against it repeats the refusal forever —
     * 12 Sep 2026, eight identical rebuilds and the entry aborted), while the deposit-side
     * refusals are fixed by rebuilding from CURRENT state.
     */
    assert.equal(
      isSlippageRejection(
        null,
        "Transaction simulation failed: Error processing Instruction 6: custom program error: 0x1771",
      ),
      true,
    );
    assert.equal(
      isSlippageRejection(
        ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771"],
        "failed",
      ),
      true,
    );
    assert.equal(
      isSlippageRejection(["Error Number: 6001. Error Message: SlippageToleranceExceeded."], "x"),
      true,
    );

    // The lookalikes must not match: each one belongs to a different remedy.
    assert.equal(isSlippageRejection(null, "custom program error: 0x1774"), false);
    assert.equal(isSlippageRejection(null, JSON.stringify({ Custom: 6004 })), false);
    assert.equal(isSlippageRejection(null, "custom program error: 0x1"), false);
    assert.equal(isSlippageRejection([], "blockhash expired: block height exceeded"), false);
  });

  it("simulates the fused transaction before sending it", () => {
    /*
     * The rehearsal deliberately skips this transaction — the deposit cannot be simulated
     * before the swap that funds it — so nothing between the swap and the cluster ever
     * looked at it. The SDK does simulate it, but only to SIZE a compute budget:
     * `getEstimatedComputeUnitIxWithBuffer` swallows a failed simulation and falls back to
     * 1.4M CU, so a transaction the cluster has already refused is packaged with a bigger
     * budget and sent anyway.
     */
    assert.ok(narrow.length > 0, "the narrow path no longer simulates before sending");
    assert.match(narrow, /await simulateAgainstCluster\(/);
    assert.ok(
      narrow.indexOf("simulateAgainstCluster") < narrow.indexOf("await sendAndConfirm"),
      "the simulation no longer runs before the send",
    );
    assert.match(narrow, /REFUSED IN SIMULATION and NOT ` \+\s*\n\s*`SENT/);
  });

  it("sends anyway when the simulation could not RUN", () => {
    // An RPC that did not answer is not evidence the open would fail. Failing closed on a
    // provider hiccup would strand the swap for a reason that has nothing to do with the
    // pool — the same rule the rehearsal follows.
    assert.match(narrow, /if \(!sim\.ran\) \{[\s\S]{0,400}?break;/);
  });

  it("re-quotes DOWN only, and against the chain rather than the caller's read", () => {
    // BN.min: a balance that reads LARGER must never raise the deposit — that would spend
    // money on an instruction nobody authorised.
    assert.match(narrow, /BN\.min\(pairedForDeposit, new BN\(onChain\.toString\(\)\)\)/);
    assert.match(narrow, /readAtaBalance\(auth\.wallet, pairedMint, pairedTokenProgram\)/);
    // An unreadable balance is null, never 0, or the re-quote would deposit nothing and
    // report that as the position's funding.
    const helper = executorSource.slice(
      executorSource.indexOf("async function readAtaBalance"),
      executorSource.indexOf("Submits a sequence of SDK transactions"),
    );
    assert.match(helper, /NULL, never 0/);
  });

  it("bounds the re-quote, because the swap has already spent", () => {
    assert.match(executorSource, /const NARROW_OPEN_REQUOTE_ATTEMPTS = 2;/);
    assert.match(
      executorSource,
      /attempt >= NARROW_OPEN_REQUOTE_ATTEMPTS \|\| \(!stale && !short\)/,
      "the retry bound or the un-retryable branch is gone",
    );
  });

  it("reports the amount the chain was asked for, not the one the caller read", () => {
    /*
     * A re-quote makes the caller's pre-open balance read stale, and `depositedPairedAmount`
     * is written to the position row. The executor is the only party that knows what the
     * deposit actually carried, so it returns it.
     */
    assert.match(executorSource, /export interface DlmmOpenResult extends DlmmSendResult/);
    assert.match(executorSource, /depositedPairedAmount: pairedForDeposit\.toString\(\)/);
  });

  it("keeps the rehearsal and the pre-send check on ONE budget resolver", () => {
    /*
     * A simulation run against a different compute limit than production uses passes
     * exactly the transactions production then fails. Two copies of that resolution is how
     * the two drift apart, so there is one.
     */
    const helper = executorSource.slice(
      executorSource.indexOf("async function simulateAgainstCluster"),
      executorSource.indexOf("A DRESS REHEARSAL"),
    );
    assert.match(helper, /resolveComputeUnitLimit\(requested, config\.computeUnitLimit\)/);
    assert.equal(
      (executorSource.match(/await simulateAgainstCluster\(/g) ?? []).length,
      3,
      "a fourth simulation site appeared, or one stopped using the shared resolver",
    );
  });
});

describe("onchain executor — every live swap re-quotes a stale quote", () => {
  /*
   * 12 Sep 2026, EMBER-SOL: the balancing swap was rebuilt EIGHT times against one quote and
   * every attempt was refused for 0.5% of drift, so the entry aborted with nothing spent. A
   * quote is the one input a rebuild cannot refresh (`buildJupiterSwap` is handed the same
   * `quote`), so the retry has to happen one level up.
   */
  const liveSource = readFileSync(join(srcDir, "services", "liveExecution.ts"), "utf8");

  it("routes all three live swaps through the fresh-quote helper", () => {
    assert.equal(
      (liveSource.match(/await executeJupiterSwapFreshQuote\(/g) ?? []).length,
      3,
      "a live swap no longer re-quotes a stale quote (balancing swap, auto-unwind, residual sale)",
    );
    assert.equal(
      (liveSource.match(/await executeJupiterSwap\(/g) ?? []).length,
      1,
      "a swap bypasses the helper and would burn its rebuilds on a stale quote",
    );
  });

  it("retries ONLY a slippage refusal, so an unknown outcome is never retried", () => {
    assert.match(liveSource, /isSlippageRejection\(logs, message\)/);
    assert.match(liveSource, /const SWAP_REQUOTE_ATTEMPTS = 2;/);
    // The retry must be gated on the refusal type and the attempt bound together.
    assert.match(
      liveSource,
      /if \(!isSlippageRejection\(logs, message\) \|\| attempt >= SWAP_REQUOTE_ATTEMPTS\) throw err;/,
    );
  });
});

describe("onchain executor — the WIDE funding path proves it can pay before it sends", () => {
  /*
   * 12 Sep 2026: chunk 1 of a wide funding sequence landed, chunk 2 was refused for
   * `insufficient funds`, and the result was a FUNDED position account with no
   * `simulated_positions` row — capital nothing was watching until an operator closed it by
   * hand. The narrow path could not have failed that way, because it simulates and re-quotes
   * before it sends. These tests hold the port in place.
   */
  const executorSource = readFileSync(join(srcDir, "services", "onchainExecutor.ts"), "utf8");
  const wide = executorSource.slice(
    executorSource.indexOf("PROVE THE SEQUENCE IS PAYABLE BEFORE ANY OF IT LANDS"),
    executorSource.indexOf(`operation: "openPosition (fund wide position)"`),
  );

  it("simulates the whole chunk sequence, and refuses instead of sending a short one", () => {
    assert.ok(wide.length > 0, "the pre-send funding check is gone");
    assert.match(wide, /await firstShortFundingChunk\(liquidityTxs, auth\.wallet\)/);
    // A THROW, before the send — not a comment about one.
    assert.match(wide, /was REFUSED IN SIMULATION and NOT/);
  });

  it("re-quotes DOWN only, and against the chain rather than the caller's read", () => {
    assert.match(wide, /BN\.min\(pairedForDeposit, new BN\(onChain\.toString\(\)\)\)/);
    assert.match(wide, /readAtaBalance\(auth\.wallet, pairedMint, pairedTokenProgram\)/);
  });

  it("bounds the re-quote, and keeps the mid-flight rebuild at the re-quoted figure", () => {
    assert.match(executorSource, /const WIDE_FUNDING_REQUOTE_ATTEMPTS = 2;/);
    assert.match(wide, /attempt >= WIDE_FUNDING_REQUOTE_ATTEMPTS/);
    /*
     * The rebuild closure used to rebuild from the ORIGINAL paired figure. With a re-quote in
     * place that would undo the shrink on the retry meant to rescue it, so every site that
     * builds chunks must read the mutable value: the first build, the re-quote rebuild, and
     * the mid-flight rebuild closure.
     */
    assert.equal(
      (executorSource.match(/addLiquidityByStrategyChunkable\(depositFor\(pairedForDeposit\)\)/g) ?? [])
        .length,
      3,
      "a chunk build went back to a figure other than the re-quoted paired amount",
    );
    assert.equal(
      (executorSource.match(/addLiquidityByStrategyChunkable\(deposit\)/g) ?? []).length,
      0,
      "a chunk is still built from the bound-once deposit",
    );
  });
});

describe("closeRebuildDecision — a close is rebuilt only while the position still exists", () => {
  it("stops ONLY on an absent account; present or unreadable rebuilds as before", () => {
    assert.equal(closeRebuildDecision("absent"), "stop-already-closed");
    assert.equal(closeRebuildDecision("funded"), "rebuild");
    assert.equal(closeRebuildDecision("empty"), "rebuild");
    /*
     * The asymmetry is the point. Stopping on "unreadable" would abandon an open position
     * because an RPC timed out; rebuilding on "absent" sends a close the program must refuse
     * and leaves the row ACTIVE for a position that no longer exists.
     */
    assert.equal(closeRebuildDecision("unreadable"), "rebuild");
  });
});

/*
 * 15 Sep 2026, LEVERCAT-SOL: "Auto-unwind back to SOL FAILED ([onchain] Jupiter returned a quote
 * at 300 bps slippage, above the authorized 50 bps)". The quote was FETCHED at the exit bound
 * and CHECKED against the entry bound. These fail against the pre-fix `buildJupiterSwap`, which
 * compared every quote with `auth.maxSlippageBps`.
 */
describe("exit-leg swaps are checked against the bound they were quoted with", () => {
  const EXIT_300 = { exitMaxSlippageBps: 300 };
  const quoteAt = (slippageBps: number): JupiterQuote => ({
    inputMint: "LeverCatMint11111111111111111111111111111111",
    outputMint: WSOL_MINT,
    inAmount: "40053970000",
    outAmount: "793026000",
    otherAmountThreshold: "769235220",
    slippageBps,
    priceImpactPct: "0",
    routePlan: [],
  });
  const plan = { microLamportsPerCu: 20_000, computeUnitLimit: 400_000, estimatedLamports: 8_000 } as PriorityFeePlan;
  const blockhash = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  const config = { ...resolveOnchainConfig({}), exitMaxSlippageBps: 300 } as OnchainConfig;

  /** Stubs Jupiter's /swap so a quote that PASSES the guard fails visibly one step later. */
  async function buildWith(quote: JupiterQuote, bound: { leg: "entry" | "exit"; bps: number }): Promise<unknown> {
    const realFetch = globalThis.fetch;
    let swapCalled = false;
    globalThis.fetch = (async () => {
      swapCalled = true;
      return new Response("stubbed: no network in tests", { status: 599 });
    }) as typeof fetch;
    try {
      await buildJupiterSwap(auth(), quote, plan, config, blockhash, bound);
      return "built";
    } catch (err) {
      return swapCalled ? "reached /swap" : err;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("an exit quote AT the exit cap passes the guard", async () => {
    assert.equal(swapSlippageBoundBps(auth(), "exit", undefined, EXIT_300), 300);
    assert.equal(await buildWith(quoteAt(300), { leg: "exit", bps: 300 }), "reached /swap");
  });

  it("the same quote as an entry — or with no exit bound — is refused before any request", async () => {
    const refused = await buildWith(quoteAt(300), { leg: "entry", bps: 50 });
    assert.ok(refused instanceof ExecutionLimitError);
    assert.match((refused as Error).message, /quote at 300 bps slippage, above the authorized 50 bps \(entry leg\)/);
    // An entry cannot borrow the exit cap by passing a wide bound: re-clamped to 50.
    const widened = await buildWith(quoteAt(300), { leg: "entry", bps: 300 });
    assert.ok(widened instanceof ExecutionLimitError);
    assert.equal(swapSlippageBoundBps(auth(), "entry", 400, EXIT_300), 50, "an entry never resolves past 50");
  });

  it("an exit quote ABOVE the exit cap still throws (fail-closed)", async () => {
    const above = await buildWith(quoteAt(301), { leg: "exit", bps: 300 });
    assert.ok(above instanceof ExecutionLimitError);
    // A bound wider than the cap is re-clamped, not trusted.
    const wide = await buildWith(quoteAt(450), { leg: "exit", bps: 5_000 });
    assert.ok(wide instanceof ExecutionLimitError);
    assert.throws(() => assertQuoteWithinSlippageBound(auth(), { slippageBps: Number.NaN }, { leg: "exit", bps: 300 }, EXIT_300));
  });

  it("each rung of the residual ladder is checked against ITS OWN bound", () => {
    // Jupiter echoes the requested bound; the rung's quote must pass at that rung.
    for (const rung of [50, 150, 300]) {
      const bound = swapSlippageBoundBps(auth(), "exit", rung, EXIT_300);
      assert.equal(bound, rung);
      assert.doesNotThrow(() => assertQuoteWithinSlippageBound(auth(), { slippageBps: rung }, { leg: "exit", bps: bound }, EXIT_300));
      // …and a quote echoing a WIDER bound than that rung asked for is refused.
      assert.throws(() => assertQuoteWithinSlippageBound(auth(), { slippageBps: rung + 1 }, { leg: "exit", bps: bound }, EXIT_300), ExecutionLimitError);
    }
  });

  it("executeJupiterSwap quotes and checks with ONE derived bound", () => {
    const exec = executorSourceText.slice(
      executorSourceText.indexOf("export async function executeJupiterSwap"),
      executorSourceText.indexOf("/* Token account housekeeping"),
    );
    assert.match(exec, /const slippageBps = swapSlippageBoundBps\(auth, leg, params\.slippageBps, config\);/);
    assert.match(exec, /buildJupiterSwap\(auth, quote, plan, config, blockhash, \{ leg, bps: slippageBps \}\)/);
    assert.equal(/quote\.slippageBps > auth\.maxSlippageBps/.test(executorSourceText), false, "the entry-bound comparison is back");
  });
});

/*
 * 15 Sep 2026, LEVERCAT-SOL, the half-landing: chunk 1 landed, chunk 2 was rebuilt against a moved
 * pool with the ORIGINAL paired total and refused for insufficient funds — terminal, because only
 * a stale active bin was rebuildable and the rebuild never re-read the wallet.
 */
describe("closeEmptyTokenAccount — a Token-2022 withheld fee is an outcome, not a throw", () => {
  it("recognises tonight's refusal text, and nothing else", () => {
    assert.equal(isWithheldFeeCloseRefusal("Error: An account can only be closed if its withheld fee balance is zero"), true);
    assert.equal(isWithheldFeeCloseRefusal("", ["Program log: Error: AccountHasWithheldTransferFees"]), true);
    assert.equal(isWithheldFeeCloseRefusal("Transaction simulation failed: insufficient funds"), false);
  });

  it("asks before sending, and maps a send refusal to the same outcome", () => {
    const close = executorSourceText.slice(
      executorSourceText.indexOf("export async function closeEmptyTokenAccount"),
      executorSourceText.indexOf("async function withheldTransferFeeOf"),
    );
    assert.ok(close.indexOf("withheldTransferFeeOf(connection, ata)") < close.indexOf("createCloseAccountInstruction(ata"));
    assert.match(close, /if \(isWithheldFeeCloseRefusal\(message, logs\)\) \{\s*return \{ state: "withheld-fee"/);
  });
});

describe("wide funding — a chunk refused mid-flight for insufficient funds is shrunk once", () => {
  const funding = executorSourceText.slice(
    executorSourceText.indexOf("MID-FLIGHT SHORTFALL"),
    executorSourceText.indexOf("prepare: (legacy)"),
  );

  it("sizes the remaining chunks against what the landed ones left", () => {
    // The incident's shape: 40 376.32 delivered, 14 577.09 taken by chunk 1, 3% deposit slippage.
    const next = shrinkWideFundingDeposit({
      planned: 40_376_320_000n,
      balanceAtStart: 40_376_320_000n,
      balanceNow: 25_799_230_350n,
      slippagePercent: 3,
    });
    assert.ok(next !== null);
    const remainingAfter = next - 14_577_089_650n; // what the unlanded chunks now ask for, at plan
    assert.ok(remainingAfter * 103n <= 25_799_230_350n * 100n, `remaining ${remainingAfter} does not fit the wallet at the slippage-widened pull`);
    assert.ok(next < 40_376_320_000n, "only ever down");
  });

  it("shrinks by at least the slippage margin even when the plan says it fits", () => {
    const next = shrinkWideFundingDeposit({ planned: 1_000_000n, balanceAtStart: 2_000_000n, balanceNow: 1_900_000n, slippagePercent: 3 });
    assert.ok(next !== null && next <= (1_000_000n * 100n) / 103n + 1n);
  });

  it("never invents a figure: unreadable, empty or fully consumed is null", () => {
    const base = { planned: 1_000n, balanceAtStart: 1_000n, slippagePercent: 3 };
    assert.equal(shrinkWideFundingDeposit({ ...base, balanceNow: null }), null);
    assert.equal(shrinkWideFundingDeposit({ ...base, balanceNow: 0n }), null);
    assert.equal(shrinkWideFundingDeposit({ planned: 500n, balanceAtStart: 2_000n, balanceNow: 1_000n, slippagePercent: 3 }), null);
  });

  it("makes the shortfall rebuildable, re-reads the wallet in the rebuild, and is bounded to one shrink", () => {
    assert.equal(WIDE_FUNDING_MIDFLIGHT_SHRINKS, 1);
    assert.match(funding, /if \(isInsufficientFundsRejection\(logs, message\)\) \{\s*shortRejectionPending = true;\s*return true;/);
    const rebuild = funding.slice(funding.indexOf("rebuild: async (index, attempt)"));
    assert.ok(rebuild.indexOf("readAtaBalance(auth.wallet, pairedMint, pairedTokenProgram)") > 0);
    assert.ok(rebuild.indexOf("shrinkWideFundingDeposit(") < rebuild.indexOf("addLiquidityByStrategyChunkable(depositFor(pairedForDeposit))"));
    assert.match(rebuild, /midflightShrinks >= WIDE_FUNDING_MIDFLIGHT_SHRINKS/);
    // The second refusal is a THROW naming the funded position, not another send.
    assert.match(rebuild, /Earlier chunks LANDED: the position is funded and must be recovered/);
    // The start-of-funding balance is read before the first chunk is sent.
    assert.ok(funding.indexOf("const pairedAtFundingStart = await readAtaBalance(") < funding.indexOf("funded = await sendSequentially("));
  });
});
