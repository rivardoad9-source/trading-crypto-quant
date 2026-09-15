# WO#6 status — LEVERCAT-SOL, 15 Sep 2026

Branch `work/exit-leg-slippage-and-attempt-residual-heal`, based on `origin/main` `28dbbe6`.
Nothing deployed, no pm2, no `.env`, no cron, no config value changed.

## Tests

| | tests | pass | fail |
|---|---|---|---|
| `npm test` on `28dbbe6`, before any change | 1036 | 1035 | **1** |
| `npm test` on this branch | 1062 | 1062 | 0 |

`npm run typecheck`: clean. The one failure on main was the executor allowlist:
`\scripts\sweepAttemptResidual.ts references the on-chain executor` (c93e413 imported
`onchainExecutor.ts`, which only five reviewed files may). Task 3 deletes that script.

## Task by task

| Task | State | Commit |
|---|---|---|
| 1 — exit quote checked against the entry bound | **complete** | `dc9edf1` |
| 2 — ladder walks, tested | **complete** | `dc9edf1` |
| 3 — self-heal for a failed open's residual | **complete, not run against the chain** | `98a49e0` |
| 4 — the chunk that failed | **fixed, but the diagnosis differs from the WO** | `dc9edf1` |

**1.** `swapSlippageBoundBps()` is the one derivation `executeJupiterSwap` quotes with, and
`buildJupiterSwap` now takes that bound as a required `{ leg, bps }` and checks it with
`assertQuoteWithinSlippageBound`. The entry bound is unchanged. An entry that passes a wide bound
is re-clamped to 50. An exit quote above the exit cap still throws.

**2.** Tests that failed on the old guard. A mutation that puts the exit leg back on the entry bound
turns 4 of them red:
- the exit quote at 300 bps builds;
- the same quote as an entry is refused;
- a quote above the cap is refused;
- the residual ladder, run through the real guard, is refused at 50, sells at 150, and reports
  `result.slippageBps = 150`;
- the rung sequence equals `sweepSlippageLadder(exitSlippageCapBps())`.

`residualSweep.test.ts:582` is unchanged and passes.

**3.** `retryResidualSweep.ts` now also selects `live_execution_attempts` rows with
`outcome='failed'`, `unwind='orphan'` inside `--max-age-hours`. The decision lives in
`src/services/attemptResidualHeal.ts`: pure, effects injected, no executor import. Guards, in order:
1. a busy pool is skipped;
2. the position account must be ABSENT;
3. the pool's paired mint must equal the row's `token_mint`.

The sale goes through the same `sweepResidualPairedToken` + `defaultResidualSweepDeps`. The row is
written only through `settleRecoveredAttempt.cjs`'s own `chainIsClean` / `planSettlement` /
`writeSettlement`, which are now exported. `closeEmptyTokenAccount` returns `withheld-fee`
instead of throwing.

Four deviations, stated rather than hidden:
- `chainIsClean` only asked the SPL Token program, so it could not see a Token-2022 residual such as
  LEVERCAT. It now asks both. That is a fix to the existing proof, not a new one.
- The busy guard ignores the row's OWN attempt. That attempt is finished, and counting it would
  hold the heal for 15 minutes; a newer attempt on the pool still blocks.
- The cost is NOT written when another attempt, or a live open or close, happened after the failed
  attempt. `before − now` would then not be this recovery's cost. The sale still happens and
  is reported as `SOLD-NOT-RECORDED`.
- `rescue_signature` and `ata_close_signature` are filled only where they are NULL.

**4.** Two parts of the WO's description do not match the code:
- **`liveSizingGuard.ts` does not simulate funding chunks.** It is the wallet-vs-`LIVE_CAPITAL_SOL`
  check. The chunk simulator is `firstShortFundingChunk` in `onchainExecutor.ts`.
- **It does not size against the balance read before the balancing swap.** It runs after the swap,
  on the post-swap token balance.

The real hole, from the verbatim log:
- The check simulates every chunk against the state BEFORE chunk 1 lands.
- `2/2` was first refused as a *stale active bin* (hence "rebuilding against current state").
- The rebuild re-derived the chunk against the moved pool with the ORIGINAL paired total, never
  re-checked against what chunk 1 had left in the wallet.
- Only a stale bin was rebuildable, so the resulting `custom program error: 0x1` was terminal.

Fix:
- An insufficient-funds preflight rejection is now rebuildable in the wide path.
- The rebuild re-reads the wallet and shrinks the remaining deposit with
  `shrinkWideFundingDeposit`. It only moves down, by at least the deposit slippage margin, and at
  most `WIDE_FUNDING_MIDFLIGHT_SHRINKS = 1` time.
- A second refusal throws, naming the funded position. That error drives the existing recovery and
  the operator page.

## What this cannot claim

- **Nothing here has run against the chain.** Every test stubs Jupiter, the RPC and the database. The
  exit-leg fix is proven against the guard's code, not by a live unwind that sold.
- **The shrink is not proven to be the right size.** It assumes the chunks' remaining asks scale with
  the total. If the SOL side (not the paired token) was the short one, shrinking the paired side will
  not help: the second refusal pages, as before.
- **Which side was short cannot be told from the log.** `custom program error: 0x1` does not say
  whether the token account or wSOL ran out.
- **The Token-2022 withheld-fee pre-check reads the RPC's `jsonParsed` extension shape**
  (`transferFeeAmount.withheldAmount`). This was not verified against a live account. The
  refusal-text mapping is the fallback.
- **Harvesting withheld fees so the account can close** is not attempted; the rent stays parked, as
  the WO accepts.
- **A residual that sweeps as dust but is non-zero** fails `chainIsClean`, so the heal reports it and
  does not write. A human settles it.
