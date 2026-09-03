/**
 * The paper baseline every reported percentage is measured against.
 *
 * The failure this file exists to prevent is not a crash. It is a baseline that moves
 * without anyone noticing: `netPnlPct`, drawdown and `currentBalanceUSD` are all quoted
 * against this number, so if it drifts between boots the identical trade history starts
 * reporting different figures, and nothing throws.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_STARTING_BALANCE_USD } from "../config/constants.js";
import {
  describeStartingBalance,
  getStartingBalanceInfo,
  getStartingBalanceUsd,
  isStartingBalancePinned,
  resetStartingBalance,
  seedStartingBalanceFromWallet,
} from "../config/startingBalance.js";

const ENV_KEY = "STARTING_BALANCE_USD";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  resetStartingBalance();
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
  resetStartingBalance();
});

describe("starting balance — resolution order", () => {
  it("falls back to $1000 with nothing configured", () => {
    assert.equal(getStartingBalanceUsd(), DEFAULT_STARTING_BALANCE_USD);
    assert.equal(getStartingBalanceInfo().source, "default");
  });

  it("prefers an explicit STARTING_BALANCE_USD", () => {
    process.env[ENV_KEY] = "116.08";
    resetStartingBalance();
    assert.equal(getStartingBalanceUsd(), 116.08);
    assert.equal(getStartingBalanceInfo().source, "env");
    assert.equal(isStartingBalancePinned(), true);
  });

  it("ignores a non-positive or unparseable value rather than propagating it", () => {
    // A zero baseline makes every percentage Infinity; NaN would flow silently through
    // drawdown onto the dashboard. Neither may become the effective value.
    for (const bad of ["0", "-50", "abc", "NaN", "Infinity"]) {
      process.env[ENV_KEY] = bad;
      resetStartingBalance();
      assert.equal(
        getStartingBalanceUsd(),
        DEFAULT_STARTING_BALANCE_USD,
        `"${bad}" was accepted as a baseline`,
      );
    }
  });

  it("treats an empty value as unset", () => {
    process.env[ENV_KEY] = "   ";
    resetStartingBalance();
    assert.equal(getStartingBalanceInfo().source, "default");
  });
});

describe("starting balance — seeding from the live wallet", () => {
  it("seeds from the wallet on a clean slate", () => {
    const r = seedStartingBalanceFromWallet({
      walletUsd: 116.08,
      walletSol: 1.15,
      existingTrades: 0,
    });
    assert.equal(r.applied, true);
    assert.equal(getStartingBalanceUsd(), 116.08);
    assert.equal(getStartingBalanceInfo().source, "wallet");
    assert.equal(getStartingBalanceInfo().walletSol, 1.15);
  });

  it("REFUSES to rebase a database that already holds trades", () => {
    // The percentages already reported were computed against the old baseline. Moving
    // it under them changes what every one of those numbers means, silently.
    const r = seedStartingBalanceFromWallet({
      walletUsd: 116.08,
      walletSol: 1.15,
      existingTrades: 27,
    });
    assert.equal(r.applied, false);
    assert.match(r.reason ?? "", /already holds 27 closed trade/);
    assert.equal(getStartingBalanceUsd(), DEFAULT_STARTING_BALANCE_USD);
  });

  it("never overrides an explicitly pinned baseline", () => {
    process.env[ENV_KEY] = "500";
    resetStartingBalance();

    const r = seedStartingBalanceFromWallet({
      walletUsd: 116.08,
      walletSol: 1.15,
      existingTrades: 0,
    });
    assert.equal(r.applied, false);
    assert.match(r.reason ?? "", /set explicitly/);
    assert.equal(getStartingBalanceUsd(), 500, "a pinned baseline was overwritten");
  });

  it("refuses an unreadable or zero wallet rather than basing on nothing", () => {
    for (const walletUsd of [null, 0, -1, Number.NaN]) {
      resetStartingBalance();
      const r = seedStartingBalanceFromWallet({ walletUsd, walletSol: null, existingTrades: 0 });
      assert.equal(r.applied, false, `walletUsd=${walletUsd} was accepted`);
      assert.equal(getStartingBalanceUsd(), DEFAULT_STARTING_BALANCE_USD);
    }
  });
});

describe("starting balance — the operator can see what they are on", () => {
  it("names the source, so a $116 baseline is never mistaken for a default", () => {
    assert.match(describeStartingBalance().join(" "), /default — not backed by any wallet/);

    process.env[ENV_KEY] = "116.08";
    resetStartingBalance();
    assert.match(describeStartingBalance().join(" "), /pinned via STARTING_BALANCE_USD/);
  });

  it("warns that a wallet-derived baseline drifts, and prints the line to pin it", () => {
    // A baseline re-derived each boot makes drawdown non-reproducible. The operator has
    // to be told that, and given the exact fix, or they will not know to apply it.
    seedStartingBalanceFromWallet({ walletUsd: 116.08, walletSol: 1.15, existingTrades: 0 });
    const text = describeStartingBalance().join("\n");

    assert.match(text, /re-derived every boot and will drift/);
    assert.match(text, /STARTING_BALANCE_USD=116\.08/);
    assert.match(text, /1\.1500 SOL/);
  });
});

describe("starting balance — readers go through the resolver", () => {
  it("overview and analytics do not import the raw default", () => {
    // Importing DEFAULT_STARTING_BALANCE_USD directly pins a caller to $1000 while the
    // rest of the process reports against the operator's real funding — two different
    // baselines in one payload, with no error anywhere.
    for (const file of ["../services/overview.ts", "../services/analytics.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      assert.ok(
        !/import\s*\{[^}]*DEFAULT_STARTING_BALANCE_USD/.test(text),
        `${file} imports the raw default instead of getStartingBalanceUsd()`,
      );
      assert.match(text, /getStartingBalanceUsd\(\)/, `${file} does not use the resolver`);
    }
  });
});
