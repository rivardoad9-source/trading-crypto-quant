# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⛔ LIVE TRADING HALTED — 8 Sep 2026. Root cause FOUND; re-arming needs one test.

The engine is STOPPED (`pm2 stop flowmetrix-engine`). Wallet ~3.00 SOL, net **−0.10 SOL
(−3.3%) on the 3.10 SOL live capital, with ZERO successful live opens ever**.

The WIDE path (position > 70 bins, the two-phase create-then-fund flow) had never
completed a live open: three real-money incidents in ~36 hours — STONK-SOL (371 bins),
SOLCAT-SOL (77), ZCAT-SOL (95) — all the same shape. The balancing swap confirms, then
funding tx 1/N dies on a compute meter of **399,700 CU** carrying two
`InitializeBinArray` instructions for arrays the rehearsal AND the `ensureBinArrays`
probe had both reported as existing.

**The published hypothesis was WRONG, and it is worth saying why.** It read: the SDK's
`addLiquidityByStrategyChunkable` expands the bin range beyond `[minBinId, maxBinId]`
and touches arrays outside `getBinArrayIndexesCoverage`'s probe. It does not.
`chunkBinRange` partitions the range contiguously and `getBinArrayIndexesCoverage`
returns a contiguous index run, so the union of the per-chunk coverage IS the probe's
coverage. **The probe never missed an array.** Chasing the probe would have found
nothing wrong with it, because nothing is.

**What actually happens** is one SDK flag disabling two safeguards at once.
`addLiquidityByStrategyChunkable` calls `chunkDepositWithRebalanceEndpoint` with
`isParallel: true`, and inside that function:

- `if (!isParallel) addLiquidityIxs.unshift(ComputeBudgetProgram.setComputeUnitLimit(…))`
  — so the chunked funding transactions, the only ones the wide path sends, carry **no
  compute budget at all**. `readRequestedComputeUnits` correctly returned null,
  `resolveComputeUnitLimit` correctly applied our 400,000 floor, and 400,000 − 2 × 150 CU
  (what the two ComputeBudget instructions themselves cost) is the **399,700** in every
  incident log. The SDK sizes the same work at `DEFAULT_ADD_LIQUIDITY_CU` = 1,000,000 per
  chunk plus 350,000 per array. **The wide path could never have worked, on any pool.**
- the parallel branch emits `initializeBinArray` for **every** array the chunk covers
  with **no existence check** and **no de-duplication across chunks** — the non-parallel
  branch has both, via `binArrayOrBitmapInitTracking`. So `preCreateMissingBinArrays`
  never removed those instructions; it only made every one of them redundant. And a
  redundant init is NOT free: simulated against mainnet on 8 Sep 2026,
  `initializeBinArray` on an existing array **succeeds and still consumes 202,242 CU**.
  Two of those is 404,484 CU — over budget before the liquidity work begins.

The NARROW path was never affected because `initializePositionAndAddLiquidityByStrategy`
takes a different route entirely: `createBinArraysIfNeeded` does a `getAccountInfo` per
array and emits an init only for the missing ones, and
`getEstimatedComputeUnitIxWithBuffer` simulates the whole instruction set. That
asymmetry — not luck, and not the position width — is why one path has a 100% success
rate and the other a 0% one.

**Reproduced without spending anything: `scripts/reproWideFunding.cjs`.** It builds the
real funding transactions for a real pool and decodes them. The position pubkey is a
throwaway `Keypair.generate()`, which is sound and is itself a finding —
`chunkDepositWithRebalanceEndpoint` uses the position only as an account meta and never
fetches it, so funding transactions CAN be built before the account exists. (CLAUDE.md
said the opposite; the two-phase split is still forced, but by the CPI realloc cap on
the create, not by the funding builder.) Against SOL-USDC on 8 Sep 2026:

| width | arrays covered | probe says missing | inits the SDK emits | outside probe | SDK CU ix |
|---|---|---|---|---|---|
| 77 | 2 | **0** | 3 (2 distinct, one boundary array twice) | **0** | none |
| 95 | 2 | **0** | 3 | **0** | none |
| 371 | 6 | **0** | 11 (6 distinct) | **0** | none |

Both defects are fixed in `onchainExecutor.ts`:

1. `fundingComputeUnits()` supplies the budget the SDK declines to, from its own
   constants (1,000,000 + 350,000 per surviving init, clamped to 1,400,000), passed to
   `asVersionedTransaction` as a floor combined with `Math.max` — so an SDK bump that
   starts attaching a larger budget is still honoured.
2. `partitionFundingInstructions()` drops every `initializeBinArray` whose array
   `preCreateMissingBinArrays` verified exists. It is fail-safe in both directions: an
   instruction is dropped only when it decodes as `initializeBinArray`, its decoded
   index derives to a verified array, AND that derived address is the account the
   instruction actually names. Anything unrecognised is KEPT and paid for, because
   wasting compute is cheaper than stranding the funding.

`DEFAULT_ADD_LIQUIDITY_CU` and `DEFAULT_INIT_BIN_ARRAY_CU` are **not exported** by the
SDK, so those two numbers are hand-written — the one place this repository does that on
purpose. `onchainExecutor.test.ts` binds them to the installed bundle text AND asserts
they are still unexported, so a bump that moves or exports either fails the build.

**Still true, and the reason the engine stays capped:** the fix is proven by a builder
and a simulator, not by a funded wide open. `LIVE_MAX_POSITION_BINS` (default **70**,
narrow only) is the interim breaker. It is checked separately from the 1400-bin program
limit and reports separately, because one is a setting an operator can change and the
other is not — collapsing them is how 70 came to look like a hard maximum in the first
place. Pools over the cap are filtered BEFORE the LLM sees them (inside
`isLiveExecutionActive()`, so paper mode is byte-identical), because `seekNewEntry` acts
on the one pool the model picks and would otherwise burn the whole cycle.

**What the cap costs, stated so nobody reads it as a broken screener:** at the V1.1
−45%/+15% floors a 70-bin position only covers pools of **bin_step 106 and up** —
about 19% of the live 600-pool scan, against ~93% at 1400. `estimateBinWidth` in
`meteora.ts` is the screening-time estimate behind that filter; it is measured at the
`computeBinRange` floors, i.e. the NARROWEST range the engine can ever open, so nothing
openable is filtered out. It is never used to place a position — `binRangeFromPrices`
and the SDK remain the only authority there.

**To re-arm the wide path:** land one small wide open (~0.1 SOL, a pool of 80–120 bins),
confirm the funding transactions land, then set `LIVE_MAX_POSITION_BINS=1400`. Not done.

Still in place from before the halt: auto-unwind after failed opens (worked 3/3),
auto-close of created-but-unfunded positions, the execution breaker, `POOL_DENYLIST`.

## Reporting and reconciliation fixes (8 Sep 2026)

Five defects found by auditing what the engine SAYS against what it DOES. None changed a
trading rule; four were the engine reporting something untrue, and one was the emergency
command not doing its job at all.

**1. The funnel printed its stages in the wrong order.** `summary.candidates` is the
survivor count from AFTER the cooldown and execution gates, and `recordFunnel` printed it
in the slot BEFORE them, so a real cycle read `candidates 4 -> cooldown -0 -> exec-guard
-26` — a funnel losing 26 of 4. Every count was correct; only the order was wrong, which is
the worse failure, because it reads as corrupt data and sends the reader after a bug that
is not there. The screener's own output had nowhere to be recorded (`candidates` was doing
both jobs) and the `held` step was dropped silently, so the row could not be reconciled at
all. Now `screener_candidates` and `held_excluded` are stored, `candidates` is printed
last, and `screenerCandidates - heldExcluded - cooldownRejected - executionRejected ===
candidates` is asserted by `src/tests/funnel.test.ts`.

**`execution_rejected` is also split three ways** — `exec_bincap_rejected` /
`exec_breaker_rejected` / `exec_denylist_rejected` — because the bin cap is the OPERATOR'S
SETTING refusing most of the universe while the wide path is unvalidated, and the other two
are facts about a pool. One column could answer neither "is something broken" nor "what is
my cap costing me", and the second is the number the halt is waiting on. The dashboard
panel showed neither gate and labelled `candidates` "Passed screen"; both are fixed, and
`FunnelCycle` in `dashboard/src/lib/api.ts` had omitted `executionRejected` entirely.

**2. Telegram announced LIVE positions as PAPER.** `sendPositionOpened` hard-coded
`PAPER POSITION OPENED (DRY-RUN)` and `sendPositionClosed` `PAPER POSITION CLOSED`, with no
dry-run branch anywhere — for the whole time the engine was armed with real capital. The
same alert reported `virtualSol: env.VIRTUAL_SOL_PER_POSITION`, the paper constant, while
the row was written with `sizing.sizeSol` from free capital: the alert and the position
disagreed, with nothing else in the system to contradict either. And `ilUsd` was rendered
"Impermanent loss" while carrying `netPnl - fees`, the LP VALUE CHANGE — about 5x larger
for the same move, i.e. a working engine made to look broken. `live: boolean` is now
REQUIRED on both payloads (a default is what let this go unnoticed when live execution
landed), the field is `positionValueChangeUsd`, and the boot banner no longer says "this
build still signs nothing" while armed to sign. `src/tests/liveLabelling.test.ts`.

**3. `/close_all` marked LIVE rows closed without closing them on-chain.** The emergency
command called `closePosition(...)` straight into SQLite for every active row — no
`closeLivePosition`, no signature, nothing sent. The operator got "book flat" while the
DLMM positions were untouched, and since the rows were no longer ACTIVE the fast monitor
stopped watching them: real capital in a position with nothing enforcing its stop-loss.
That is the exact failure the "no row is marked closed until the close confirms" rule
exists to prevent, reached through the command an operator uses when something has already
gone wrong. `forceCloseAllPositions` is now two-phase like the monitor and reuses
`settleLiveCloses`; a live row whose close fails stays ACTIVE and is reported with the
words "the ON-CHAIN POSITION IS STILL OPEN". `src/tests/manualClose.test.ts`.

**4. Nothing ever compared the database's PnL to the wallet.** Every figure a LIVE position
carries comes from the paper valuation model — `closeLivePosition` returned signatures and
never amounts, so the chain was asked to close and never asked what came back. The model
cannot see the balancing swap's slippage, the priority fees, or bin-array rent, and all
three push the same way, so the drift was systematic, one-directional and unmeasured.
`wallet_lamports_before` / `wallet_lamports_after` are now read from the chain either side
of a live trade, `src/services/reconciliation.ts` compares the two accountings,
`GET /api/reconciliation` serves it, and the boot log prints one line.

Three properties there are load-bearing:

- **It corrects nothing.** `realized_pnl_usd` keeps its definition, for the same reason gas
  is recorded and not deducted — silently redefining a historical column is worse than a
  reported gap. This measures the gap and names it.
- **An unmeasured row is excluded from BOTH totals**, never counted as zero. Including a
  model figure with no chain figure beside it would manufacture drift out of a missing
  measurement, and `driftPctOfModel` is null rather than 0 when nothing is measured: "no
  basis to compare" and "compared, and they agree" render identically otherwise.
- **Overlapping windows are flagged.** The balance either side of one trade belongs to the
  whole wallet, so at `LIVE_MAX_CONCURRENT_POSITIONS=1` attribution is clean and above 1
  only the aggregate means anything. Saying so is the difference between a reconciliation
  and a number.

**5. The friction gates never priced the one cost that is unrecoverable.** Both charged
`gas + slippage`. A bin array is a pool-level account shared by every LP — `close_bin_array`
is in the IDL, the SDK exposes no wrapper, nothing here can reclaim it — so at 0.0714 SOL
each against the 0.008 SOL gas floor, one new array is about NINE TIMES the entire modelled
cost of the trade, against a $1.50 net-PnL bar.

**The obvious fix is wrong and was rejected.** Charging one array to every candidate at
screening time moves the binding bar from **7.50% to 29.82% fee/TVL** at the shipped 0.80
SOL profile: it admits nothing, including on liquid pools whose real unrecoverable cost is
exactly zero. That is the "broken screener" failure this file warns about twice, arrived at
from the cautious side. So `LIVE_ENTRY_RENT_SOL` exists and **defaults to 0**, and the real
gate is `openLivePosition` asking the CHAIN (`quoteCreatePosition`) how many arrays THIS
range must create, then refusing — before the balancing swap, so the refusal is free — when
that rent exceeds `LIVE_MAX_RENT_TO_PNL` (default 1) times the net PnL the entry was
admitted on. "Can I afford it" and "is it worth it" are different questions and only the
first was being asked. `UnrecoverableRentError` is a `LiveEntryRefusedError`, so it is a
routine skip and earns no execution-breaker strike — the arrays exist or they do not, which
is not evidence the chain would reject the open. `chargeEntryFrictionUsd` replaces
`chargeRoundTripGasUsd` at both gate call sites, so the advertised bar and the enforced one
stay one number.

### What the narrow-only cap silently switched off

`LIVE_MAX_POSITION_BINS=70` is the right interim breaker, but the entire pre-swap apparatus
built after the 7-8 Sep failures runs on the WIDE path only, so the cap turns all of it off
at once: `rehearseOpenPosition` plans steps only when `binWidth > DLMM_BINS_PER_INIT` and so
always returns zero steps and `ok: true`; `preCreateMissingBinArrays` never runs; and the
execution breaker's two FREE strike paths (rehearsal refusal, bin-array prep failure) can
therefore never fire, leaving only the post-swap `stage: "open"` strike — the expensive one
it exists to prevent a repeat of. That is acceptable, because the narrow path's fused
transaction is budgeted by the SDK simulating it and `onchainExecutor.test.ts` asserts that.
But it must not read as "verified", and it did.

`binArraysToCreate` was `wide ? missing.length : 0`, so a narrow range about to create
arrays reported zero, and `openLivePosition` printed **"no account creation needed (all bin
arrays exist)"** — a false claim about the one spend that can never be undone. Now
`binArraysToCreate` is always the chain's answer, `fusedIntoOpen` carries the separate fact
that nothing was simulated, and the log says `NOTHING WAS REHEARSED` and prices the arrays.
Also fixed: `liveExecution.ts` decided the narrow/wide boundary with a hand-written
`binWidth <= 70` in the spend-ceiling check while the other two sites read
`DLMM_BINS_PER_INIT` — invisible to the test that binds that constant to the SDK. The same
discipline now covers rent: `DLMM_BIN_ARRAY_RENT_SOL` is exported and bound to the SDK's
`BIN_ARRAY_FEE`. `src/tests/narrowOnly.test.ts`.

## Official baseline: FlowMetrix DLMM AI Agent V1.1

**V1.1 is the only configuration the live engine runs.** There is no v1.0 code path, no legacy
mode, and no env flag that reverts the engine to pre-V1.1 behaviour. These six values are the
parsed defaults, and `src/tests/v11Baseline.test.ts` fails if any drifts:

| Guardrail | Value | Symbol |
|---|---|---|
| Pool cooldown | 4 h | `POOL_COOLDOWN_HOURS` |
| Lockout | 2 consecutive failures → 24 h | `POOL_LOCKOUT_CONSECUTIVE_FAILURES` / `POOL_LOCKOUT_HOURS` |
| Breakeven friction gate | ON, 2.5× round-trip cost | `MIN_FEE_COST_COVERAGE` |
| Screener cadence | 30 min | `CRON.DLMM_LOOP` |
| Fast monitor | 60 s | `CRON.FAST_MONITOR` |
| Reasoning cap | 16 000 tokens, graceful skip | `REASONER_MAX_TOKENS` |

Changing any of them is a change to the official baseline: update the test in the same commit and
say why in the message. A zero is not a neutral value here — `POOL_COOLDOWN_HOURS=0` and
`POOL_LOCKOUT_*=0` disable those gates entirely (`env.ts` accepts zero and says so), which is
pre-V1.1 behaviour reintroduced through configuration.

**Two things reference v1.0 on purpose. Do not "clean them up".**

- `engine_version`, `ENGINE_V11_CUTOFF` and `src/services/cohort.ts` label the 27 pre-V1.1 trades
  rather than deleting them, so V1.1 can be reported on its own. Dropping the label does not remove
  the trades — it merges a superseded engine's −$3.34 into V1.1's +$44.32 and misstates both.
- `withoutAntiChurn` and the inert guardrail defaults in `defaultBacktestConfig()` are the CONTROL
  ARM of the anti-churn A/B that `backtest:micro` and `backtest:annual` run. They are measurement
  scaffolding, not a legacy fallback; see "The backtest's V1.1 guardrails default to OFF" below.

**A third thing looks unused and is not. Do not delete it.**

- `src/config/liveConfig.ts` and `src/services/livePreflight.ts` are the LIVE MICRO-CAPITAL
  PROFILE (1 SOL). Every value in them is inert behind `LIVE_MICRO_CAPITAL=false`, so with the
  flag off nothing they contain executes and coverage over them looks dead. That is the design,
  not neglect — the same inert-default discipline `defaultBacktestConfig()` uses. They are the
  reviewed envelope the engine will size and screen against when real capital is deployed; see
  "The live micro-capital profile is inert by default" below before touching either file.
- `src/services/onchainExecutor.ts` and `scripts/testMicroSwap.ts` are the on-chain path:
  Stage 1 (wallet, signing, priority fees, send/confirm, Jupiter) and Stage 2 (the DLMM
  adapter) are both IMPLEMENTED, and both are still unreachable. Nothing in the engine
  imports them — by design, and enforced by a test — so their coverage looks dead.
  Deleting them as unused removes the only reviewed
  signing path; wiring them into the engine to make them "used" defeats the isolation they
  exist to provide. See "`src/services/onchainExecutor.ts` can sign real transactions" below.

## Live entry hard limits (learned 7 Sep 2026, real money)

**70 was the wrong number, and believing it cost 0.4 SOL and ~75% of the universe.**
The original note here said a position account "spans at most 70 bins (IDL
`MAX_BIN_PER_POSITION`)" and told the reader not to widen it. 70 is real but it is
`DEFAULT_BIN_PER_POSITION` — all a single `initializePosition` ALLOCATES — not what the
account can HOLD, which is **1400** (`POSITION_MAX_LENGTH`). Nothing failed loudly: the
constant was hand-written in `liveExecution.ts`, agreed with no test, and the cost
surfaced only as entries dying after the balancing swap had already spent the SOL.

The account is grown past 70 by TOP-LEVEL `increasePositionLength` instructions of at
most `MAX_RESIZE_LENGTH` (91) bins each. 91 x 112 bytes = 10192, just under Solana's
10240-byte realloc cap — which is where the cap comes from, and why the original
"InvalidRealloc" diagnosis was right about the mechanism and wrong about the remedy.
`initializePositionAndAddLiquidityByStrategy` cannot do this: it asks
`initializePosition` for the FULL width in one instruction, so the realloc happens
inside a CPI and dies above 70.

Verified against mainnet by simulation on 7 Sep 2026 (`scripts/simWidePosition.cjs`,
`sigVerify:false`, nothing sent):

| width | result |
|---|---|
| 70 / 100 / 300 / 600 / 1200 / 1400 | OK — one transaction, 1400 bins = 17 ix, 772 bytes, 153k CU |
| 1401 and above | `InvalidPositionWidth` (custom 6040) at `increase_position_length.rs:52` |

**1400 is a hard program limit. The BINDING limit on this wallet is rent, not 1400.**
A position account is rent-exempt and rent scales linearly with width: ~0.057 SOL at 70
bins, ~0.996 SOL at 1400. Bin arrays cost a further 0.0714 SOL EACH for any that do not
exist yet, and a wide range spans many — on a liquid pool that is zero, on a fresh pool
it is the larger of the two costs. The live envelope leaves `deployableSol -
maxExposureSol` = **0.20 SOL** for rent, which admits **278 bins**.

Measured against the live 600-pool scan, for the engine's −45%/+15% range:

| bin cap | pools admitted | share |
|---|---|---|
| 70 (before) | 114 | 19.0% |
| 278 (now, rent-limited at 1.15 SOL) | 446 | **74.3%** |
| 1400 (program max, needs more capital) | 559 | 93.2% |
| >1400 — impossible in one position | 41 | 6.8% |

The last row is `bin_step` 1–5, which need 1477–7378 bins. Those are the tight-spread
majors, and `MAX_TVL_USD` rejects most of them anyway. Reaching them at all needs route
(b) below.

What is live:

1. `openLivePosition` gates TWICE before the balancing swap, both as
   `BinWidthExceededError` (a routine `seekNewEntry` skip, no operator page): once on
   the 1400-bin program limit, once on whether the open is AFFORDABLE. The affordability
   figure comes from the SDK's `quoteCreatePosition`, which reads the chain — estimating
   bin-array rent from the width alone is wrong in both directions.
2. `dlmmExecutor.openPosition` keeps the narrow path (≤70 bins) as ONE atomic
   transaction, and takes a two-phase path above it: `createExtendedEmptyPosition`
   (init + resizes), then `addLiquidityByStrategyChunkable`. Two phases is forced by
   the CREATE, not by the funding: `initializePosition` asks for the full width in one
   instruction and dies in the CPI realloc cap above 70 bins. This used to say the
   funding transactions "cannot be built in advance — the SDK reads the position account
   to build them", which is false in 1.9.14 and worth knowing: the funding builder uses
   the position only as an account meta and never fetches it, which is what makes
   `scripts/reproWideFunding.cjs` able to inspect real funding transactions for free.
   Every failure after the create is reported as
   `DlmmPartialExecutionError` naming the position address, because at that point a
   funded-but-empty account exists and its rent is recoverable only by closing it.
3. Rent is charged to `ONCHAIN_MAX_LAMPORTS_PER_TX` on BOTH paths. It was not before:
   the ceiling saw only the deposit, while CLAUDE.md described it as bounding the
   transaction. Same defect class as the coverage gate — advertised bound, unenforced.
4. Any open failure after the swap still auto-unwinds: the catch block sells the paired
   token back to SOL via Jupiter and puts the rescue signature in `StrandedSwapError`.

**Do not hand-write these constants again.** `DLMM_BINS_PER_INIT`,
`DLMM_MAX_BINS_PER_POSITION`, `DLMM_POSITION_MIN_SIZE` and
`DLMM_POSITION_BIN_DATA_SIZE` live in `onchainExecutor.ts` and
`onchainExecutor.test.ts` asserts every one of them against the installed SDK, plus
that `MAX_RESIZE_LENGTH x 112 <= 10240`. An SDK bump that moves any of them fails the
build instead of the wallet. That test is the actual fix here; the number is just its
first output.

Raising `LIVE_CAPITAL_SOL` is the sanctioned lever for more coverage — it buys rent
headroom, and the POSITION account's rent is recovered when the position closes. **Bin
array rent is not** — see "Bin-array rent is NOT recovered" below; this sentence used to
claim both. Open work for the last 6.8%:
chunk the range into multiple <=1400-bin positions. That breaks the
one-position-per-pool assumption in DB/monitor/close/claim and is a real refactor;
write the design down before starting it. Not started.

### Live deployment config (7 Sep 2026 — wallet ~3.10 SOL)

The live server runs env overrides on top of the code defaults (`.env` is untracked;
`.env.example` mirrors them):

- `DRY_RUN=false`, `LIVE_MICRO_CAPITAL=true`, `ONCHAIN_EXECUTION_ARMED=true`
- `LIVE_CAPITAL_SOL=3.05` (code default 1.15 stays the reviewed micro envelope)
- `LIVE_MAX_POSITION_SOL=1.8` — deployable = 3.05 − 0.15 reserve = 2.90, leaving
  1.10 SOL rent headroom: admits everything up to the 1400-bin program limit (93.2%,
  was 74.3% at the 0.20 SOL headroom of the default profile)
- `ONCHAIN_MAX_LAMPORTS_PER_TX=1800000000` (1.8 SOL) — MUST track
  `LIVE_MAX_POSITION_SOL`: the boot validator refuses to start when the spend
  ceiling is below the max position deposit (hit live on 7 Sep after raising the
  position to 1.8 without touching the ceiling)

First attempt at the new envelope exposed a real bug (7 Sep, live, real money):
STONK-SOL (371 bins) passed both pre-swap gates and the balancing swap, but the
wide-create transaction died on COMPUTE: the create carries 2x `InitializeBinArray`
(~192k CU each) plus overhead in one tx, over the 399,700 CU budget. Net result:
position account `6MdbD6GjaM49fm7fQTwnvyZUVfbjgogbAkVuVEu5MURs` exists but empty
(0.2657 SOL rent locked), zero bin arrays initialized, and the V1.1 auto-unwind
worked exactly as designed — the 0.9 SOL of paired tokens was sold back to SOL
on-chain (verified: wallet back to 2.81 SOL, no token dust).

The pool stays a candidate, so every 30-min cycle re-attempted it. Two same-day fixes
(commit 35f6366 + follow-up) stopped that specific pool: `POOL_DENYLIST`, and
`preCreateMissingBinArrays`, which moves bin-array creation out of the SDK's chunked
funding transaction and into one transaction each.

Both still stand, but **neither was the root cause**, and the investigation that
followed found the same defect on paths that had never run. The sections below are the
result; read them before touching the execution path.

Orphan account `6MdbD6GjaM49fm7fQTwnvyZUVfbjgogbAkVuVEu5MURs` (0.2657 SOL rent)
was closed the same evening via `scripts/closeOrphanPosition.cjs` (SDK
`closePosition2`; valid because the position held zero liquidity) — 0.265727 SOL
recovered, wallet back to 3.08 SOL. The script is kept as the template for closing
any future empty position account the engine leaves behind.

### Second strike, same class (SOLCAT-SOL, same evening) — now fixed structurally

SOLCAT-SOL (77 bins, wide path) repeated the STONK failure pattern: the SDK's
funding builder packed 2x `InitializeBinArray` into funding tx 1/N and died on the
CU meter AFTER the balancing swap confirmed. The rehearsal could not see it (it
only simulates the create phase — the funding phase needs the swapped token), and
the SDK's own budget for that transaction was the too-small number. Auto-unwind
worked again (verified), 0.0572 SOL orphan closed via
`scripts/forceClosePosition.cjs` (generic by pool+position args).

Structural fix (commit after `9b96d7e`):
1. `dlmmExecutor.ensureBinArrays` — missing bin arrays are now pre-created BEFORE
   the balancing swap (liveExecution, wide ranges only). A failure there costs
   nothing and is a routine refusal, not a stranded balance. The executor's own
   post-swap prep remains as defence-in-depth.
2. Executor wide-path catch now AUTO-CLOSES a created-but-unfunded position
   (best effort, `closePosition2` on the account it just created) — no more
   orphan accounts waiting for a human-run script.

**"No orphan left behind" was true only of an UNFUNDED account, and this used to say it
without the qualifier.** `closePosition` does not withdraw, so on a position whose
funding PARTLY landed that auto-close is refused by the program — and the catch logged
"could not auto-close unfunded position" about an account that was funded and earning.
It now reads the position first and says so instead of sending a doomed transaction; the
recovery that does work lives in `openLivePosition` and is described under "The
half-landed open" below. Residual risk after that: funding can still fail for reasons
other than missing arrays, and those now cost the swap round-trip (auto-unwind) plus
whatever the recovery could not put back.

### The compute budget: `ONCHAIN_COMPUTE_UNIT_LIMIT` is a FLOOR, not a cap

**This is the root cause of the 7 Sep failure, and it was bigger than the pool it
surfaced on.** `asVersionedTransaction` has to strip the SDK's compute-budget
instructions — two `setComputeUnitLimit`s in one transaction is a hard runtime reject,
and the priority fee has to be ours for `sendAndConfirm`'s escalation to mean anything.
What it did was strip them **without reading them**, replacing a budget the SDK had
sized per call with one flat 400,000.

The SDK sizes every call, and it is the only party that can:

| SDK path | how it budgets |
|---|---|
| `initializePositionAndAddLiquidityByStrategy` (narrow open), `removeLiquidity`, `claimSwapFee` | `getEstimatedComputeUnitIxWithBuffer` - **simulates** against the cluster, adds a 50k-200k buffer, falls back to 1.4M if the simulation itself fails |
| `createExtendedEmptyPosition` (wide create) | a STATIC formula, no simulation: `min(30,000 + 30,000 x extendedBinCount, 1,400,000)`. It saturates at the 1.4M ceiling from ~117 bins upward, while measured consumption at 1400 bins is ~153k, so a wide create RESERVES about nine times what it uses. Harmless - a limit is a reservation, not a charge - but it is where the fee note below comes from. This row said "simulates" until an audit read the shipped build; the test suite covers the three rows above and not this one |
| `addLiquidityByStrategyChunkable` (wide funding) | **IT DOES NOT.** Corrected 8 Sep 2026 — this row used to say `DEFAULT_ADD_LIQUIDITY_CU` = 1,000,000 per chunk, and that constant is real but the instruction carrying it is never emitted: the branch that attaches it is `if (!isParallel)` and this path passes `isParallel: true`. So the transactions the wide path actually sends carry NO compute budget, and our floor applied to all of them. See the HALTED section at the top; `fundingComputeUnits()` supplies it now |
| each inline `InitializeBinArray` | `DEFAULT_INIT_BIN_ARRAY_CU` = **350,000** in the SDK's accounting — but on the parallel path this too is never added up, and the instruction is emitted whether or not the array exists. Measured on-chain: **202,242 CU even when it does** |

So the enforced budget was 400,000 wherever the SDK had asked for up to 1,400,000. That
is not a STONK-SOL bug: **every path was affected, including the two that have never
run** — and on the wide funding path, where the SDK asked for nothing at all, taking the
maximum of "nothing" and the floor still yields the floor. That is why this fix was
necessary but not sufficient, and why the wide path kept failing for another day after
it landed.** A `removeLiquidity` that will not fit its budget is strictly worse than a failed
open — the capital is already committed, the row stays ACTIVE, and the stop-loss is what
stops being enforceable.

`resolveComputeUnitLimit` now takes the **maximum** of the SDK's request and the
configured floor, clamped to Solana's 1,400,000. Never invert it to a `Math.min`: taking
the smaller number reads as cheaper (the priority fee really is price × REQUESTED units)
and is exactly the defect. The over-request is not free - a wide create reserves 1.4M CU against ~153k used -
but it is small in both directions: about 0.000028 SOL at the
`ONCHAIN_MIN_PRIORITY_MICRO_LAMPORTS` floor, and about 0.0028 SOL per rebuild at the
escalation ceiling, against a failure that has twice cost tenths of a SOL. There is a test named
after the inversion.

Two details that are load-bearing:

- **The clamp protects against the SDK too.** `getEstimatedComputeUnitIxWithBuffer` adds
  its buffer *without* re-clamping to `MAX_CU`, so a heavy transaction can come back
  above 1.4M and be rejected outright. Our clamp is the only thing stopping that.
- **The narrow path needed no separate fix, and that is a measured claim, not a hope.**
  A range of ≤70 bins spans TWO bin arrays unless it aligns to the array boundary
  (`MAX_BIN_ARRAY_SIZE` = 70), so on a thin pool that single fused transaction can carry
  two 350k inits — over any 400k floor. It survives because the SDK simulates the whole
  instruction set. `onchainExecutor.test.ts` asserts the SDK still does that on the
  narrow open, `removeLiquidity` and `claimSwapFee`; if a bump removes it, the build
  fails instead of the wallet.

### The active-bin race: one knob held two quantities (9 Sep 2026)

The compute-budget defects above were fixed on 8 Sep, and the next wide open still did
not land. This time the funding transactions were refused by the **program**, not the
meter: `ExceededBinSlippageTolerance` (custom **6004** in the IDL).

**One line of the SDK explains it.** `addLiquidityByStrategyChunkable` derives the
program's active-bin tolerance from the same `slippage` field that bounds a price:

```
maxActiveBinSlippage = getAndCapMaxActiveBinSlippage(slippage, binStep, 3)
                     = ceil(slippagePercent / (binStep / 100))     // in BINS
```

and `openPosition` was handing it `resolveSlippageBps(...) / 100` — **Jupiter's 0.5%
swap bound**. On any pool of `bin_step` 50 or more that ceils to **one bin**, including
the entire band the 70-bin cap admits (`bin_step` 106 and up). The instructions carry
the active bin as read at BUILD time, so one bin of tolerance had to survive a window
that includes a blockhash lifetime — and, on expiry, a rebuild that re-sent the same
stale active bin with a fresh blockhash and a higher fee.

**Note the name lies slightly, and it matters.** `getAndCapMaxActiveBinSlippage` caps
nothing when a percentage is supplied; the `MAX_ACTIVE_BIN_SLIPPAGE = 3` default applies
only to the branch that receives none. So the SDK will send whatever tolerance it is
given, which is why our own hard ceiling has to exist.

**Two quantities, one knob, and the tight one won.** They are not the same kind of
number and must not share a bound:

| | what it bounds | what a bp buys |
|---|---|---|
| `HARD_MAX_SLIPPAGE_BPS` (50) | a Jupiter SWAP | money the fill can lose |
| `HARD_MAX_ACTIVE_BIN_SLIPPAGE_BPS` (1000) | a DLMM DEPOSIT | bins of drift the funding survives |

`ONCHAIN_MAX_ACTIVE_BIN_SLIPPAGE_BPS` defaults to **300** (3 bins at `bin_step` 100, 15
at 20). It is still clamped down only, for the same reason the swap bound is: a bound
configuration can widen is not a bound.

**Widening it is not free, and the cost is charged rather than assumed away.** The SDK
applies the SAME percentage to `maxDeposit{X,Y}Amount`
(`floor(amount x (100 + pct) / 100)`), so a wider tolerance also raises what the program
may pull from the wallet. `maxDepositLamports` mirrors that formula and both paths now
charge the WIDENED figure to `assertWithinSpendLimit` — the same defect class this file
already fixed for bin-array rent, where an advertised bound was not the enforced one.

Three fixes, and they are separate on purpose:

1. **`depositSlippage()`** resolves the tolerance against the pool's own bin step and
   returns bins, percent and the deposit ceiling factor together, so a call site cannot
   convert one and forget the other. Both formulas MIRROR the installed SDK and
   `onchainExecutor.test.ts` binds them to its bundle text.
2. **A funding rebuild carries a FRESH active bin, and a PREFLIGHT rejection now earns
   one.** The second half is what makes the first half reachable: the OTC-SOL funding
   transaction was refused in SIMULATION, and `sendAndConfirm` treats a preflight
   rejection as terminal — correctly, for every other cause, because identical
   instructions would be refused identically. `ExceededBinSlippageTolerance` is the
   exception, because the rebuilt instructions are NOT identical: the rejection is a
   statement about elapsed time, not about the work. Without that branch the rebuild
   would have been dead code on the exact incident it was written for, since the
   transaction never reached a blockhash expiry. Rebuilding there is SAFER than the
   expiry path, not looser: preflight means nothing was broadcast, where expiry only
   means the old bytes can no longer land. `isStaleActiveBinRejection` matches the
   Anchor name AND the raw `0x1774`, because the logs carry one and the message the
   other. Every other preflight rejection stays terminal. `sendSequentially` takes a
   `rebuild` callback, and the wide path's calls `pool.refetchStates()` before
   re-deriving the instructions. The refetch is the load-bearing half: the SDK builds
   from `this.lbPair`, which it caches, so without it a "rebuild" hands back
   byte-identical instructions and escalates the fee on a transaction that will be
   rejected for the same reason. **This does not weaken the rebroadcast rule** —
   `sendAndConfirm` invokes its builder on the first attempt and then only after the
   previous blockhash has EXPIRED, which makes the previous signature permanently
   unlandable; changing instructions there is exactly as safe as changing the
   blockhash, which that loop already does. A rebuild that returns a different number
   of chunks is REFUSED rather than mapped by index, because part of the sequence may
   already have landed.
3. **An execution-time volatility gate**, `ActiveBinRaceError`, before the swap.

### The screener's volatility gates cannot see this, and the unit is why

`MAX_PRICE_SURGE_1H_PCT`, `MAX_PRICE_CHANGE_24H_PCT` and `MAX_REALIZED_VOL_PCT_PER_HOUR`
ask whether a pool is a good place to HOLD liquidity, in percent per hour. The question
this failure poses is whether the pool will hold still long enough for a deposit to
LAND, and the program answers it in BINS. A pool at 20%/h passes the screener and, at
`bin_step` 10, drifts **5 bins in 90 seconds** against a 3-bin tolerance.

So `openLivePosition` converts the measurement into the unit that decides:

```
binsPerHour   = rvolPctPerHour / (binStep / 100)
projectedBins = binsPerHour x (LIVE_EXECUTION_WINDOW_SECONDS / 3600)
refuse when projectedBins > toleranceBins x LIVE_MAX_BIN_DRIFT_RATIO
```

Four properties are load-bearing:

- **It is a FREE refusal and earns no breaker strike.** It runs before the balancing
  swap, and volatility is a fact about the pool right now — not evidence the chain will
  always reject this open. Benching a pool for 24 hours over a busy half-hour is the
  gate punishing the wrong thing. Same reasoning as `UnrecoverableRentError`.
- **It reuses `VOLATILITY_ON_UNKNOWN`** rather than introducing a second policy for the
  same question. Two knobs answering "what if volatility cannot be measured" means one
  concept holds two answers depending on which gate you ask.
- **The arithmetic is crude on purpose.** It is an order-of-magnitude check, not a
  forecast, which is why the default ratio is 1 rather than something finer.
- **When it cannot run it SAYS SO.** The bin step comes from `quoteOpenCost`, which only
  runs under the live micro-capital profile, so with `LIVE_MICRO_CAPITAL=false` the log
  reads `NO BIN-DRIFT CHECK ... skipped, not passed`. A gate that silently does nothing
  is the "all bin arrays exist" line again.

The incident that produced all three is `docs/incidents/2026-09-09-exceeded-bin-slippage-wide-fund.md`
(OTC-SOL, 77 bins, ~0.033 SOL). Its own three candidate fixes are these three; the
safety nets from 6d685d8 worked — auto-unwind finalized, unfunded position auto-closed,
no orphan, and the breaker benched the pool.

**Still unproven by a funded open.** Every one of these three is verified by unit tests,
by the SDK's own shipped source, and by the IDL — not by a wide position that landed.
`src/tests/activeBinSlippage.test.ts` and the active-bin block in
`onchainExecutor.test.ts`.

### The half-landed open: a funded position the engine believed did not exist (10 Sep 2026)

**Nothing lost, and it is still the worst failure so far**, because it is the only one
where the engine was WRONG ABOUT WHAT IT OWNED. KNOTS-SOL, on a pool that was pumping:
the balancing swap confirmed, the wide path's funding transactions went out one at a
time, **two landed**, and the next was refused at preflight for insufficient funds
(`TransferChecked`, the SPL token program's `0x1`). The engine reported "open failed",
sold the wallet's leftover KNOTS back to SOL, benched the pool for 24 hours, and moved
on. Position `ENNpRNx6aotJH4hFtT7NMB6TdeAUm9QWBGX9pYUBkDLZ` was **partially funded and
stayed on-chain**, earning $18.47 (+11.6%) over four hours with nothing valuing it,
nothing enforcing its stop-loss, and `/status` reporting **zero active positions**. A
human found it and closed it.

**Three rules meet in the hole, and every one of them is right.** No row is written
until the open CONFIRMS, so a half-landed open writes nothing. The failure path unwinds
the WALLET, because a stranded token balance is what a failed open used to leave behind.
And `requirePosition` fails closed when the owner scan does not list a position — the
correct answer when the caller knows only the owner, and the exact wrong one here, where
the caller already holds the address the failure named. The gap between them is a
position that exists, holds capital, and has no owner in the system.

**`DlmmPartialExecutionError` was already the whole diagnosis and nothing acted on it.**
It is raised only when some of an operation's transactions landed, and it NAMES the
position. `openLivePosition`'s catch now reads that account before it touches the wallet:

1. **The position first, the wallet second, and the order is the fix.** The withdrawal
   returns the paired token to the wallet, so closing first means the existing auto-unwind
   sweeps it up in the same pass. Reversed, the unwind sells against a balance the
   position is still holding and leaves the withdrawn tokens behind.
2. **It reads the ACCOUNT, not the owner index.** `readPositionDirect` is a
   `getAccountInfo` on the address the error named — no `getProgramAccounts` scan to lag
   behind an account created seconds ago. What that loses is the scan's implicit proof of
   ownership, so it is re-established explicitly and **from the SDK's own memcmp
   descriptors** (`positionLbPairFilter`, `positionOwnerFilter`) rather than from offsets
   written out here: hand-writing `8` and `40` would keep compiling after a layout change
   and silently compare the wrong bytes, and a check that always passes is worse than none.
   An account that is there but is not ours THROWS.
3. **Recovery is a withdraw-claim-close, never a close.** `closePosition` does not
   withdraw, which is why the wide path's own auto-close was refused by the program on
   this account while logging *"could not auto-close unfunded position"* about a position
   that was funded and earning. `closeOrphanPosition` uses `removeLiquidity` at 10 000 bps
   with `shouldClaimAndClose`, sharing ONE implementation with the tracked close so the
   recovery path cannot drift into closing without claiming. Unclaimed fees count as worth
   recovering: closing without claiming throws them away with the account.
4. **It never throws, and it never writes a row.** It runs on a failure path that still
   has to unwind the wallet, so a recovery that threw would trade a funded position for a
   stranded token balance. A failure is reported as `state: "failed"` and the alert says
   **"THE ON-CHAIN POSITION IS STILL OPEN"**, the same words `/close_all` uses for the
   same situation. And a recovered position is not a holding — recording one would be the
   fabricated row the "no row until the open confirms" rule exists to prevent, reached
   from the other direction.
5. **A missing report is reported.** `StrandedSwapError`'s `orphan` defaults to null
   because most failed opens create nothing, but on a `DlmmPartialExecutionError` that
   default would be a lie by omission — so null there renders as *"A POSITION MAY STILL BE
   FUNDED ON-CHAIN … CHECK <address> BY HAND"*.

**The narrow path was next, and it had never been suspected because it is atomic.**
Atomic is not the same as safe: its single fused transaction was sent **BLIND**. The
rehearsal skips it on purpose (the deposit cannot be simulated before the swap that funds
it), so nothing between the swap and the cluster ever looked at it — and the SDK's own
simulation is not a check, it is a compute-budget estimate:
`getEstimatedComputeUnitIxWithBuffer` swallows a failed simulation, falls back to 1.4M CU
and sends anyway. `openPosition` now simulates it first, with the SAME budget the send
will carry (`simulateAgainstCluster` is the one resolver both it and the rehearsal use;
two copies is how they drift). On a refusal it **re-quotes against the chain** —
`NARROW_OPEN_REQUOTE_ATTEMPTS` = 2 — and only for the two causes a rebuild can change:

| rejection | remedy |
|---|---|
| shortfall (`isInsufficientFundsRejection` — token `0x1`, and the `{"Custom":1}` form a simulation actually returns) | re-read the ATA and deposit what is really there |
| stale active bin (`isStaleActiveBinRejection`, `0x1774`) | `refetchStates()` and rebuild |

Four properties there are load-bearing:

- **A simulation that could not RUN sends anyway.** An RPC that did not answer is not
  evidence the open would fail; failing closed on a provider hiccup would strand the swap
  over something that has nothing to do with the pool. Same rule as the rehearsal.
- **Anything else is refused, not retried.** Rebuilding cannot change it, and sending
  would buy a guaranteed failure at the price of a priority fee.
- **The re-quote only moves DOWN** (`BN.min`). A balance that reads larger must never
  raise the deposit — that would spend on an instruction nobody authorised. An unreadable
  balance is `null`, never `0`, or the re-quote would deposit nothing and report that as
  the position's funding.
- **The executor reports what it actually deposited.** `DlmmOpenResult` adds
  `depositedPairedAmount` and the bridge writes THAT, not its own pre-open balance read,
  which a re-quote makes stale. Same defect class as the four reporting fixes above.

`src/tests/orphanRecovery.test.ts` is the bridge's half; the executor's half is in
`onchainExecutor.test.ts`, which is the file allowed to import the signer — **the
allowlist still has four entries**, and keeping it there is why the tests are split.

The incident is `docs/incidents/2026-09-10-half-landed-open-unmonitored-position.md`,
which also records the one thing this fix does NOT answer: a `stage: "open"` failure
benches a pool immediately, so the second attempt 31 minutes later should not have been
possible. If a post-swap strike can fail to bench, that is the 7 Sep repeat-loss
mechanism still live, independently of everything above — the `pool_execution_failures`
row settles it.

**Still unproven by a funded open.** Verified by unit tests and by the SDK's shipped
source, not by a partial open that was recovered on-chain.

### The pre-swap rehearsal is the gate that did not exist

Every other gate names a condition and checks it — the width, the rent, the denylist.
The compute overflow was not a condition anyone had named, which is why it got through a
carefully gated path and cost money. `rehearseOpenPosition` asks the **cluster** to run
the account-creation transactions with `sigVerify: false` and reports what it says. It is
the same technique `scripts/simWidePosition.cjs` used to establish the 1400-bin limit
without spending anything, moved onto the live path and run BEFORE the balancing swap.

It rehearses with **the same compute budget the real send will carry**. A rehearsal
simulating against a different limit than production uses would pass exactly the
transactions production then fails.

Three boundaries are deliberate and must not be quietly "improved":

- **It rehearses the WIDE path only.** Standalone `initializeBinArray` transactions
  exist there alone; the narrow path fuses the inits into
  `initializePositionAndAddLiquidityByStrategy`. The first version simulated them on
  both, which an audit caught: on a narrow range it could bench a pool for a day over a
  transaction the engine would never build, while still being blind to the fused one it
  does. The narrow path therefore has nothing to rehearse, and `openLivePosition` says
  so in as many words rather than logging a clean rehearsal that checked nothing. Its
  protection is the compute-budget fix — the SDK simulates that fused transaction
  itself, which `onchainExecutor.test.ts` asserts. **Under `LIVE_MAX_POSITION_BINS=70`
  that means the rehearsal simulates nothing on EVERY entry** — see "What the
  narrow-only cap silently switched off" above, which is also where the log line that
  claimed "all bin arrays exist" on that path was corrected.
- **It cannot cover the liquidity phase.** That deposits the paired token, and the
  wallet does not hold it until the swap this gate runs before. Simulating it here would
  fail for lack of funds on *every* pool — a false alarm, not a check.
- **It fails OPEN on an RPC error.** A simulation that could not RUN is not evidence the
  open would fail. Failing closed on a provider hiccup would stop all trading for a
  reason that has nothing to do with the pool — the same reasoning `assessPoolCooldown`
  uses, and the opposite of `screenTokenSafety`, because the capital is protected by the
  gates that do fail closed.

**The rehearsal cannot see OUR OWN spend ceiling**, because it simulates against the
cluster and the cluster knows nothing about `ONCHAIN_MAX_LAMPORTS_PER_TX`. That gap was
real: every `assertWithinSpendLimit` covering rent lives inside
`dlmmExecutor.openPosition`, which runs AFTER the swap, so a wide position whose
`deposit + position rent + bin-array rent` breached the ceiling failed with the swap
already spent. The affordability gate now checks it before the swap, against the worst
single transaction each path actually sends — the narrow path's sum, the wide path's
larger half — rather than their total, which would refuse wide positions the executor
would have accepted. `describeLiveExecutionBlockers` was worse than silent about this:
it told the operator to set the ceiling EQUAL to `LIVE_MAX_POSITION_SOL`, which
guarantees the failure. It now requires `maxPosition + rentBudget`.

### The execution breaker: the V1.1 lockout is blind to failed opens, by construction

Two rules that are each correct meet in a hole. `liveExecution.ts` writes **no position
row until the open confirms** — right, because a row describing a position that does not
exist would be valued, accrued and eventually "closed", all of it about nothing. And
`assessPoolCooldown` reads `PoolExitRecord`, reconstructed from **closed position rows**,
counting consecutive failed EXITS. A failed OPEN therefore leaves no trace any anti-churn
gate can see, so the same pool was re-elected every 30 minutes on 7 Sep and spent real
money twice before an operator added a denylist entry by hand.

`src/services/executionGuard.ts` is the missing half. Cooldown measures how a pool
**traded**; this measures whether it can be **entered**. They must stay separate:

- Separate storage (`pool_execution_failures`), separate thresholds
  (`EXECUTION_FAILURE_LOCKOUT_COUNT` / `_HOURS`, default 2 → 24h). Nothing in
  `executionGuard.ts` may read a V1.1 guardrail, and there is a test for that — two
  copies of a guardrail means "V1.1" would name two configurations.
- **Merging them would also change the V1.1 baseline**, which is a change to the official
  configuration and needs its own justification. `meteora.ts` must never import the
  execution history: the lockout's meaning would change silently while
  `v11Baseline.test.ts` still passed, because none of the six numbers would have moved.
- **Inert in paper mode.** The candidate filter sits inside `isLiveExecutionActive()`, so
  a dry run's candidate list is byte-identical to what it was before. Same discipline as
  `defaultBacktestConfig()`.
- **Fails open** (unparseable timestamp expires the bench, no history never blocks), for
  the same reason `assessPoolCooldown` does.

**ONE expensive failure benches; free ones are counted to the limit.** The first version
weighted them equally at 2, and an audit caught that this made the gate miss its own
founding case: on 7 Sep one pool cost money EXACTLY TWICE, so a flat limit of two would
not have benched it until after the second loss. A post-swap failure means the balancing
swap confirmed and the SOL is gone — that is not a data point awaiting confirmation, it
is the outcome being prevented. A pre-swap rehearsal refusal costs nothing and can be
transient cluster state, so it still gets `EXECUTION_FAILURE_LOCKOUT_COUNT` looks.
`classifyFailureStage` treats an UNRECOGNISED stage as the expensive one, because an
unknown failure is likelier to be a new post-swap path than a new free one.

Rehearsal refusals are counted at all — despite spending nothing — because the cost
there is the entry slot: `seekNewEntry` acts on the single pool the LLM selects and
returns as soon as that pool is refused, so a pool the chain will always reject would
otherwise consume every cycle it is elected in while the engine reports itself healthy.
Filtering happens **before the LLM sees the list**, not only at execution time, so the
model can pick something else.

**A WALLET-level refusal is not a POOL fact.** A simulation that fails for want of
lamports would fail identically on every pool, so counting it would let one wallet-level
condition bench the universe a pool at a time, 24 hours each — a self-inflicted outage
that a top-up fixes. `isPoolAttributable` reads the cluster's own error and logs; the
open is still refused, only the strike is withheld. It defaults to "the pool's fault",
because wrongly benching one pool costs a missed entry while wrongly clearing a broken
one costs the repeat loss.

`total_failures` is deliberately not reset on success — it is how an operator tells
"flaky once" from "fails most of the time", and a gate that erases its own evidence
cannot support that judgement.

### Bin-array rent is NOT recovered, and this file used to say it was

"Raising `LIVE_CAPITAL_SOL` buys rent headroom, and rent is recovered when the position
closes" is true of the POSITION account and false of BIN ARRAYS. Bin arrays are
pool-level accounts shared by every LP; `close_bin_array` exists in the IDL, but the SDK
exposes no wrapper and **nothing in this repository can reclaim it**. At the deployed
envelope the rent budget is 1.10 SOL, so a fresh pool can absorb up to ~15 arrays ×
0.0714 SOL of permanently spent rent on a 1.8 SOL position.

**The friction gates now see this, and where they see it matters.** They used to price
gas and slippage only, so the affordability gate asked "can I afford it" and nothing
asked "is it worth it". The screening gates still do NOT charge it by default
(`LIVE_ENTRY_RENT_SOL=0`): at screening time nobody knows whether the pool needs a new
array, and charging one to every candidate moves the binding bar from 7.50% to 29.82%
fee/TVL, refusing the universe over a cost most candidates never incur. Enforcement lives
in `openLivePosition` instead, against the CHAIN’s own array count for that range and
bounded by `LIVE_MAX_RENT_TO_PNL`. See "Reporting and reconciliation fixes" above.
`preCreateMissingBinArrays` still logs the SOL it spends on arrays.

### The Jupiter swap was breaking the double-spend rule, silently

`sendAndConfirm`'s safety argument is that a transaction carries the blockhash the loop
is tracking, so "expired" means the old signature can never land and rebuilding is safe.
Every DLMM builder takes that blockhash. **The Jupiter swap did not**: Jupiter builds the
transaction server-side and stamps its own, necessarily younger, blockhash, while
`confirmTransaction` was still handed OURS.

The consequence is the exact failure the rule exists to prevent. Ours expires first, so
the loop declares expiry and rebuilds with a fresh quote while Jupiter's transaction is
still landable for the slots by which its blockhash is younger — and both can land. The
window is a slot or two of a ~60s validity, and it is on the balancing swap, which runs
on **every live entry**.

`buildJupiterSwap` now re-pins `message.recentBlockhash` BEFORE signing. The order is
load-bearing: the signature covers the message, so re-pinning after signing would produce
bytes the cluster rejects — a change that reviews as correct and fails every swap. A
source-level test asserts every `sendAndConfirm` builder destructures `blockhash`,
because the rule is about future builders too; both tests were confirmed to FAIL against
the pre-fix code rather than merely passing against the new one.

### Failure reporting: "outcome unknown" now means something

`sendAndConfirm` warns that a transaction's outcome is unknown and the operator must
check the signature before retrying — the warning that prevents a manual double spend. It
was firing on **preflight rejections**, which are the one non-expiry failure whose outcome
is not in doubt: the RPC simulated the transaction and refused to broadcast it, so nothing
entered the network. Reporting that as ambiguous sent the operator to look for a
transaction that provably never existed, and hid the diagnosis — the cluster's simulation
logs name the reason, and for 7 Sep they said the compute meter was exhausted.
`TransactionFailedError` now carries `deterministic` and `logs`, and the ambiguity warning
is reserved for genuinely ambiguous failures.

### `POOL_DENYLIST` is a setting, not a `process.env` read

It first shipped reading `process.env` at the call site and throwing a
`BinWidthExceededError` with a width of 0, which logged "needs 0 bins, over the operator
POOL_DENYLIST" — a line that reads months later as a width bug, and made an operator
decision indistinguishable from a program limit in the funnel. It now lives in
`env.ts` (parsed once, placeholder-aware, printed at boot by `describeExecutionGuard()`)
and has its own `PoolDeniedError`. A safety gate that is silently empty because of a typo
is worse than no gate, because it is believed.

`LiveEntryRefusedError` is the base class for every pre-swap refusal — width, rent,
denylist, breaker, rehearsal — and `seekNewEntry` catches THAT, not one subclass. It used
to catch `BinWidthExceededError` specifically, so any new refusal would have fallen
through and paged the operator for a pool the engine had merely declined to enter.

### `scripts/closeOrphanPosition.cjs` is dry-run by default

Same shape as `scripts/testMicroSwap.ts`, and not decoration: it loads a private key and
signs, it is run by hand under time pressure after something has already gone wrong, and
it is kept as **the template**, so its defaults propagate. A dry run needs no key on the
box — it inspects the position from `SOLANA_WALLET_ADDRESS` or `--owner` — and it refuses
a position that still holds liquidity, because `closePosition` does not withdraw.

## Commands

```bash
npm run dev              # orchestrator: cron schedulers + REST API on :4000
npm run api              # REST API only, no schedulers
npm run dashboard:dev    # Next.js dashboard on :3000 (separate npm project in dashboard/)
npm run build            # tsc -> dist/, then copies schema.sql via src/scripts/copyAssets.mjs
npm run typecheck

npm test                                                # node --test over src/tests
node --import tsx --test src/tests/math.test.ts         # single file
node --import tsx --test --test-name-pattern "impermanent" src/tests/math.test.ts

npm run test:local       # 5-stage pre-deploy smoke test (temp DB, live upstreams)
npm run research         # inefficiency research: failure clusters + score + out-of-sample
npm run sweep            # grid-search the ENTRY guardrails against the cached dataset
npm run sweep:exits      # grid-search TAKE_PROFIT_PCT / STOP_LOSS_PCT, split in/out-of-sample
npm run audit:report     # backtest JSON -> reports/backtest-audit.html (print to PDF)
npm run backtest         # 30-day replay of the live formula; --days --pools --refresh --tp etc.
npm run backtest:annual  # 365-day replay of the LIVE V1.1 guardrails + daily returns export
npm run backtest:quote   # SOL-quoted vs USDC-quoted pools, same window/rules; --ingest-only=sol|usdc
npm run report:quant     # Python: QuantStats-style tear sheet (HTML + PDF + PNG) from that export
npm run dlmm:once        # one screen -> decide -> monitor cycle (monitor included)
npm run research:once    # one macro research run
npm run smoke            # probe every external API, print screener output + rejection counts
npm run seed:demo        # demo positions marked [DEMO]; npm run db:reset clears everything
```

`npm run report:quant` needs Python with `pandas numpy matplotlib scipy quantstats`
(`python -m pip install pandas matplotlib quantstats`). It reads only the CSV the Node
runner writes, so the backtest itself has no Python dependency. The PDF is printed from
the generated HTML by whichever of Chrome or Edge is already installed; a missing browser
degrades to a warning, never a failed run.

`npm install` on npm 11+ blocks native install scripts. After installing, run
`npm approve-scripts better-sqlite3 esbuild` or `better-sqlite3` won't build and `tsx` won't run.

Dashboard commands must run inside `dashboard/` (or via the `dashboard:*` root scripts) — it has
its own `package.json`, `node_modules`, and its own git repo created by `create-next-app`.

## Architecture

Data flows one way: **external APIs → agents → SQLite → REST API → dashboard**. The dashboard is a
read-only view and holds no trading logic.

- `src/config/env.ts` — Zod-validated env, parsed once at import. Placeholder values matching
  `/^(your_|<|changeme|...)/` count as unset, so a stale `.env.example` value doesn't read as
  configured. **`DRY_RUN=false` is supported and means REAL MONEY.** Boot now fails only on a
  HALF-armed configuration: `DRY_RUN=false` without `ONCHAIN_EXECUTION_ARMED=true`, or without
  `SOLANA_PRIVATE_KEY`. Same reasoning the blanket refusal had — an engine that believes it
  trades live while nothing can sign would decide entries and fail every execution.
- `src/database/repositories.ts` — every SQL statement in the project. Agents and the API share it;
  don't write queries elsewhere.
- `src/database/db.ts` — `initDatabase()` applies `schema.sql` then runs `addColumnIfMissing`
  migrations. Add new columns there, not by editing `schema.sql` alone, or existing databases break.
- `scan_funnel_cycles` — one row per screener cycle: scanned, the `screenPools` rejection bucket
  map as JSON, then cooldown / anti-rug / volatility / coverage / micro, the skip reason and the
  duration. Written by `recordFunnel`, served read-only by `GET /api/funnel`, and it exists
  because the funnel used to be reconstructible only by parsing PM2 stdout — and its most
  important step was not in the log at all, since `screenPools` computed those buckets and
  `seekNewEntry` threw them away. `scanned` is NULL, never 0, when the cycle never reached the
  screener (paused, or at capacity): "not measured" and "measured zero" are different facts, the
  same rule `est_gas_cost_usd` follows. Recording it can never fail a trading cycle — the write
  is wrapped and nothing reads it back.
- `src/services/meteora.ts` — pool fetching, screening, and **all position maths** (IL, fee accrual,
  valuation). The agent orchestrates; the maths lives here and is unit-tested.
- `src/services/solana.ts` — JSON-RPC helper: priority-fee estimation, mint/freeze authority,
  holder concentration, and `getWalletBalanceSol` (PUBLIC address only). Method availability
  differs by provider (see below).
- `src/config/liveConfig.ts` — the 1 SOL live micro-capital profile: capital, sizing against free
  capital, the reserve, and the absolute-dollar friction floor. Inert unless armed.
- `src/services/livePreflight.ts` — the startup gas-reserve gate. Runs before the database, the
  API and every scheduler, so a refusal leaves nothing half-started. Inert unless armed.
- `src/services/onchainExecutor.ts` — STAGE 1 on-chain execution: wallet loading, signing,
  dynamic priority fees, send/confirm, Jupiter swaps. **Not imported by the engine, and a test
  enforces that.** Armed by its own switch, exercised only via `scripts/testMicroSwap.ts`.
- `src/services/metrics.ts` — max drawdown and profit factor as pure functions over an ordered PnL
  array, so they are testable without a database.
- `src/services/http.ts` — `getJson` retries 429/5xx and fails fast on 4xx; `getJsonSafe` never
  throws, so one dead upstream can't abort a whole cycle.
- `src/index.ts` — cron schedulers wrapped in `withLock`. Two position-facing clocks: the 60s fast
  monitor (`CRON.FAST_MONITOR`) marks open positions and fires exits; the 30m screener
  (`CRON.DLMM_LOOP`) does the 600-pool scan and the DeepSeek entry decision, and skips its own
  monitor stage while the fast monitor is enabled. `withLock` only stops a job overlapping itself —
  cross-job safety is `positionMutex` in `src/services/mutex.ts`. Overlapping ticks would
  double-accrue fees on the same interval; keep both locks.

## Correctness constraints

These are the places where a plausible-looking change silently corrupts the numbers the user trusts.

**Fee/TVL units.** Upstream `fee_tvl_ratio.24h` is in *percent* (`0.4877` = 0.4877%);
`MIN_FEE_TVL_RATIO=0.008` is a *ratio*. `meteora.ts` computes `fees.24h / tvl` itself and never uses
the upstream field. Do not "simplify" to the API field.

**Zero-TVL pools.** Upstream is full of `tvl: 0` rows; dividing by them yields ratios in the
billions. `toDomain` guards this, and `MAX_FEE_TVL_RATIO` rejects the survivors. Sorting upstream by
`fee_tvl_ratio_24h:desc` returns pure garbage — sort by `volume_24h:desc` and filter locally.

**Position notional is fixed at entry** (`virtualSol × entrySolPriceUsd`). Fee accrual quotes
against it deliberately: IL is a separate term, so re-marking the notional double-counts the price
move.

**Fee model is a conservative lower bound.** Pool-level `fee × (hours/24)`, no concentration
multiplier, zero while out of range. Don't present it as a real yield estimate.

**No fabricated market data.** ETF flows have no keyless source (Farside returns 403); DXY/10Y/S&P
need an optional `FRED_API_KEY`. Missing metrics stay `null` and are listed to the LLM as
`UNAVAILABLE` with an explicit instruction not to invent them. Keep that contract when adding
sources.

**DeepSeek only** (`deepseek-chat` / `deepseek-reasoner`) through the `openai` SDK with a rewritten
`baseURL`. Not OpenAI, not Anthropic. `deepseek-reasoner` rejects a `temperature` override.

**The anti-rug screen fails closed.** `screenTokenSafety` returns `UNKNOWN` — never `PASS` — when a
check could not run, and `acceptsSafetyVerdict` rejects `UNKNOWN` unless `ANTIRUG_ON_ERROR=allow`.
The public Solana RPC blocks `getTokenLargestAccounts` (HTTP 429), so on the default endpoint every
candidate is rejected and nothing ever opens. That is correct behaviour; do not "fix" it by
defaulting `UNKNOWN` to pass. A definitive `FAIL` must stay unoverridable by the error policy.

**CLOSED_MANUAL is invisible to the anti-churn gates.** `COOLDOWN_STATUSES` excludes it,
so a Telegram `/close_all` neither starts a cooldown, nor trips the lockout, nor clears a
failure run. Benching every pool after an operator flattens the book would silently stop
trading for hours at the moment they most likely want it back; and letting a manual close
reset the run would let the operator un-arm a breaker two genuine failures had earned. The
breaker measures the pool, not the operator. `CLOSED_STATUSES` still includes it — that
list answers "is this position finished", which is a different question.

**Three-state booleans.** `mint_authority_revoked` / `freeze_authority_revoked` are stored as
1 / 0 / **null**, where null means the check never ran. Collapsing null to false would claim an
authority is live when it was simply never checked. The same rule governs `est_gas_cost_usd`: null
when the estimate was unavailable, never 0.

**Gas is recorded, not deducted.** `realized_pnl_usd` remains fees + IL. Folding gas in would
silently redefine every historical PnL figure.

**Backtest units.** `BacktestTrade.entryPrice`/`exitPrice` are USD; `entryRatio`/`exitRatio` and
`lowerBinPrice`/`upperBinPrice` are quote-denominated (divided by SOL/USD for SOL-quoted pools).
Comparing a bin bound against a USD price is a unit error — `pairRatio()` exists to keep them
apart, and there is a test asserting the bounds bracket the ratio, not the USD price.

**Two different loss numbers, do not confuse them.** `impermanentLossFraction(r)` is divergence
vs holding; `lpValueReturnFraction(r)` = `sqrt(r) - 1` is what happened to the capital. A halving
reads -5.7% vs -29.3%. Both the backtest and the live engine now drive PnL from the latter:
`valuePosition` returns `positionValueChangeUsd` (PnL) and `divergenceVsHoldUsd` (diagnostic), and
`realized_pnl_usd = fees + positionValueChange`. The DB keeps `impermanent_loss_usd` as the
divergence column and adds `position_value_change_usd`; rows written before that migration used the
old, understated definition.

**Friction gates exist because the strategy churned itself into a loss.** `computeBinRange` floors
the range at `MIN_DOWNSIDE_COVER_PCT` / `MIN_UPSIDE_COVER_PCT`, and `assessBreakeven` rejects any
pool whose 24h fee estimate is under `MIN_FEE_COST_COVERAGE` times the round-trip gas+slippage
cost. When the gas estimate is unavailable the gate assumes a conservative cost rather than zero —
treating the trip as free is what allowed the churn.

**The backtest's survivorship control must not be quietly broken.** `universe.ts` deliberately
includes pools that are dead today (Meteora's listing is unpruned, ~123k pools, dead ones just sit
far down a volume sort). Two things silently reinstate the bias if "simplified":
  - Filtering `MIN_TVL_USD` against the *current* TVL snapshot — a rugged pool reads ~$0 today, so
    every dead pool would be rejected. Filters run against `tvlModel.estimateTvlAt`, not the
    snapshot.
  - Ingesting only the survivor cohort. If the dead cohort ends up empty the runner warns that the
    comparison proves nothing; do not suppress that warning.
  - Sampling the survivor cohort straight off the volume leaderboard. Solana's volume leaders are
    SOL-USDC-scale pools modelling to $0.4M-$9M of TVL, every one of which `MAX_TVL_USD` rejects,
    so the survivor arm made ZERO trades and 100% of the unbiased run's trades landed on dying
    pools — a selection artefact that reads exactly like a strategy result. `buildPointInTimeUniverse`
    takes `survivorTvlBand` and `runMicroCapital.ts` passes the live `MIN_TVL_USD`/`MAX_TVL_USD`, so
    survivors are pools the strategy would actually consider. Applying a *current* TVL band is safe
    for survivors specifically — they are alive today by definition — and remains forbidden for the
    dead cohort, which still selects on lifetime volume and modelled TVL.

**A run whose trades all come from one cohort is an artefact, not a result.** `runMicroCapital.ts`
prints the cohort composition of its trades and warns when they concentrate in a single cohort.
That warning is how the survivor-sampling bug above was caught; do not suppress it.

**The backtest's V1.1 guardrails default to OFF, and that is deliberate.** `maxTvlUsd`,
`minPoolAgeHours`, `maxPriceSurge1hPct`, `poolCooldownHours`, `lockoutConsecutiveFailures` and
`lockoutHours` default to Infinity/0 in `defaultBacktestConfig()` so that `npm run backtest`,
`npm run sweep`, `sweep:entry` and `sweep:exits` produce byte-identical output to before they
existed — the same pattern `takeProfitNetPct` already used. `npm run backtest:micro` switches them
on by reading `src/config/env.ts` directly, so the harness cannot drift from the engine it claims
to measure. Adding a gate to the engine without an inert default silently rewrites every historical
sweep result.

**The pool-age gate is evaluated at the simulated bar, not against the pool's age today.** A pool
that is 200 days old now was three hours old in June. Using today's age would wave through exactly
the launches `MIN_POOL_AGE_HOURS` exists to refuse. `PoolHistory.createdAtMs` carries the on-chain
creation time for that reason, and an unknown creation time is REJECTED, mirroring the live
screener's `ageUnknown` bucket.

**Concurrent positions must be sized against free capital, not equity.** `equityUsd` only steps on
a close, so sizing three concurrent positions at `equity x positionSizePct` would deploy the same
dollars three times over — invisible leverage that flatters every result. The engine subtracts open
notional before sizing. With `maxConcurrentPositions = 1` nothing is open at that point, so
single-position runs are unaffected.

**Free historical OHLCV stops at about 208 days, so "1-year backtest" needs a key.**
Measured against the live endpoint on 2026-09-01: GeckoTerminal's keyless tier yields about
4,996 hourly bars per pool (~208 days, back to early February 2026) and answers **HTTP 401**
on every deeper `before_timestamp`.
That 401 is a plan boundary, not an auth fault — the same request without
`before_timestamp` succeeds. Daily aggregation is capped at the same depth, so switching
timeframe buys no history. `fetchHourlyBars` therefore classifies 401/403 as
`HistoryDepthLimitError` and, when it already holds bars, stops paginating and keeps them;
a refusal on the FIRST page still propagates, because nothing was granted at all. Losing a
whole pool over a known plan limit would thin the universe for no reason. `runAnnual.ts`
compares requested against achieved days and warns in the header, the terminal and the
caveats when they differ — do not remove that warning, or a 208-day result gets quoted as
an annual one. `COINGECKO_PRO_API_KEY` switches the base URL to CoinGecko Pro's `/onchain`
routes for the full year; that path is the documented request shape and has NOT been
exercised here, because no key is configured.

**Modelled TVL is the load-bearing assumption of the whole harness.** No free provider serves
historical TVL. `tvlModel.ts` fits `k = TVL/volume24h` on the live cross-section and applies
`TVL_t = k x volume24h_t`. The fit is loose (report prints the IQR). Never present backtest output
without it.

**Forward bars are a microstructure check, not a signal.** `assessLiquidation` looks ahead only to
decide whether an exit was fillable at all. Using forward bars to inform an entry or exit decision
would be look-ahead bias in the strategy itself.

**The smoke test must never touch the real database.** `scripts/test-local.ts` sets
`DATABASE_PATH` to a temp dir before any dynamic import, because `src/config/env.ts` parses on
load. Keep every import in that file dynamic (or type-only) or the override silently stops working
and the test writes into `./data/flowmetrix.db`.

**The smoke test must exit by draining, not by `process.exit()`.** Node's global `fetch` leaves
keep-alive sockets in undici's pool, including the Stage 4 calls against our own Fastify instance.
Those sockets hold `server.close()` open, so the harness used to force the exit — and exiting on
top of a half-closed TCP handle trips a libuv assertion on Windows
(`!(handle->flags & UV_HANDLE_CLOSING)`, win/async.c). The run printed `RESULT: PASS` and still
returned exit code 127, which makes the smoke test useless as a deploy gate. `closeHttpPool()`
drains the pool, the loop empties, and `process.exitCode` carries the verdict. The 10s unref'd
timer is a hang guard, not the normal path; if it ever fires, something new leaked a handle.

**The RPC health probe is a status widget, not a monitor, and must not become either a
leak or a rate limiter.** `/api/health` reports `solanaRpc` from a `getSlot` probe in
`solana.ts`. Three things there are load-bearing. It publishes `new URL(SOLANA_RPC_URL).host`
and nothing else, because that URL carries the provider API key in its query on Helius and
the payload is served to a browser. An endpoint that never answered reports `latencyMs:
null`, never 0 — and the dashboard guards it with `typeof v === "number"`, because
`Number(null)` is 0 and passes `Number.isFinite`, which rendered as "healthy 0ms". And the
reading is cached for `RPC_PROBE_TTL_MS` and single-flighted: the dashboard polls that route
once a minute PER OPEN TAB, so a probe per request would make the widget generate the 429s
it then reports. `getSlot` rather than `getHealth` because a provider that does not expose
`getHealth` answers with an error indistinguishable from an unhealthy node. Only the first
read after boot waits on the network, and a probe that throws still yields a reading — a
liveness route that 500s because a third party threw announces the wrong outage.

**The anti-churn gate fails OPEN, unlike every safety gate.** `assessPoolCooldown` treats an
unparseable timestamp as an expired bench, not an indefinite ban, and a pool with no history is
never blocked. That is the opposite of `screenTokenSafety`, and deliberate: cooldown protects
returns, the anti-rug screen protects capital, and a broken clock must not silently freeze the
screener. Do not "make it consistent" with the fail-closed rule.

**Stored timestamps are UTC without a zone marker.** SQLite `CURRENT_TIMESTAMP` writes
`YYYY-MM-DD HH:MM:SS`, which `new Date()` reads as local time — 7 hours out on an Asia/Jakarta
box, enough for a 4-hour cooldown to expire before it started. Parse stored timestamps through
`parseDbTimestamp` in `meteora.ts`; the cooldown gate and the position monitor share it so they
cannot drift apart on the interpretation.

**Every write to `simulated_positions` happens under `positionMutex`.** Three clocks now
mutate positions: the 60s fast monitor, the 30m screener, and Telegram `/close_all`. Fee
accrual is `rate x (now - last_checked_at)`, so two overlapping passes measure from the
same stored timestamp and book the same interval twice; both could also read a row as
ACTIVE and close it independently. The `withLock` wrappers in `index.ts` only stop a cron
job overlapping *itself* — they are not a substitute. The fast monitor uses `tryRun` and
**skips** when contended (the holder is already valuing the same rows against fresher
prices); `/close_all` and the entry write use `run` and queue, because those must happen.

**The fast monitor must price from Meteora, not DexScreener.** `entry_price`,
`lower_bin_price` and `upper_bin_price` are all persisted from `DlmmPool.currentPrice`.
Marking a position against a differently-derived price — DexScreener's `priceUsd`, or a
`priceNative` computed off another reserve pair — compares two different quantities and
can fire a stop-loss or an out-of-range exit on a unit mismatch instead of a real move.
`fetchPoolsByAddresses` exists to make the same-source read cheap, not to add a source.

**The loss-history block is evidence, not decoration.** `summariseLossHistory`
reconstructs each past range from the stored bin prices, which is the range the position
actually ran after `computeBinRange` applied its floors — quoting what the model
originally asked for would teach it from a range that never existed. Failures without a
written post-mortem are excluded rather than padded, and an empty history is stated as
`RECENT LOSSES: UNAVAILABLE`. Same contract as the macro metrics: absent data is named,
never invented. The adaptive widening the prompt permits is bounded by
`MIN_DOWNSIDE_COVER_PCT` / `MIN_UPSIDE_COVER_PCT`, which `computeBinRange` still clamps.

**Cohort membership is `opened_at`, and filtered equity is rebased.** The dashboard's
Session/Cohort filter splits history at `ENGINE_V11_CUTOFF`. It filters on `opened_at`
because the cohort names the engine that made the ENTRY decision — switching it to
`closed_at` would file a v1.0 position under v1.1 merely because it closed late. In a
filtered cohort `currentBalanceUSD` / `currentEquityUSD` / drawdown restart from
`STARTING_BALANCE_USD`, so they are a hypothetical ("this engine from a standing start"),
not the account. `computeOverview` therefore returns `cohort.filtered`, `excludedTrades`
and `excludedRealizedPnLUSD`, and the UI must keep showing them; a rebased figure with no
label is a fabricated balance. The API default is `all` — never make it `current`, or an
unparameterised caller silently gets a subset. An unknown `?cohort=` is a 400, not a
fallback.

**The cutoff is a deploy time, not a date.** `ENGINE_V11_CUTOFF` defaults to the v1.1
commit (2026-08-29T13:20:40Z) rather than midnight that day, because 13 of the 27 legacy
trades were opened that same morning up to 12:40Z. A date-only cutoff files pre-fix trades
as clean. Committed-but-not-restarted code has produced no trades, so the operator must
move the cutoff to the actual restart.

**The backtest has TWO take-profits and they measure different things.**
`takeProfitFeePct` fires on accumulated FEES as a percentage of notional;
`takeProfitNetPct` fires on NET PnL (fees + LP value change) and is the one that mirrors
`evaluateExit`'s `TAKE_PROFIT_PCT` in the live agent. `takeProfitNetPct` defaults to
Infinity so it is off unless a caller asks for it, which is why adding it changed no
existing backtest output. Tuning `takeProfitFeePct` and then copying the winner into
`TAKE_PROFIT_PCT` would be setting a live threshold from a simulation of a different
quantity — `npm run sweep:exits` disables the fee rule for exactly that reason.

**TAKE_PROFIT_PCT / STOP_LOSS_PCT were measured and deliberately left alone.** The live
config risks 8% to make 5% — a structural payoff ceiling of 0.63 — and the dry run showed
avg win $8.76 against avg loss $10.88. `npm run sweep:exits` grid-searched all 64
combinations with an in/out-of-sample split: payoff > 1 is reachable only by tightening
the stop to -5%/-6% and disabling the take-profit, and every such setting is WORSE
out-of-sample than the current one. No combination has positive expectancy in both
halves; with `--live-entry` the out-of-sample profit factor is 0.00. Do not "fix the
ratio" by moving these numbers — that is fitting to noise. Re-run the sweep before
proposing a change, and read the entry rule as the suspect.

**Nothing that does I/O may hold `positionMutex`.** `sendPositionClosed` and
`reflectOnPosition` are queued as `DeferredCloseWork` and settled by
`settleClosedPositions` AFTER the lock is released. Awaiting them inside the pass — as the
code originally did — blocks the 60-second monitor for as long as a DeepSeek call takes,
silently voiding the exit-timing guarantee the fast monitor exists to provide. Keep new
work out of the locked section unless it is a local DB write.

**Query-string numbers go through `intParam`.** `Number("1e999")` is Infinity and
`Number("1.5")` is a float; better-sqlite3 rejects both and the throw surfaced as a bare
HTTP 500. `Math.max(Number(x) || d, 0)` only guards NaN — it is not enough.

**SOL/USD is a chain, and the chain validates.** `fetchSolPriceUsd` walks
`SOL_PRICE_SOURCES` (CoinGecko, then Jupiter, then a DexScreener SOL/USDC pool) and
re-applies `usableSolPrice` to whatever each one returns. Do not move that check back
inside the sources: a future source that forgot it would feed 0 or NaN into position
sizing, and notional is fixed at entry, so a bad quote is baked into that trade's PnL
permanently. All sources failing still returns null — fallbacks reduce how often the
engine cannot size a position; they never license inventing a price. BTC/ETH have no
fallback on purpose: nothing sizes a position from them.

**Fee accrual is capped to time the engine actually observed.** Fees are
`rate x (now - last_checked_at)`, so after downtime that interval is the whole outage.
`valuateAtPrice` clamps it to `MAX_FEE_ACCRUAL_GAP_HOURS` (default 1h) and warns when it
does. Removing the clamp would credit days of fees on the first tick after a restart,
justified by a single in-range check of a period nothing watched — three stale positions
were worth $3.45-$13.80 of phantom fees against a dry run whose total realised PnL was
-$25.46. Unobserved time is not evidence of earning; same fail-closed rule as the
anti-rug and volatility gates.

**The annual tear sheet's daily returns are REALISED-ONLY.** `buildDailyCurve` steps
equity on a trade's EXIT day and never on open floating PnL, matching `computeMaxDrawdown`
and keeping the curve reproducible from the trade log alone. The consequence is that a day
with no close is a genuine 0.00%, not missing data — which deflates daily volatility and so
FLATTERS every daily-sampled ratio (Sharpe, Sortino, Ulcer). With roughly 5-10% of days
active, those ratios are indicative only; the trade-level statistics are the primary
evidence. `activeDays` is reported next to them for exactly that reason, and the day key is
built from UTC components so a local-clock box cannot slide a close into the wrong day,
month or year. Do not "improve" the curve by adding floating PnL.

**The live micro-capital profile is inert by default, and that is the whole point.**
`src/config/liveConfig.ts` holds the 1.15 SOL live envelope (0.80 SOL x 1 position, 0.15 SOL
reserve, 0.008 SOL round-trip gas floor, $1.50 net-PnL floor, 0.20 SOL startup gate). The
capital base is 1.15 rather than 1.00 because a live open pays RENT before it deposits
anything — 0.0574 SOL for the position account, 0.0714 per uninitialised bin array, 0.0020 for
the paired token's ATA — so the 0.20 SOL between exposure and deployable is rent headroom, not
spare capital.

Every one of those values is gated behind `LIVE_MICRO_CAPITAL`, which defaults to **false**. With the flag
off, `seekNewEntry` sizes from `VIRTUAL_SOL_PER_POSITION` exactly as before, the micro friction
block does not run, `runLivePreflight` returns `skipped` without touching the network, and the
candidate list reaching the LLM is byte-identical to the pre-profile engine. Same reasoning as
`defaultBacktestConfig()`: a live-capital rule that switched itself on would silently rewrite
every dry run and every sweep result. **Do not "activate" these defaults to make the code look
used, and do not delete them as dead code — they are neither.**

Four properties inside it are load-bearing:

- **Sizing runs off FREE capital**, `capital - reserve - open notional`, never off the capital
  base. Sizing three concurrent positions at `capital x pct` deploys the same SOL three times
  over. In the backtest that only flatters a number; on a real 1 SOL wallet it is an overdraft.
- **The reserve is unreachable by construction, not by clamping.** `parseLiveConfig` REFUSES a
  profile where `maxPosition x concurrent` could reach the reserve, and prints the arithmetic.
  A runtime clamp would truncate the last position silently and nobody would read the log.
- **`LIVE_ROUND_TRIP_GAS_SOL` is a FLOOR, not a fallback.** The live p75 estimate is used only
  when it is *higher*; a missing estimate is priced at the floor, never at zero. Treating a
  round trip as free is the documented mechanism by which this strategy churned itself into a
  loss, and at micro notional there is no margin to absorb the error.
- **The preflight fails CLOSED.** A balance that could not be READ is treated exactly like a
  balance that is too low — "the RPC was down" is not evidence of solvency. Same rule as
  `screenTokenSafety`, and deliberately the opposite of `assessPoolCooldown`, which fails open
  because it only protects returns. A failed Telegram dispatch never converts the refusal into
  a start.

**The micro-capital dollar floor is ADDITIVE to the V1.1 ratio gate, never a replacement.**
`assessBreakeven` (2.5x `MIN_FEE_COST_COVERAGE`) is scale-free and stays satisfiable at any
notional; `assessMicroCapitalFriction` asks the second question, "is the projected result large
enough to be worth the trip at all". A candidate must clear BOTH, and `v11Baseline.test.ts`
asserts the micro gate still runs *after* the ratio gate in `seekNewEntry` — reordering them, or
making one an alternative path, would let a $2 net win through on 1.1x coverage. Nothing in
`liveConfig.ts` may redeclare a V1.1 guardrail (cooldown, lockout, coverage, the clocks, the 16k
cap); there is a test for that too, because two copies of a guardrail means "V1.1" would name two
different configurations depending on a flag.

**TWO gates set the entry bar, and which one BINDS flips with position size — always report the
stricter.** At $80 notional (0.80 SOL) the $1.50 floor needs 4.88% fee/TVL while the V1.1 2.5x
coverage gate needs 7.50%; a pool must clear both, so the real bar is 7.50%. (At the earlier
0.50 SOL it was 6.6% against 9.0%.)
Shrink the position and the dollar floor overtakes the ratio. `effectiveFeeRequirement` returns
both plus `bindingGate`, and `describeLiveEnvelope` prints all three at boot. **Do not go back to
quoting `requiredFeeTvlRatio24h` alone** — it answers only what the dollar floor demands, so
whenever coverage is stricter it advertises a bar lower than the screener actually enforces, and
the operator reads the resulting rejections as a broken screener rather than a working gate.

**Both gates charge ONE gas basis, and that is what makes the paragraph above true.** It was not
true for the first 67h of live-profile dry running. `requiredFeeTvlRatioForCoverage` prices gas
at the 0.008 SOL floor to print "coverage needs 9.00%" at boot, but the runtime call site handed
`assessBreakeven` the live priority fee instead (~$0.003 against a ~$0.81 floor) — so the
enforced coverage bar was 5.1%, not 9.00%, and the binding gate was really the $1.50 floor at
6.6%. The tell is in `reports/DRY_RUN_72H_REPORT.md`: **52 pools cleared coverage and then failed
the dollar floor**, which cannot happen if coverage binds at 9%. This is the same class of defect
the paragraph above warns about, pointing the other way — a bar advertised HIGHER than enforced.
`chargeRoundTripGasUsd` in `liveConfig.ts` is now the single implementation, used by
`assessMicroCapitalFriction` and by the coverage gate's call site, and both gates are handed the
identical figure. Do not give either gate its own copy.

Three properties of that fix are load-bearing:

- **The floor reaches the coverage gate ONLY when the live profile is armed.** With
  `LIVE_MICRO_CAPITAL=false` the pre-profile expression survives byte-for-byte, 0.0035 SOL
  fallback included. A live-capital cost basis leaking into paper mode would silently rewrite
  every dry run and every cached sweep — the same reason `defaultBacktestConfig()` ships inert.
- **The guarantee is one-sided.** `LIVE_ROUND_TRIP_GAS_SOL` is a FLOOR, so a live estimate above
  it makes the gate STRICTER than the boot line advertises, and that is correct — asserting
  equality there would assert that an expensive network is priced as if it were cheap. The test
  asserts the gate is never LOOSER than advertised, and exactly equal wherever the floor applies.
- **`priorityFee.totalUsd` prices ONE transaction.** A round trip is twice it. The micro gate
  used to be handed the one-way figure; harmless only because the floor dominated it ~800x.

The consequence is real and was accepted deliberately: at a true 9.00% bar, the fone-SOL entry
from that run (7.87% fee/TVL) would have been refused. Two of the window's three trades survive
the change. That is the gate doing what it was configured to do, not a regression.

**Raising `LIVE_MAX_POSITION_SOL` is the sanctioned lever, and it was used.** 0.20 SOL x 3 put
the bar at 15% fee/TVL — inside the band this file elsewhere calls yields no position could
actually realise. The same book as one 0.50 SOL position puts it at 9%, with NO guardrail moved:
gas is per transaction and does not shrink with the position, so a larger notional dilutes a
fixed cost, while slippage scales and stays proportional. Three concurrent positions had been
paying three sets of round-trip gas against a third of the notional each. Concurrency is now 1,
matching `defaultBacktestConfig()`. If the bar needs to come down further, raise the position
size again — **do not loosen `MIN_FEE_COST_COVERAGE` or `LIVE_MIN_NET_PNL_USD`**, which buys the
same candidate count by lowering the bar instead of by improving the economics.

**`SOLANA_PRIVATE_KEY` is read only by the env schema, and nothing returns it.** There is
deliberately no accessor for the key: nothing in this repository can sign a transaction, so such
a function would exist purely as a route for the secret to reach a log line — `hasLiveSigningKey()`
answers the only question anyone needs. The balance probe takes `SOLANA_WALLET_ADDRESS` (public)
instead of deriving a pubkey, so it never touches secret material. `liveConfig.test.ts` fails the
build if any file under `src/` outside the env schema references the key, or if an 86-90 character
base58 literal appears anywhere in `src/`.

**Arming the live profile is ONE of three switches, and alone it still trades nothing.**
`LIVE_MICRO_CAPITAL=true` changes SIZING and SCREENING only. Real money additionally needs
`DRY_RUN=false` (the engine should trade for real) and `ONCHAIN_EXECUTION_ARMED=true` (the
executor may sign); `isLiveTradingEnabled` is the AND of the last two, and `env.ts` refuses to
boot on either one alone. With the profile armed but `DRY_RUN=true` the engine still only
rehearses the envelope — which is what it did for the 67h in `reports/DRY_RUN_72H_REPORT.md`.

**`src/services/onchainExecutor.ts` can sign real transactions, and the engine reaches it
through EXACTLY ONE module.** That rule replaced "the engine must never reach it", which live
execution made false by design. The narrowing is the point: `src/services/liveExecution.ts` is
the single edge, so "can this spend money, and under what conditions" has one place to review
instead of a signer reachable from wherever an import was convenient.
`onchainExecutor.test.ts` walks the graph from `src/index.ts`, asserts the bridge is reachable,
then re-walks with the bridge CUT and asserts the signer is not — that second walk is what
makes "and nothing else" a test rather than a claim. The allowlist of files that may import the
executor has four entries; a fifth is the moment to ask whether it should call the bridge
instead.

Two of the three original locks are unchanged, and they are what still hold:

**One documented failure this cannot cover: the live host is not this checkout.** The
`.env` here is paper mode; the deployed profile lives on the box that runs the engine and
this repository cannot read it. So no statement here about what is "deployed" is
verifiable from the repo, and `.env.example` no longer makes one. The boot line
`[guard] execution breaker: ...; operator denylist: ...` is the authority on what is
actually armed — read it after every deploy.

- **Type level.** Every fund-moving function requires an `ExecutionAuthorization`, a branded
  type obtainable only from `authorizeExecution()`. There is no overload without it, so
  "did anyone check we are allowed to spend?" is a compile error rather than a code-review
  question. Do not add an unauthenticated convenience wrapper.
- **Configuration.** `ONCHAIN_EXECUTION_ARMED` defaults to false, and arming additionally needs
  a key and a per-transaction lamport ceiling (default 0.02 SOL — a bug's blast radius, not a
  position size).
- **The per-transaction ceiling is the blast radius.** `ONCHAIN_MAX_LAMPORTS_PER_TX` bounds any
  single transaction regardless of what the engine asks for. Live mode needs it raised to at
  least `LIVE_MAX_POSITION_SOL`, and `describeLiveExecutionBlockers()` REFUSES TO BOOT when it
  is lower rather than letting every entry pass screening and then fail on the last step.

**`authorizeExecution` no longer reads `isLiveTradingEnabled`, and that is not a weakening.**
The old tripwire refused to sign whenever that flag was anything but false, which was right
while it was a `false` literal — an unexplained `true` could only mean an unreviewed change. It
cannot survive live mode: the flag is now legitimately true whenever the operator set
`DRY_RUN=false` and armed the module, so keeping it would refuse every live signature.
`config.armed` is still the real gate and still defaults to false, and "armed by proxy" is now
prevented by construction: the flag is the AND of two switches and `env.ts` will not boot on
either alone.

**LIVE EXECUTION: the chain decides, the database records.** `src/services/liveExecution.ts`
is the bridge, and every rule in it exists because the alternative loses money quietly:

- **No row is written until the open confirms.** A failed open means there is no position, and
  a row describing one would be a fabricated holding the monitor would then "value", "accrue
  fees" on and eventually "close" — all of it about nothing.
- **No row is marked closed until the close confirms.** A row closed early is a position the
  engine has stopped watching but still owns, and the stop-loss it stops enforcing is the
  reason the position was being exited. A failed close leaves the row ACTIVE so the next tick
  retries.
- **Live exits are TWO-PHASE, because nothing that does I/O may hold `positionMutex`.** The
  monitor decides under the lock and writes nothing; `settleLiveCloses` closes on-chain with
  the lock released, then re-acquires it to record. `closingOnChain` (in-memory) stops the next
  60s tick submitting a second close for a position already being closed — the row is still
  ACTIVE while that is in flight, which is exactly what makes the guard necessary.
- **Every entry SWAPS half the SOL into the pool's other token first.** The range brackets the
  active bin, and a bracketing range is only two-sided if both tokens are supplied. Funding it
  with SOL alone lands a real but ONE-SIDED position, while the engine's PnL model
  (`lpValueReturnFraction`, sqrt(r) - 1) is the balanced-LP formula — the numbers would not
  describe the position. The swap is what makes the existing accounting true rather than
  approximately true, at the cost of one extra leg per entry.
- **The paired amount is read from the chain, never from the quote.** The quote says what
  Jupiter expected to deliver; only the account says what arrived. Depositing the quoted figure
  would, on any adverse fill, ask the program to move tokens the wallet does not have.
- **`StrandedSwapError` is the failure that costs money silently.** Swap confirmed, open
  failed: the wallet now holds a memecoin it acquired only to provide liquidity, and nothing
  unwinds it automatically. It names the mint, the amount and the signature, and pages the
  operator. Do not downgrade it to a warning.
- **A capacity race records the position anyway.** If the book fills while an open is in
  flight, the position EXISTS; refusing to record it would leave real capital somewhere the
  monitor cannot see. The capacity rule governs whether to OPEN — it cannot un-open.
- **`/claim` is operator-only and off the automatic path.** `closeLivePosition` already claims
  atomically via `shouldClaimAndClose`, so claiming on a schedule pays a second set of gas for
  fees the close collects anyway.

**Still true after going live, and still unverified: the DLMM path has never executed against a
cluster.** `npm run test:swap -- --execute` verifies STAGE 1 only — wallet, signing, priority
fees, submit — and it passed on mainnet (0.01 SOL, confirmed first attempt). It does not touch
`openPosition`/`claimFees`/`closePosition`. The first real DLMM execution will be the engine's
own, unattended, on the 30-minute cron. That was an explicit operator decision, not an
oversight; if it needs revisiting, the cheapest change is a manual PoC script in the shape of
`testMicroSwap.ts`.

**The rebroadcast rule in `sendAndConfirm` prevents a double spend, and is the opposite of the
obvious retry.** An unconfirmed transaction may still be in flight, so retrying with a fresh
blockhash can land BOTH — the same swap executed twice, or two positions opened. Therefore: the
same signed bytes are rebroadcast unchanged while the blockhash lives (identical bytes means an
identical signature, so redelivery is idempotent), and a NEW transaction is built only once the
block height has passed `lastValidBlockHeight`, which makes the old signature permanently
unlandable. The priority fee escalates on that rebuild, never per rebroadcast — a rebroadcast
cannot change the fee of bytes already signed. Any error that is NOT blockhash expiry checks
`getSignatureStatus` before reporting failure, because "the RPC threw" is not evidence the
transaction did not land. Reversing this ordering trades a hung transaction for a double spend.

**`HARD_MAX_SLIPPAGE_BPS` is a constant, not a setting.** `ONCHAIN_MAX_SLIPPAGE_BPS` may lower
it and may never raise it; a bound configuration can widen is not a bound. The quote's
`slippageBps` is re-validated against the authorization before signing rather than trusted,
so the 0.5% cap does not depend on a third party's response body, and Jupiter's
`otherAmountThreshold` is what enforces it on-chain — a client-side check would be advisory
while the swap executed at whatever rate it got.

**The DLMM adapter is Stage 2 and is now IMPLEMENTED — implemented is not armed.**
`openPosition`, `claimFees` and `closePosition` build real instructions through
`@meteora-ag/dlmm` (`initializePositionAndAddLiquidityByStrategy`, `claimSwapFee`,
`removeLiquidity` with `shouldClaimAndClose`). No account layout is written by hand, per the
rule this paragraph used to state: a wrong account order does not throw, it moves funds.
Landing it changed nothing about reachability — all three isolation locks above still hold,
and `onchainExecutor.test.ts` still fails the build if `src/index.ts` can reach the module.

Four things inside the adapter are load-bearing:

- **Bin ids come from the SDK, via `toPricePerLamport` FIRST.** `getBinIdFromPrice` takes a
  price per lamport and does no decimal conversion — it is a bare logarithm over the bin-step
  ratio. Handing it `DlmmPool.currentPrice` places the position in an unrelated bin range, off
  by the ratio of the two mints' decimals, and does not throw. `binRangeFromPrices` takes a
  structural type so this conversion is unit-tested without a cluster.
- **The SDK's compute-budget instruction is stripped and replaced.** The SDK attaches its own
  `setComputeUnitLimit` and never sets a unit price; leaving both in place puts two
  compute-budget instructions of the same kind in one transaction, which the runtime rejects.
  Ours carries the priority fee `sendAndConfirm`'s escalation exists to move.
- **The blockhash comes from `sendAndConfirm`, never from the SDK's own fetch.** The
  rebroadcast rule depends on the signed bytes being pinned to the blockhash whose expiry that
  loop is tracking. A transaction carrying a blockhash the retry loop does not know about could
  be rebuilt while the original was still landable — the double spend that loop prevents.
- **A multi-transaction operation reports partial completion.** `claimSwapFee` and
  `removeLiquidity` return `Transaction[]`; a position spanning many bins does not fit in one.
  `DlmmPartialExecutionError` names the signatures that DID land and says to check the chain
  before retrying, for the same reason the ambiguous-failure path does. `DlmmSendResult`
  replaced the old single `SendResult` because that shape could carry neither the several
  signatures nor the address of the position `openPosition` mints — the old interface was
  unusable even once implemented.

**`openPosition` never swaps to balance a deposit.** `amountLamports` is SOL and goes to
whichever side of the pair is wSOL; `pairedTokenAmount` defaults to 0. A range that brackets
the active bin needs both tokens to be two-sided, so a SOL-only deposit lands a real but
ONE-SIDED position — legal, and not the balanced LP the paper model simulates. Acquiring the
paired token is the caller's decision and `executeJupiterSwap` is the path for it. A pool with
no wSOL side is REFUSED rather than interpreted, because `amountLamports` has no meaning there
and guessing is a decimals bug that does not throw.

**`scripts/testMicroSwap.ts` is run by hand and by nothing else.** Dry run is the DEFAULT
(`npm run test:swap` quotes and signs nothing, and needs no key on the box); spending requires
`-- --execute`. It exists to answer the one question no unit test can — whether wallet loading,
signing, the priority-fee handler and RPC submission actually work together against mainnet.
On an ambiguous failure it prints the signature and tells the operator to check the chain
BEFORE retrying; keep that, it is the instruction that prevents a manual double spend.

**The portfolio hero shows the WALLET; the KPI cards show the SIMULATION. Never merge
them.** `GET /api/wallet` (`src/services/walletBalance.ts`) reads the real on-chain balance;
`/api/overview`'s `currentBalanceUSD` is `STARTING_BALANCE_USD + realised paper PnL`, a
simulation baseline with no custody behind it. They are different quantities that both render
as dollars, so `PortfolioHero` labels its figure "on-chain" and tags the PnL row "paper" while
`isDryRun`. An unlabelled paper equity under a wallet header is the fabricated-balance problem
the cohort rules already forbid, wearing a nicer font.

The balance read follows `readRpcHealth`'s three rules for the same reasons: **cached and
single-flighted** (the dashboard polls per open tab, and a chain read per request would
rate-limit the endpoint the widget reports on — `?refresh=1` is the manual button's escape
hatch and must never become the poll path); **null is not zero** (an unreadable wallet renders
as an em dash, because "$0.00" is indistinguishable from a drained account, and a genuine
zero must stay distinguishable from an unknown); and **only the RPC host is published**, since
`SOLANA_RPC_URL` carries the provider API key on Helius and this payload reaches a browser. A
SOL/USD outage nulls the USD figure only — it never discards the SOL reading, which is the
number that matters.

**Aligning the baseline with the wallet: the wallet balance is NOT the value to pin.**
`seedStartingBalanceFromWallet` takes the baseline from the real wallet at preflight, but
refuses once the database holds trades — rebasing under them re-scales every percentage
already reported. That refusal used to end there, leaving a $1,000 baseline under a real
wallet and no number to replace it with, and the number an operator reaches for first is
wrong in a way that does not announce itself. The book computes
`balance = base + realisedPnL`, so a base set to a wallet that has ALREADY lived through
those trades counts every one of them twice: a $228 wallet after $12 of booked losses
reports $216. `impliedStartingBalanceUsd` is that identity solved for the base
(`wallet - realisedPnL`), and the preflight prints the exact `STARTING_BALANCE_USD` line
to paste. Suggested, never applied — the same reason the seed refuses.

Two limits are printed with it and must stay printed, because the number is otherwise
read as "the book now tracks the wallet":

- **It aligns the LEVEL, once, not the meaning.** `getLifetimeStats` filters on status and
  the cohort cutoff and **never on `execution_mode`**, so `realisedPnL` sums PAPER and LIVE
  trades alike. On an engine whose live opens have not succeeded, this matches the book to
  the wallet using PnL that never touched it.
- **They drift apart again from the next trade**, because the valuation model cannot see
  swap slippage, priority fees or unrecoverable bin-array rent. `GET /api/reconciliation`
  is what measures that gap; a matched baseline does not close it.

Making the book track the wallet in MEANING rather than level needs the book restricted to
live trades — an `execution_mode` filter, a sibling of the cohort filter and not a merge
with it, since one control mixing "engine version" with "paper vs live" gives "Current Run"
two meanings. Not started.

**`npm run db:reset` backs up before it destroys.** It writes a timestamped copy to
`data/backups/` (gitignored, never auto-pruned) and prints the restore command. That backup is
why the script needs no confirmation prompt: a mistaken run costs a file copy, not the history.
The copy is taken BEFORE `initDatabase()` — move it after and it silently becomes a copy of a
checkpointed-but-not-current file, missing WAL content. Deletes run in one transaction, then
`VACUUM` outside it, so a "reset" file does not still hold the old trades in free pages. It does
NOT touch `exports/` or `reports/`, which hold the 27-trade dry-run archive behind the churn and
stop-loss findings — those are files, not rows, and the reset must never be read as having
erased them.

**Undefined metrics stay null.** `profitFactor` is null when there are no losing trades; returning
`Infinity` or `0` would render on the dashboard as a real measurement. Max drawdown runs over the
realised curve only — adding floating PnL would make it non-reproducible from history.

## Known behaviour, not a bug

**The stop-loss is the dominant exit, and it overshoots.** An older note here claimed the opposite —
that with `STOP_LOSS_PCT=-8` the stop was nearly unreachable because IL inside a ±10% band is under
0.2% of notional, so exits would be dominated by out-of-range and timeout. The 27-trade dry run in
`exports/` falsifies it: **12 stop-loss, 7 out-of-range, 0 timeouts**. The old note was written when
PnL was still driven by `impermanentLossFraction`; the engine now drives it from
`lpValueReturnFraction` (`sqrt(r) - 1`), which is roughly five times larger for the same move, so -8%
is reached easily. The stop also fires *past* its threshold — median -9.79%, worst -13.84% — because
the position moves through the level between monitor ticks. That is granularity, not a broken
comparison, but do not read `STOP_LOSS_PCT` as a guaranteed floor.

## Source of truth

`docs/prd/` holds the original PRD chapters. Two of its specifics are stale and were corrected
during the build — the Meteora endpoint (`dlmm-api.meteora.ag/pair/all_by_groups` is 404; use
`dlmm.datapi.meteora.ag/pools`) and Farside as an ETF source. `README.md` documents the derivations
of every reported number.

## Telegram control commands

The orchestrator starts a long-polling command bot (`startTelegramCommands` in
`src/services/telegramCommands.ts`) alongside the schedulers. Only the owner's
user IDs (comma-separated `TELEGRAM_ALLOWED_USER_IDS`, empty = deny all) may run
them:

- `/status` — the same KPI payload as `GET /api/overview` (shared via
  `src/services/overview.ts`), plus engine pause state and open positions.
- `/close_all` — emergency close of every active position (`CLOSED_MANUAL`
  status). Values at the live pool price; falls back to the last stored price
  (flagged stale) when the pool is unreachable; positions with neither are
  reported failed and stay open.
- `/pause` / `/resume` — in-memory engine control (`src/services/engineControl.ts`).
  Paused engines skip `seekNewEntry` but keep monitoring/accruing/closing open
  positions. The flag resets to running on restart.

Pitfalls that cost real debugging time:

- **Never call `getUpdates` manually on this bot while it runs.** The engine's
  long-poll and a manual call 409 each other; the engine's poll gets terminated
  and `launch()`'s error is easy to misread as "bot broken". Confirm polling
  with `getMe`/outgoing sends, or a one-shot `getUpdates` only when the engine
  is down.
- **`Telegraf.launch()` never resolves** — it awaits the infinite update loop,
  so readiness is logged immediately after calling it, not in `.then()`.
- **Command replies must be MarkdownV2-escaped in one pass.** Use
  `markdownV2()` (escapes everything except `**bold**` spans); per-value
  sanitization leaks static `(`/`)` and makes Telegram reject the message with
  "can't parse entities". `replyMarkdown` falls back to plain text if escaping
  still fails.
