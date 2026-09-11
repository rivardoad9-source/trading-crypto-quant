# Exit-path audit — does anything close a live position without the sweep?

**11 Sep 2026, TASK 5 of `docs/prompts/ops-followups-ata-rent-test-hermeticity-2026-09-11.txt`.
Read-only. Nothing in the code was changed by this audit.**

The claim under test, from `closeLivePosition`'s doc comment: *"Every live exit reaches the
chain through here — take-profit, stop-loss, out-of-range and timeout from the monitor, and
`/close_all` — via `settleLiveCloses`."*

Method: every call site in `src/` and `scripts/` of `closeLivePosition`, `dlmmExecutor.closePosition`,
`closeOrphanPosition`, `withdrawClaimAndClose`, `removeLiquidity`, the SDK's `pool.closePosition`,
`settleLiveCloses`, `forceCloseAllPositions`, `claimLiveFees`, and the database `closePosition`
(which marks a row closed), plus every route in `src/api/server.ts`. Line numbers are at commit
`8916e89`.

## Verdict

**No P0. The claim holds for every tracked live position.** There is exactly one function that
withdraws a tracked position on-chain — `dlmmExecutor.closePosition` → `withdrawClaimAndClose`
— and its only caller is `closeLivePosition`, whose only production caller is `settleLiveCloses`.
Every other close-shaped call either acts on an account that holds no liquidity (so no token
comes back to sweep), is the failed-open recovery that has its own unwind, or is a database
write guarded to paper rows.

Three lower findings are listed at the end. None bypasses the sweep for a tracked position.

## Paths that close a TRACKED live position (all through the sweep)

| # | Trigger | Path | Reaches `closeLivePosition`? |
|---|---|---|---|
| 1 | Take-profit, stop-loss, out-of-range, timeout — **fast monitor** (60 s) | `runFastPositionMonitor` → `monitorOpenPositions` (`evaluateExit`; a live row is queued in `pendingLiveCloses`, `dlmmTraderAgent.ts:734-761`, never written) → `settleLiveCloses` (`:1015`) → `closeLive` = `closeLivePosition` (`:863`) | **Yes** |
| 2 | The same four exits — **screener cycle's monitor stage** (only when the fast monitor is disabled, or `dlmm:once`) | `runDlmmTradingCycle` → `monitorOpenPositions` → `settleLiveCloses` (`:2468`) | **Yes** |
| 3 | Telegram `/close_all`, live price available | `telegramCommands.ts:478` → `forceCloseAllPositions` → `closeAllPositionsLocked` → `queueLive` (`:1204-1207`) → `settleLiveCloses` (`:1106`) | **Yes** |
| 4 | `/close_all`, pool unreachable, stale stored price | `closeAllPositionsLocked` stale branch → `queueLive` (`:1265-1273`) → `settleLiveCloses` | **Yes** |
| 5 | `/close_all`, no price at all | reported `failed`, row stays ACTIVE, nothing sent | n/a — nothing closes |

`settleLiveCloses` has exactly three callers (`:1015`, `:1106`, `:2468`) and takes `closeLive`
defaulting to `closeLivePosition`; the override exists for tests only. `closeLivePosition` is
the only caller of `dlmmExecutor.closePosition` (`liveExecution.ts:2016`, inside
`defaultLiveCloseDeps`).

## Database closes — paper rows only

`closePosition` (the repository write) is called in production at `dlmmTraderAgent.ts:764`
(monitor), `:871` (inside `settleLiveCloses`, AFTER the chain confirmed), `:1209` and `:1276`
(`/close_all`). `:764`, `:1209` and `:1276` are each reached only after an
`if (isLivePosition(row)) { … continue; }` that routes live rows away, so they write paper rows.
`:871` is the recording half of the two-phase live close.

## Close-shaped calls that are NOT exits of a tracked position

| Call | Where | Why it does not need the exit sweep |
|---|---|---|
| `dlmmExecutor.closeOrphanPosition` | `liveExecution.ts:1600`, failed-open recovery | A half-landed open that has no row. Followed by the failed-open auto-unwind, which re-reads and sells the paired balance through `executeJupiterSwap` and, since `63cb0c6`, closes the emptied ATA. |
| SDK `pool.closePosition` (auto-close unfunded) | `onchainExecutor.ts:3152`, wide-path open failure | Runs only when the freshly created position holds no liquidity (`positionHoldsValue` read first); `closePosition` does not withdraw and the program refuses it on a funded account, so no token is returned. |
| SDK `pool.closePosition` | `scripts/closeOrphanPosition.cjs:111` | Operator script; refuses a position that holds liquidity; dry run by default. No token comes back. |
| SDK `pool.closePosition` | `scripts/forceClosePosition.cjs:18` | Operator script for an empty account; the program refuses it on a funded position. See finding 1. |
| `repos.closePosition` | `scripts/test-local.ts:543, 686` | The smoke test, against a temp database, paper rows. |
| API | `src/api/server.ts` | Read-only: no route closes, claims or signs anything. |

## Lower findings (reported, not fixed)

1. **P2 — `scripts/forceClosePosition.cjs` signs outside the executor, with no dry run.** It
   loads the key and sends on invocation, with its own `maxRetries: 2` rather than
   `sendAndConfirm`'s rebroadcast rule, and without the liquidity refusal
   `closeOrphanPosition.cjs` has. It cannot strand a residual token (the program refuses a
   close on a funded position), so it is not a sweep bypass, but it is the one close path that
   ignores the template the repository documents for scripts that sign.
2. **P3 — `/claim` puts paired-token fees in the wallet with no sweep until the close.**
   `claimLiveFees` (`telegramCommands.ts:538`) is operator-only and not an exit. The fee tokens
   sit unmonitored between the claim and the close; the close's sweep then sells the WHOLE
   balance of the mint, fees included, so they are not lost — only unmonitored for a while.
3. **P3 — `isLivePosition` requires a non-empty `position_address`.** A row with
   `execution_mode = 'LIVE'` and no address would take the PAPER branches above and be closed
   in the database only. `openLivePosition` always returns an address and the row is written
   from it, so no such row can be produced by the engine today; it is listed because the guard
   is the only thing between that shape and a database-only "close" of real capital.
4. **Note — `scripts/controlledWideOpen.ts`** opens a position through `openLivePosition` and
   writes no row, then tells the operator to close it. That close is manual and outside the
   engine, so it gets no sweep; the script's output should be read with that in mind.
