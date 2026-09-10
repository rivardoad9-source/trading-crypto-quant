# Recurrence proof — the 11 Sep 2026 failure classes

**What this document is for.** After the 11 Sep incident
(`docs/incidents/2026-09-11-failed-live-opens-sizing.md`) the operator's question is not
"was it fixed" but "can it happen again, and how would I know". This answers that per
FAILURE CLASS: what the class is, the guard that now prevents it, the test that proves
the guard, and the `file:line` for both.

**What it is NOT.** None of this is proven by a funded live open. Everything below is
proven by unit tests, by the source, and by the incident's own numbers — the same
standing caveat CLAUDE.md carries for the wide path. Nothing here was deployed,
restarted, or run against the live wallet by this work.

**Line numbers are as of this commit.** They move; the symbol names do not.

---

## Class 1 — Money leaves and NO POSITION comes back, invisibly

**What happened.** Three live opens on KNOTS-SOL between 02:0x and 02:31. Each balancing
swap CONFIRMED, each DLMM deposit leg failed (`TransferChecked` → SPL `0x1`), each
auto-unwind sold back to SOL. Wallet: **−0.0639 SOL**. Database: **zero position rows,
zero realised PnL, a clean `daily_pnl_snapshots`**. Every accounting surface in the
engine reported a healthy, idle book while the wallet drained.

The rule that produced the hole is correct and stays: *no row is written until the open
confirms.* A failed open has no position, so it must have no position row. What was
missing is that it also had no OTHER row.

### Guard 1a — the spend is recorded

| | |
|---|---|
| Storage | `live_execution_attempts`, `src/database/schema.sql` (table + `idx_attempts_at`) |
| Write, failure path | `src/services/liveExecution.ts:1635` (`outcome: "failed"`) |
| Write, success path | `src/services/liveExecution.ts:1510` (`outcome: "opened"`) |
| Cost measurement | `src/services/liveExecution.ts:1623` — balance read **after** the recovery and the unwind |
| Cost arithmetic | `attemptCostLamports`, `src/database/repositories.ts:1111` |

Three properties are load-bearing and each has a test:

- **`cost_lamports` is NULL, never 0, when either balance read failed.** An unmeasured
  cost counted as free would deflate the budget Guard 1b enforces.
  → `src/tests/failedAttemptCost.test.ts` *"is NULL, never 0, when either balance read failed"*
- **A successful open's `wallet_lamports_after` is deliberately NULL.** The position is
  still open, so there is no honest "after"; writing the pre-open balance into both
  columns would manufacture a zero cost.
  → *"does not count SUCCESSFUL opens against the failure budget"*
- **The cost is read AFTER the unwind.** Reading before it would charge the attempt for
  SOL the rescue put back.
  → *"records the failed attempt with a balance read taken AFTER the unwind"*

It changes nothing about `realized_pnl_usd`, for the reason gas is recorded and not
deducted. A failed attempt has no PnL; it has a cost, and this is where the cost lives.

### Guard 1b — the spend is CAPPED (`FailedCostBreakerError`)

| | |
|---|---|
| Setting | `LIVE_MAX_FAILED_COST_SOL` (default **0.05**), `LIVE_FAILED_COST_WINDOW_HOURS` (24) — `src/config/env.ts` |
| Sum | `sumFailedAttemptCost`, `src/database/repositories.ts:1215` |
| Gate | `src/services/liveExecution.ts:864` — **before** the swap at `:1433` |
| Release | `clearLiveExecutionAttempts`, `src/database/repositories.ts:1252` |

**What it would and would not have caught, stated precisely.** The budget is checked
BEFORE an attempt, against what is already recorded. At the incident's own total spread
evenly (3 × ~0.0213 SOL), the sum before attempt 3 is 0.0426 SOL — under the 0.05
default — so **this gate alone would NOT have stopped the third attempt**; it would have
stopped a fourth. The gate that stops attempts 2 and 3 is the token bench (Class 3), and
these are complementary rather than redundant: the bench is per-token and this is
per-WALLET, so it also catches a run of failures spread across several unrelated pools,
which no bench can see. Lowering the default to catch the third attempt was rejected —
0.03 SOL is inside the noise of a single legitimate entry's friction, and a breaker that
fires on one ordinary trade is a breaker that gets raised rather than trusted.

- **Entry-only.** Monitoring, fee accrual and closes are untouched. Holding an exit is
  how a stop-loss stops being enforced.
  → *"holds ENTRIES only — neither gate appears on the close path"*
- **The unmeasured rows are named in the refusal**, so "0.04 SOL of failures" is never
  read as complete when it is not.
  → *"EXCLUDES an unmeasured attempt from the sum and REPORTS it separately"*
- **Infinity disables it; zero is refused at boot** (`src/config/env.ts` superRefine) —
  zero would block every entry the moment one lamport was measured, while reading like
  "no budget configured".

### Guard 1c — the alert says what it cost and what is left behind

`StrandedSwapError` now opens with the unwind verdict and the cost:

```
UNWOUND CLEAN (nothing of value left on-chain). COST 0.021300 SOL taken out of the wallet.
ORPHAN LEFT — capital is STILL ON-CHAIN and needs a human. COST NOT MEASURED (a wallet balance read failed) — check the chain.
```

`describeUnwindVerdict` / `describeAttemptCost` / `classifyUnwind` in
`src/services/liveExecution.ts`. An unverified rescue is **UNKNOWN**, never **clean** —
"the rescue was submitted" and "the rescue worked" are different facts, and only one lets
the operator go back to sleep.
→ *"names the cost and the unwind verdict in the operator alert"*

---

## Class 2 — Sizing against capital the wallet does not hold

**What happened.** `LIVE_CAPITAL_SOL=3.05` against a wallet of 2.880994 SOL: the engine
sized deposits as though it had **+0.169 SOL** it did not have. The pin had been correct
when it was set (wallet 2.944854) and was eroded by the ordinary cost of trading.

**The engine already read that balance** — `runLivePreflight` prints it at every boot,
`measureWalletBalance` serves it to the dashboard. Nothing used it as an INPUT. That was
the whole defect.

| | |
|---|---|
| Rule | `assessLiveSizing`, `src/services/liveSizingGuard.ts:91` |
| Comparison | `:133` — `deployable = LIVE_CAPITAL_SOL − LIVE_MIN_RESERVE_SOL` must be **≤** the real balance |
| Unknown balance | `:121` — `balance-unknown`, **refuses** |
| Enforcement | `src/services/liveExecution.ts:897`, before the swap at `:1433` |
| Reporting | `reportCapitalHealth`, `src/index.ts:169`; hourly at `src/index.ts:319` (`CRON.CAPITAL_HEALTH`) |

Four decisions are stated rather than left to be inferred from a `<=`:

- **FAILS CLOSED on an unreadable balance.** "The RPC timed out" is not evidence of
  solvency — the same rule `runLivePreflight` and `screenTokenSafety` follow, and
  deliberately unlike `assessPoolCooldown`.
  → `src/tests/liveSizingGuard.test.ts` *"FAILS CLOSED when the balance could not be read"*
- **Exact equality PASSES**, and the direction is pinned by a test named after it. At
  `deployable === balance` every lamport the engine may deploy is provably present,
  which is the condition being tested. That the untouchable reserve is *also* present is
  a separate question, asked by `LIVE_MIN_WALLET_SOL` in `livePreflight.ts`.
  → *"PASSES at exact equality (deployable === balance), and that direction is deliberate"*
- **A drained wallet is a MEASUREMENT, not a read failure.** 0 reaches `over-capital`
  with its real number; the two need different operator actions.
  → *"reports a genuinely empty wallet as over-capital, not as unknown"*
- **It earns no execution strike.** A wallet-level condition benching the universe one
  pool at a time is a self-inflicted outage a top-up would not fix — the same reasoning
  as `isPoolAttributable`.
  → `src/tests/failedAttemptCost.test.ts` *"earns no execution strike: both refusals precede every recordPoolExecutionFailure"*

**Checked at every entry, not only at boot.** The balance moves and the pin does not,
which is exactly how a correct pin became a wrong one. One RPC read per entry, against
at most one entry per cycle.

**Boot does NOT refuse.** `reportCapitalHealth` logs and alerts; it never throws.
Refusing to boot would also hold the exits, which is the opposite of prudent.

---

## Class 3 — Retrying a mint that already failed AFTER the money went out

Two independent defects, both live on 11 Sep.

### 3a — the bench window was sized for the wrong kind of failure

A refused simulation costs nothing and may be transient cluster state; 24 hours is a
generous wait. A post-swap failure means SOL left and nothing came back. Sharing one
window meant the expensive case was measured against the cheap case's clock.

| | |
|---|---|
| Setting | `EXECUTION_POST_SWAP_LOCKOUT_HOURS`, default **168** (7 days), `src/config/env.ts` |
| Selection | `src/services/executionGuard.ts:215` — the window is chosen BY STAGE |
| Floor | `postSwapWindow`, `src/services/executionGuard.ts:153` — never shorter than `hours` |

- **No zero-disable, and a hard 24h floor**, validated in `env.ts`'s superRefine —
  unlike every other lockout in the file. A post-swap failure is the outcome the breaker
  exists to stop repeating; "off" is not a value a typo should reach.
- **Omission falls back to `hours`, never to zero**, so a threshold object built by hand
  cannot turn the expensive case into the shortest bench in the system.
  → `src/tests/postSwapBench.test.ts` *"falls back to hours when postSwapHours is absent, never to zero"*
- The pre-swap window is untouched.
  → *"leaves the PRE-SWAP window alone — a refused rehearsal still clears in hours"*

### 3b — the token-level bench was armed and propagating nothing

The mint-keyed bench (`benchTokenKey`, `assessTokenBench`, `indexExecutionHistory`)
shipped on 10 Sep 2026 and is correct. Every failure writer passes `tokenMint`. And on
11 Sep **all six stored rows still had a NULL one** — because a row written before the
column existed keeps its NULL until the pool fails AGAIN, which is the event the bench
exists to prevent. The gate read as armed at boot and covered a single address.

| | |
|---|---|
| Backfill | `learnPoolExecutionToken`, `src/database/repositories.ts:1023` |
| Called on the way IN | `src/services/liveExecution.ts:930` — right after `describePair`, before the swap |
| Warning | `describeUnkeyedBenches`, `src/services/executionGuard.ts:355`; printed each cycle at `src/agents/dlmmTraderAgent.ts:1562` |

- The mint is the SDK's own answer for the non-SOL side, so the backfilled key cannot
  drift from the one the candidate filter looks it up by.
- **It never overwrites a learned key and never creates a row.** A pool with no history
  stays with no history; creating zero-failure rows would make "has this pool ever
  failed" unanswerable from the breaker's own storage.
  → *"never OVERWRITES a key already learned"*, *"never CREATES a row for a pool that has no history"*
- **A NULL is not fail-open for the pool itself** — it still serves its own bench — and
  the fact that it propagates to no sibling is now SAID rather than silently skipped.
  → *"still benches its OWN pool"*, *"propagates to no sibling — and is REPORTED rather than silently skipped"*
- **A pair name is still never used as the key.** Memecoin tickers collide; the
  `POOL_DENYLIST` may match names because a human chose them and can see what they cover.

`POOL_DENYLIST` semantics are unchanged.

---

## Class 4 — The book and the wallet drift apart with nobody told

`STARTING_BALANCE_USD=298.02` against a wallet of ~$285.5. Two causes look identical
from here and both need a human: a baseline pinned above what the wallet ever held (the
pin double-counts trades already booked — `impliedStartingBalanceUsd`), and real SOL
spent on attempts that produced no rows (Class 1).

| | |
|---|---|
| Rule | `assessWalletDrift`, `src/services/reconciliation.ts:282` |
| Thresholds | `WALLET_DRIFT_MAX_PCT` (1), `WALLET_DRIFT_MAX_SOL` (0.02), `src/config/env.ts` |
| Run | `reportCapitalHealth`, `src/index.ts:169`; hourly at `:319` |

- **Two units, either of which fires.** A percentage alone never fires on a large book
  that has quietly lost real SOL; an absolute alone fires constantly on a small one.
  → `src/tests/walletDrift.test.ts` *"fires on the SOL threshold alone…"* / *"…on the PERCENTAGE threshold alone…"*
- **It corrects nothing.** `STARTING_BALANCE_USD` keeps its value and `realized_pnl_usd`
  keeps its definition — the same reason `seedStartingBalanceFromWallet` refuses to
  rebase under existing trades. The reason string names both candidate causes.
- **UNMEASURED IS NOT ZERO.** A missing balance or price yields `unmeasured` and no
  alert, never a drift of 0.
  → *"is UNMEASURED, never 0, when any input is missing"*
- A zero book gives a **null** percentage, not Infinity, so it cannot render as a real
  measurement — the rule `profitFactor` already follows.

It is a DIFFERENT question from `reconcilePositions`, which asks per closed trade whether
the model matched the chain. This asks whether the book's LEVEL still matches the wallet,
and is answerable from a wallet that has never traded. They are not merged.

---

## The P1 sweep — validations that ran AFTER the first spend

Every lamport-spending path was walked against the question "does every validation that
CAN fail run before the first spend". One finding, fixed; the rest are noted with the
reason they are not findings.

| path | first spend | validations before | after (**finding**) | action |
|---|---|---|---|---|
| **Narrow open (≤70 bins) — the only live path** | `executeJupiterSwap`, `liveExecution.ts:1433` | denylist, pool bench, **failed-cost budget (:864)**, **capital guard (:897)**, token bench, 1400-bin, operator cap, `quoteOpenCost` rent, rent-vs-PnL, per-tx ceiling, bin-drift, rehearsal (inert at cap 70) | **The per-tx ceiling charged the NOMINAL deposit while the executor charges `maxDepositLamports(...)`** — a deposit just under the ceiling passed the pre-swap gate and was refused post-swap | **FIXED**: `liveExecution.ts:1117` now widens by `depositSlippage(auth, cost.binStep).depositCeilingFactor`, the same factor the executor uses |
| same | | | paired-token balance; the SDK's own `quoteCreatePosition`; the pre-send cluster simulation | Not findings **by construction**: the paired token does not exist until the swap that buys it, and the fused transaction cannot be simulated before it is funded. Documented in CLAUDE.md; unchanged |
| **Wide open (>70 bins)** | `ensureBinArrays` → `sendAndConfirm`, `onchainExecutor.ts` (pre-swap) | all of the above, plus a rehearsal that actually simulates | funding-chunk shape is never simulated; the executor's own `preCreateMissingBinArrays` runs a second time post-swap | **Not changed.** Unreachable at `LIVE_MAX_POSITION_BINS=70`. Recorded as prerequisite work before the cap is raised |
| **Bin-array pre-create** | `sendAndConfirm` | SDK-export check, existence read, spend ceiling | — | none |
| **Auto-unwind (rescue swap)** | `executeJupiterSwap`, `liveExecution.ts` catch | balance re-read (`current > 0n`) | the SOL spend ceiling does not apply — the input leg is not wSOL | Not a finding: the ceiling is SOL-denominated by design; `HARD_MAX_SLIPPAGE_BPS` still binds |
| **Recover partially-funded** | `withdrawClaimAndClose` | ownership re-established from the SDK's own memcmp descriptors; `positionHoldsValue` | — | none (net inbound) |
| **Close / `forceCloseAllPositions` / claim** | `withdrawClaimAndClose` / `sendSequentially` | `requirePosition`, `closingOnChain` dedupe, mutex | no `assertWithinSpendLimit` | Not a finding: net inbound; the only cost is the priority fee, bounded by `planPriorityFee`. **Deliberately not gated by the new breakers** — see Class 1b |
| **Rebalance** | — | — | **no rebalance path exists in `src/`** | The incident log's `RebalanceLiquidity` is the SDK's own instruction name inside `addLiquidityByStrategyChunkable`, not an engine path |

### Writers to `pool_execution_failures` without `token_mint`

| file:line | call | passes `tokenMint`? |
|---|---|---|
| `liveExecution.ts` (rehearsal strike) | `recordPoolExecutionFailure` | yes |
| `liveExecution.ts` (bin-array-prep strike) | `recordPoolExecutionFailure` | yes |
| `liveExecution.ts` (post-swap strike) | `recordPoolExecutionFailure` | yes |
| `liveExecution.ts` (success) | `recordPoolExecutionSuccess` | **n/a** — no token parameter; its SQL (`repositories.ts`) does not touch `token_mint`, so an existing value is preserved and a brand-new success row is NULL |

No raw-SQL writers elsewhere. `onchainExecutor.test.ts`-style source assertions now pin
this per call site rather than by counting occurrences file-wide
(`src/tests/executionGuard.test.ts`, *"records the token on EVERY strike"*).

**The `recordPoolExecutionSuccess` NULL is not a hole**: a success row has
`consecutive_failures = 0`, so it benches nothing and `indexExecutionHistory` does not
even count it as unkeyed. Should that pool later fail, the failure carries the mint.

---

## What this work did NOT establish

- **No funded live open was attempted.** Everything above is proven by unit tests and by
  the source. The same standing caveat CLAUDE.md carries for the wide path.
- **`.env` was not touched**, nothing was built, deployed, restarted, or run against the
  live wallet. The operator's temporary mitigations (`LIVE_CAPITAL_SOL=2.85`,
  KNOTS-SOL on `POOL_DENYLIST`) are still the only thing armed on the box until this is
  deployed. `.env` is untracked and unreadable from this checkout, so **nothing here is
  a statement about what is deployed** — the boot line
  `[guard] execution breaker: …; operator denylist: …` remains the authority.
- **Whether the six NULL `token_mint` rows predate the column or predate the arguments
  could not be determined from the repository**, and the database was not read. The
  backfill makes the distinction moot going forward; it does not reconstruct history.
- **The incident document reads `benched for another 3.0h of 24h` as "the bench only
  held 3 hours".** It does not: `remaining = window − elapsed`, so that line means 21
  hours had already elapsed of a 24-hour bench. The three attempts inside thirty minutes
  are therefore explained by the token-level gap (3b) or by an older deployed build, not
  by a 3-hour window. The fix in 3a still stands on its own merits — a spent failure
  should not share the free failure's clock — but it is **not** the mechanism the
  incident named.
- **`EXECUTION_POST_SWAP_LOCKOUT_HOURS` is 168 hours, not "until an operator clears
  it".** A permanent bench needs a clearing mechanism to go with it, which
  `POOL_DENYLIST` already provides for the operator-driven case. A week was chosen as
  the longest window that still expires without a human.

## Test totals for this change

| | tests | pass | fail |
|---|---|---|---|
| before (this checkout, paper `.env`) | 729 | 729 | 0 |
| after | 770 | 770 | 0 |

`npm run typecheck` clean. The 7 failures CLAUDE.md documents occur on an ARMED box and
did not appear here; this checkout is paper mode, so that baseline could not be
reproduced or verified either way.
