/**
 * Does the engine SAY it is live when it is live?
 *
 * Not a cosmetic question. The dashboard already carries rules against presenting a
 * paper figure as a real one — the portfolio hero labels its balance "on-chain", the
 * cohort filter must show that a rebased equity curve is rebased — because a number that
 * lies about what it describes gets acted on. Every one of those rules was written for
 * the browser, and the two channels an operator actually reads while money is moving
 * were never checked:
 *
 *  - the TELEGRAM alerts, which announced "PAPER POSITION OPENED (DRY-RUN)" — hard-coded,
 *    with no dry-run branch anywhere — for the entire time the engine was armed with real
 *    capital, and reported the size from `VIRTUAL_SOL_PER_POSITION` rather than the SOL
 *    actually deployed;
 *  - the BOOT banner, which said "this build still signs nothing". True when written,
 *    false from the day live execution landed, and the most reassuring line on the screen.
 *
 * Source-level assertions, deliberately. Both are string templates chosen from a flag,
 * and the failure mode is a literal that stops following the flag — which is visible in
 * the source and invisible in any behaviour a unit test can reach without a Telegram
 * account and a funded wallet.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sendPositionClosed, sendPositionOpened } from "../services/telegram.js";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const telegramSource = read("../services/telegram.ts");
const indexSource = read("../index.ts");
const agentSource = read("../agents/dlmmTraderAgent.ts");

describe("trade alerts — the label follows the engine, not the build", () => {
  it("has no hard-coded PAPER banner left", () => {
    /*
     * The exact string that shipped over every live trade. Matching it directly rather
     * than the general shape, because this is the regression, and a future refactor
     * that reintroduces it would reintroduce it verbatim.
     */
    assert.ok(
      !telegramSource.includes("PAPER POSITION OPENED (DRY-RUN)`"),
      "the open alert announces every position as paper again",
    );
    assert.ok(
      !telegramSource.includes("PAPER POSITION CLOSED —"),
      "the close alert announces every position as paper again",
    );
  });

  it("requires callers to state whether the position is real", () => {
    /*
     * `live: boolean` is required rather than defaulted. A default is what let this go
     * unnoticed: nothing had to be updated when live execution landed, so nothing was.
     * The compiler now asks every caller the question.
     */
    assert.match(telegramSource, /\n {2}live: boolean;/, "the alert payload lost its live flag");
    assert.ok(
      !/live\?: boolean/.test(telegramSource),
      "the live flag became optional, so a caller can silently omit it again",
    );
  });

  it("takes the size actually deployed, not the paper constant", () => {
    assert.ok(
      !telegramSource.includes("virtualSol"),
      "the alert still reports a 'virtual' size for real positions",
    );
    assert.match(telegramSource, /sizeSol: number;/);
    /*
     * The entry alert must quote the SAME number the row was written with. Under the
     * live micro-capital profile sizing comes from FREE capital, so
     * VIRTUAL_SOL_PER_POSITION is a different figure — the alert and the position
     * disagreed, with nothing else in the system to contradict either.
     */
    assert.match(
      agentSource,
      /sizeSol: sizing\.sizeSol,/,
      "the entry alert no longer reports the size the position was opened with",
    );
    assert.ok(
      !/virtualSol: env\.VIRTUAL_SOL_PER_POSITION/.test(agentSource),
      "the entry alert reports the paper constant again",
    );
  });

  it("names the value change for what it is, not as impermanent loss", () => {
    /*
     * The number sent was always `netPnl - fees`, i.e. the LP value change. It was
     * labelled "Impermanent loss", which is the divergence-vs-hold figure — about five
     * times smaller for the same move (-5.7% against -29.3% on a halving). CLAUDE.md
     * keeps those two apart everywhere else; the alert conflated them, and the operator
     * read a number that looked like a broken engine.
     */
    assert.ok(
      !telegramSource.includes("Impermanent loss:"),
      "the close alert labels the value change as impermanent loss again",
    );
    assert.match(telegramSource, /Position value change: /);
    assert.match(telegramSource, /positionValueChangeUsd: number;/);
  });

  it("renders both banners without throwing, with Telegram unconfigured", async () => {
    // No token in the test env, so `sendMessage` logs instead of dispatching. This is a
    // smoke check that the template compiles for both branches — the labels themselves
    // are pinned above.
    await sendPositionOpened({
      pairName: "AAA-SOL",
      poolAddress: "Pool111",
      strategy: "SPOT",
      entryPrice: 1,
      lowerBinPrice: 0.9,
      upperBinPrice: 1.1,
      confidence: 70,
      thesis: "t",
      sizeSol: 0.8,
      live: true,
      positionAddress: "Pos111",
    });
    await sendPositionClosed({
      pairName: "AAA-SOL",
      status: "CLOSED_PROFIT",
      reason: "tp",
      entryPrice: 1,
      exitPrice: 1.1,
      feeUsd: 1,
      positionValueChangeUsd: -0.2,
      netPnlUsd: 0.8,
      netPnlPct: 1,
      heldHours: 3,
      live: false,
    });
  });
});

describe("boot banner — the live profile line stops claiming it signs nothing", () => {
  it("derives the claim from the trading flag", () => {
    assert.ok(
      !indexSource.includes("this build still signs nothing"),
      "the banner tells the operator the engine cannot sign while it is armed to sign",
    );
    assert.match(
      indexSource,
      /isLiveTradingEnabled \? "SIGNS REAL TRANSACTIONS"/,
      "the banner no longer follows the live-trading flag",
    );
  });
});
