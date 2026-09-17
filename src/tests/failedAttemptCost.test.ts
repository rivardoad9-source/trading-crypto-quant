/**
 * The cost of live attempts that produced NO position — and the breaker that acts on it.
 *
 * THE HOLE THIS FILLS, in the incident's own words: on 11 Sep 2026 three live opens on
 * one token each confirmed a balancing swap, each failed the deposit leg, each unwound.
 * The wallet fell 0.0639 SOL. The database recorded **nothing** — zero position rows,
 * zero realised PnL, a clean `daily_pnl_snapshots`. Money that leaves without producing
 * a position was invisible to every accounting surface the engine has, so the pattern
 * could repeat until the wallet was empty with nothing reporting a fault.
 *
 * Three rules are pinned here, and each is the "unmeasured is not zero" rule wearing a
 * different hat: an unmeasured attempt contributes nothing to the budget AND is counted
 * separately so the operator knows the total understates; the budget is compared
 * strictly, so a spend exactly at the limit is not yet a breach; and the ledger records
 * successes too, with a NULL "after" rather than a manufactured zero cost.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-attempts-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.DRY_RUN = "true";

type Repos = typeof import("../database/repositories.js");
type Db = typeof import("../database/db.js");

let repos: Repos;
let dbModule: Db;

const LAMPORTS = 1_000_000_000;

before(async () => {
  dbModule = await import("../database/db.js");
  repos = await import("../database/repositories.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test owns the table. `clearLiveExecutionAttempts` is production API — it is
  // how an operator releases the cost breaker — so exercising it here is not a
  // test-only backdoor.
  repos.clearLiveExecutionAttempts();
});

function failed(costSol: number | null, over: Record<string, unknown> = {}): void {
  const before = 3 * LAMPORTS;
  repos.recordLiveExecutionAttempt({
    poolAddress: "Pool111111111111111111111111111111111111111",
    pairName: "KNOTS-SOL",
    tokenMint: "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS",
    outcome: "failed",
    stage: "open",
    walletLamportsBefore: costSol === null ? null : before,
    walletLamportsAfter: costSol === null ? null : before - Math.round(costSol * LAMPORTS),
    unwind: "clean",
    swapSignature: "swap-sig",
    rescueSignature: "rescue-sig",
    positionAddress: null,
    reason: "TransferChecked: insufficient funds",
    ...over,
  } as Parameters<Repos["recordLiveExecutionAttempt"]>[0]);
}

describe("attemptCostLamports", () => {
  it("is NULL, never 0, when either balance read failed", () => {
    assert.equal(repos.attemptCostLamports(null, 5), null);
    assert.equal(repos.attemptCostLamports(5, null), null);
    assert.equal(repos.attemptCostLamports(null, null), null);
    assert.equal(repos.attemptCostLamports(Number.NaN, 5), null);
  });

  it("measures the drop, and keeps a NEGATIVE cost rather than clamping it", () => {
    assert.equal(repos.attemptCostLamports(3_000_000_000, 2_936_100_000), 63_900_000);
    // A recovery can reclaim more rent than the attempt spent. Clamping to zero would
    // hide the one case where the accounting deserves a look.
    assert.equal(repos.attemptCostLamports(1_000, 1_500), -500);
  });
});

describe("the failed-attempt ledger", () => {
  it("records the 11 Sep shape and sums it — 3 attempts, 0.0639 SOL", () => {
    failed(0.0213);
    failed(0.0213);
    failed(0.0213);

    const spent = repos.sumFailedAttemptCost(24);
    assert.equal(spent.attempts, 3);
    assert.equal(spent.unmeasured, 0);
    assert.equal(spent.lamports, Math.round(0.0639 * LAMPORTS));
  });

  it("EXCLUDES an unmeasured attempt from the sum and REPORTS it separately", () => {
    failed(0.02);
    failed(null);

    const spent = repos.sumFailedAttemptCost(24);
    assert.equal(spent.attempts, 2);
    assert.equal(spent.unmeasured, 1);
    // The unmeasured row contributes nothing. Counting it as zero would deflate the
    // budget the breaker enforces; counting it as a guess would invent a spend.
    assert.equal(spent.lamports, Math.round(0.02 * LAMPORTS));
  });

  it("does not count SUCCESSFUL opens against the failure budget", () => {
    failed(0.02);
    repos.recordLiveExecutionAttempt({
      poolAddress: "Pool2",
      pairName: "AAA-SOL",
      tokenMint: "Mint2",
      outcome: "opened",
      stage: null,
      walletLamportsBefore: 3 * LAMPORTS,
      // NULL on purpose: the position is still open, so there is no honest "after".
      walletLamportsAfter: null,
      unwind: "none",
      swapSignature: "s",
      rescueSignature: null,
      positionAddress: "Pos1",
      reason: null,
    });

    const spent = repos.sumFailedAttemptCost(24);
    assert.equal(spent.attempts, 1);
    assert.equal(spent.lamports, Math.round(0.02 * LAMPORTS));

    const recent = repos.getRecentLiveExecutionAttempts(10);
    assert.equal(recent.length, 2);
    const opened = recent.find((r) => r.outcome === "opened");
    assert.ok(opened);
    // A successful open's cost is NOT zero, it is unmeasured. Writing the pre-open
    // balance into both columns would have manufactured a zero.
    assert.equal(opened?.costLamports, null);
  });

  it("keeps the unwind verdict and the signatures a recovery needs", () => {
    failed(0.02, { unwind: "orphan", positionAddress: "ENNpRNx6" });
    const row = repos.getRecentLiveExecutionAttempts(1)[0];
    assert.ok(row);
    assert.equal(row.unwind, "orphan");
    assert.equal(row.positionAddress, "ENNpRNx6");
    assert.equal(row.swapSignature, "swap-sig");
    assert.equal(row.tokenMint, "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS");
  });

  it("an unrecognised unwind value reads back as unknown, never as clean", () => {
    failed(0.01, { unwind: "something-new" });
    const row = repos.getRecentLiveExecutionAttempts(1)[0];
    assert.ok(row);
    assert.equal(row.unwind, "unknown");
  });
});

/**
 * THE ORDERING, asserted against the source rather than against a mock.
 *
 * Every rule this file is about is a rule about WHERE something happens: before the
 * spend or after it, on the entry path or on the exit path. A mock can be made to agree
 * with a wrong ordering; the file cannot. This is the same technique
 * `executionGuard.test.ts` and `newsBlackout.test.ts` already use for the same reason.
 */
describe("where the new gates sit", () => {
  let source: string;

  before(async () => {
    const { readFileSync } = await import("node:fs");
    source = readFileSync("src/services/liveExecution.ts", "utf8");
  });

  it("checks the failed-cost budget and the capital guard BEFORE the balancing swap", () => {
    const budget = source.indexOf("sumFailedAttemptCost(env.LIVE_FAILED_COST_WINDOW_HOURS)");
    const sizing = source.indexOf("assessLiveSizing({ balanceSol: await readWalletBalanceForGuard() })");
    const swap = source.indexOf("await executeJupiterSwapFreshQuote(auth, {");

    assert.ok(budget > 0, "the failed-cost budget must be consulted in openLivePosition");
    assert.ok(sizing > 0, "the capital guard must be consulted in openLivePosition");
    assert.ok(swap > 0);
    assert.ok(budget < swap, "the failed-cost budget must be checked before the swap spends");
    assert.ok(sizing < swap, "the capital guard must be checked before the swap spends");
  });

  /*
   * ENTRY-ONLY. Holding an EXIT is how a stop-loss stops being enforced — the failure
   * this repository documents twice already. If either gate ever appears in
   * `closeLivePosition`, that is the regression.
   */
  it("holds ENTRIES only — neither gate appears on the close path", () => {
    const close = source.indexOf("export async function closeLivePosition");
    assert.ok(close > 0);
    const closeBody = source.slice(close);
    assert.equal(closeBody.includes("sumFailedAttemptCost"), false);
    assert.equal(closeBody.includes("assessLiveSizing"), false);
    assert.equal(closeBody.includes("FailedCostBreakerError"), false);
  });

  /*
   * The capital guard is a WALLET-level fact, not a pool one. Counting it as an
   * execution strike would let one wallet condition bench the universe a pool at a time
   * — the self-inflicted outage `isPoolAttributable` already exists to prevent, and one
   * a top-up would not fix. Both errors extend `LiveEntryRefusedError`, whose default
   * `countsAsExecutionFailure` is false, and both are thrown before any strike is
   * recorded.
   */
  it("earns no execution strike: both refusals precede every recordPoolExecutionFailure", () => {
    const sizing = source.indexOf("throw new LiveSizingError(");
    const budget = source.indexOf("throw new FailedCostBreakerError(");
    const firstStrike = source.indexOf("recordPoolExecutionFailure({");

    assert.ok(sizing > 0 && budget > 0 && firstStrike > 0);
    assert.ok(sizing < firstStrike);
    assert.ok(budget < firstStrike);
  });

  it("records the failed attempt with a balance read taken AFTER the unwind", () => {
    const rescue = source.indexOf("const unwindPasses = await unwindPairedBalance({");
    const after = source.indexOf("const walletLamportsAfter = await readWalletLamports();");
    const record = source.indexOf('outcome: "failed"');

    assert.ok(rescue > 0 && after > 0 && record > 0);
    // Reading before the rescue would charge the attempt for SOL the unwind put back.
    assert.ok(rescue < after, "the cost must be measured after the unwind, not before it");
    assert.ok(after < record);
  });

  it("names the cost and the unwind verdict in the operator alert", () => {
    assert.ok(source.includes("describeUnwindVerdict"));
    assert.ok(source.includes("describeAttemptCost"));
    assert.ok(source.includes("UNWOUND CLEAN"));
    assert.ok(source.includes("ORPHAN LEFT"));
    // Unmeasured must never render as free.
    assert.ok(source.includes("COST NOT MEASURED"));
  });
});

/**
 * 12 Sep 2026: a half-landed wide open left 1.802543 SOL in a funded position the engine does
 * NOT track (no `simulated_positions` row — the open failed as a whole), and the entry path had
 * no opinion about it. The engine was one candidate away from opening a second position with a
 * wallet that was already partly spoken for. `StrandedCapitalError` is that opinion, and these
 * tests pin both halves of it: what it counts, and that nothing can spend past it.
 */
describe("stranded capital — an unresolved orphan holds new entries", () => {
  let source: string;
  before(async () => {
    const { readFileSync } = await import("node:fs");
    source = readFileSync("src/services/liveExecution.ts", "utf8");
  });

  it("counts attempts that still claim capital is on-chain, and only those", () => {
    assert.equal(repos.countUnresolvedOrphanAttempts(), 0, "an empty ledger strands nothing");

    failed(0.02, { unwind: "clean" });
    failed(0.02, { unwind: "none" });
    assert.equal(
      repos.countUnresolvedOrphanAttempts(),
      0,
      "a settled unwind is not stranded capital — counting it would shut entries forever",
    );

    failed(0.02, { unwind: "orphan", positionAddress: "Pos1111111111111111111111111111111111111" });
    assert.equal(repos.countUnresolvedOrphanAttempts(), 1);
  });

  it("never treats 'unknown' as clean, and needs an address to act on", () => {
    failed(0.02, { unwind: "unknown", positionAddress: null });
    assert.equal(
      repos.countUnresolvedOrphanAttempts(),
      0,
      "with no position address there is no account to check, so nothing is provably stranded",
    );

    failed(0.02, { unwind: "unknown", positionAddress: "Pos2222222222222222222222222222222222222" });
    assert.equal(
      repos.countUnresolvedOrphanAttempts(),
      1,
      "'unknown' is not evidence the chain is clean — the whole drift-check rule",
    );
  });

  it("is read before the breaker, before any strike, and before the swap", () => {
    const guard = source.indexOf("throw new StrandedCapitalError(");
    const breaker = source.indexOf("throw new FailedCostBreakerError(");
    const firstStrike = source.indexOf("recordPoolExecutionFailure({");
    // The balancing swap itself, not the word "swapping" — the rescue path swaps too, and a
    // comment mentioning it would make this assertion meaningless.
    const swap = source.indexOf("await executeJupiterSwapFreshQuote(auth, {");

    assert.ok(guard > 0, "the stranded-capital guard is gone");
    assert.ok(breaker > 0 && firstStrike > 0 && swap > 0);
    // The breaker asks what failures COST; this asks whether one is still HOLDING something.
    assert.ok(guard < breaker, "the literal question must be asked first");
    assert.ok(guard < swap, "a guard that runs after the swap is not a guard");
    assert.ok(guard < firstStrike, "a wallet-level condition must not bench a pool");
  });

  it("stays out of the close path, so monitoring and exits never wait on it", () => {
    const close = source.indexOf("export async function closeLivePosition");
    assert.ok(close > 0);
    assert.equal(
      source.slice(close).includes("StrandedCapitalError"),
      false,
      "holding entries must never hold an EXIT",
    );
  });
});
