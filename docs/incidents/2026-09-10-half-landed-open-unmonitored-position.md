# Incident: a half-landed open left a FUNDED position the engine believed did not exist (10 Sep 2026)

**KNOTS-SOL** (`nBXytBBfKLhj6teXarAv8rk6WNgUFBMyybUFRkuK7ad`), 02:01–02:32 WIB.
No capital lost. It is still the most serious failure of the live path so far, because
it is the first one where **the engine was wrong about what it owned** — every previous
incident cost money and reported itself accurately.

## Symptom

Two live opens failed on the same pool within half an hour, while the pool was pumping
(the same pool had been rejected minutes earlier by the volatility gates at **+19.8%/h**).
The failing attempt went:

1. balancing swap SOL → KNOTS **CONFIRMED** (0.9 SOL, i.e. half of a 1.8 SOL position);
2. the wide path's transactions were sent one at a time and **two landed**
   (`5GbTKr7HQ…`, `4aq9MiAsj…`);
3. the next was **rejected at preflight**: `custom program error 0x1` — the SPL token
   program's `InsufficientFunds`, raised inside the `TransferChecked` of the DLMM
   deposit.

The engine then behaved exactly as designed for a failed open: it reported
`StrandedSwapError`, auto-unwound the wallet's remaining KNOTS back to SOL, recorded a
`stage: "open"` execution-breaker strike, benched the pool for 24 h, and wrote **no
position row** — correctly, because the open had not confirmed.

**What it did not do was look at the position.** Position account
`ENNpRNx6aotJH4hFtT7NMB6TdeAUm9QWBGX9pYUBkDLZ` had been **partially funded** by the two
landed transactions. It stayed on-chain for about four hours, in range and earning, with:

- nothing valuing it,
- nothing enforcing its stop-loss,
- `/status` and `GET /api/overview` both reporting **zero active positions**.

The operator found it by hand and closed it manually. The reported result was
**+$18.47 (+11.6%)** — an operator figure, not an engine measurement: with no row there
was no valuation, and `wallet_lamports_before` / `wallet_lamports_after` recorded nothing,
so `GET /api/reconciliation` has no entry for this trade either.

## Which two transactions landed, and how that is known

`sendSequentially` raises `DlmmPartialExecutionError` only when `landed.length > 0`;
if the FIRST funding chunk fails it rethrows the raw error, and the wide path's catch
then wraps it with `[created]` alone — a "landed 1" report. So a "landed 2" report on the
wide path can only be **the position create plus one funding chunk**. That is consistent
with the account being partially funded, and it is why the position held real liquidity
rather than only rent.

## Root cause: three correct rules, and the gap between them

Nothing here is a bug in isolation. Each rule below is right, and this file exists so the
next reader does not "fix" one of them.

1. **No row is written until the open CONFIRMS** (`liveExecution.ts`). A row describing a
   position the open did not complete would be a fabricated holding that the monitor
   would then value, accrue fees on, and eventually "close" — all of it about nothing.
2. **The failure path unwinds the WALLET.** That was written when a failed open's only
   residue was a memecoin balance the swap had bought. It addresses the leftover tokens
   and is structurally blind to the position.
3. **`requirePosition` fails closed** when the owner scan does not list a position. That
   is the right answer when the caller knows only the owner — acting on a position we
   could not read is how an operation targets the wrong account. It is the *wrong* answer
   here, where the caller already holds the address the failure named, and where
   `getPositionsByUserAndLbPair` is a `getProgramAccounts` scan whose index can lag an
   account created seconds ago (already observed on the SOLCAT-SOL orphan, 7 Sep).

Between them sits a position that exists, holds capital, and has no owner in the system.

**The diagnosis was already in hand and nothing acted on it.**
`DlmmPartialExecutionError` is raised only when part of a multi-transaction operation
landed, and it **names the position**. The catch in `openLivePosition` caught it, printed
it, and went straight to the wallet.

A second, smaller defect made the log actively misleading: the wide path's own
best-effort auto-close calls `closePosition`, which **does not withdraw**. On a partially
funded account the program refuses it, and the catch logged *"could not auto-close
unfunded position"* — about an account that was funded and earning.

## Why the deposit was short in the first place

Not established with certainty, and it is a secondary question — the fix targets the
consequence, not this cause. The plausible mechanisms, in order:

- **the pool was moving fast** (+19.8%/h minutes earlier), and the wide path's funding
  chunks are built from a snapshot of pool state;
- **a Token-2022 transfer fee** or similar, where the deposit must cover `amount + fee`
  and the account holds only `amount`;
- **an earlier chunk consuming more than the split assumed**, leaving the next one short.

All three have the same remedy from the executor's side: ask the chain what the account
actually holds before sending, rather than trusting a read taken before the swap.

## Fix (commit `9301733`)

### 1. Recover the POSITION before unwinding the WALLET

`openLivePosition`'s catch now gates on `DlmmPartialExecutionError` — the only failure
that names a position — and calls `recoverPartiallyFundedPosition` **before** the
existing wallet auto-unwind.

The order is the fix, not a tidy-up: the withdrawal returns the paired token to the
wallet, so closing first means the unwind's re-read sweeps it up in the same pass.
Reversed, the unwind would sell against a balance the position was still holding and
leave the withdrawn tokens behind.

It **never throws** (the unwind still has to run; a recovery that threw would trade a
funded position for a stranded token balance) and it **writes no row** — a recovered
position is not a holding, and recording one would be the fabricated row rule 1 exists to
prevent, reached from the other direction.

### 2. Read the ACCOUNT, not the owner index

`readPositionDirect` is a `getAccountInfo` on the address the failure named — no
`getProgramAccounts` scan to lag behind. What that loses is the scan's implicit proof of
ownership, so it is re-established explicitly, and **from the SDK's own memcmp
descriptors** (`positionLbPairFilter`, `positionOwnerFilter`) rather than from offsets
written out here: hand-writing `8` and `40` would keep compiling after an SDK layout
change and silently compare the wrong bytes, and a check that always passes is worse than
no check. An account that is present but is not ours, or not this pool's, **throws**.

`requirePosition` is deliberately left alone: it still guards `closePosition` and
`claimFees`, which act on positions the engine is tracking.

### 3. Recover with a withdraw-claim-close, never a close

`closeOrphanPosition` uses `removeLiquidity` at 10 000 bps with `shouldClaimAndClose`,
sharing **one** implementation (`withdrawClaimAndClose`) with the tracked close, so the
recovery path cannot drift into closing without claiming. Unclaimed fees count as worth
recovering: closing without claiming discards them with the account.

The wide path's own auto-close now **reads the position first** and skips the send when
it can see the account is funded, instead of paying for a transaction the program will
refuse and then logging the wrong thing about it. A read that *fails* still falls through
to attempting the close — not knowing is not a reason to leave rent on the table.

### 4. Say it in the alert, including when the report is missing

`StrandedSwapError` carries the outcome. A failed recovery renders as **"THE ON-CHAIN
POSITION IS STILL OPEN"** — the same words `/close_all` uses for the same situation. And
because `orphan` defaults to null (most failed opens create nothing), a
`DlmmPartialExecutionError` arriving with no recovery report renders as **"A POSITION MAY
STILL BE FUNDED ON-CHAIN … CHECK `<address>` BY HAND"** rather than as silence. A default
that quietly reads as "all clear" on the one failure that leaves money on the table is
how this incident lasted four hours.

### 5. The narrow fused open is no longer sent blind

Not this incident's path — the narrow open is one atomic transaction and has never left
an orphan — but the audit that followed found it was sent **without anything ever looking
at it**. Atomic is not the same as safe:

- the pre-swap rehearsal skips it on purpose (the deposit cannot be simulated before the
  swap that funds it);
- the SDK *does* simulate it, but only to size a compute budget:
  `getEstimatedComputeUnitIxWithBuffer` swallows a failed simulation, falls back to
  1.4M CU, and the transaction is sent anyway.

`openPosition` now simulates it first with the **same budget the send will carry**
(`simulateAgainstCluster` is one resolver shared with the rehearsal; two copies is how
they drift), and re-quotes against the chain — bounded at `NARROW_OPEN_REQUOTE_ATTEMPTS`
= 2 — for the only two causes a rebuild can change:

| rejection | remedy |
|---|---|
| shortfall (`isInsufficientFundsRejection`: token `0x1`, and the `{"Custom":1}` form a simulation actually returns) | re-read the ATA and deposit what is really there |
| stale active bin (`isStaleActiveBinRejection`, `0x1774`) | `refetchStates()` and rebuild |

Four boundaries there are deliberate: a simulation that could not **run** sends anyway (an
RPC that did not answer is not evidence the open would fail — the rehearsal's rule);
anything else is refused rather than paid for; the re-quote only ever moves **down**
(`BN.min`), and an unreadable balance is `null`, never `0`; and `DlmmOpenResult` adds
`depositedPairedAmount` so the row records what the chain was asked for rather than the
pre-open read a re-quote makes stale.

## Impact & cleanup

- **No capital lost.** The position was profitable when the operator closed it; the
  engine's costs were the swap round trip, gas, and bin-array rent.
- Wallet auto-unwind ran and finalized (the 6d685d8-era safety nets worked, as in the
  9 Sep incident).
- KNOTS-SOL recorded `stage: "open"` → benched immediately for
  `EXECUTION_FAILURE_LOCKOUT_HOURS` (24 h).
- The position was closed **by hand**, not by the engine. Nothing about this trade
  reached `simulated_positions`, so it appears in no PnL figure, no cohort, and no
  reconciliation row.

## Open question, not resolved by this fix

**Why was there a second attempt at 02:32?** A `stage: "open"` failure benches a pool
IMMEDIATELY (`BENCH_IMMEDIATELY`, limit 1, not `EXECUTION_FAILURE_LOCKOUT_COUNT`), and the
breaker filters candidates *before* the LLM sees the list (`dlmmTraderAgent.ts:1518`).
So one post-swap failure at 02:01 should have made KNOTS-SOL unselectable at 02:32.

Possible explanations, none confirmed without the pm2 log and the
`pool_execution_failures` table:

- the 02:01 failure was a **pre-swap refusal** (free, and either no strike at all or a
  `rehearsal` strike, which needs two) and only the 02:32 attempt reached the swap;
- the `recordPoolExecutionFailure` write threw and was swallowed by its (deliberate)
  bookkeeping guard, so the strike was never stored;
- both attempts fell inside one screener cycle.

`SELECT * FROM pool_execution_failures WHERE pool_address = 'nBXytBBfKLhj6teXarAv8rk6WNgUFBMyybUFRkuK7ad'`
settles it. **Worth settling** — if a post-swap strike can fail to bench, that is the
7 Sep repeat-loss mechanism still live, independently of everything above.

### Partial answer — verified 10 Sep 2026, 14:25 WIB (DB + on-chain blockTime)

Evidence, all primary:

| Fact | Value |
|---|---|
| `pool_execution_failures` row (pool `nBXytBBf…`) | `consecutive_failures 1`, `total_failures 1`, `last_stage "open"`, `last_failure_at 2026-09-09 19:02:49 UTC` (**02:02:49 WIB**) |
| `last_reason` | the WIDE error — `openPosition on position ENNpRNx6aotJH4hFtT7NMB6TdeAUm9QWBGX9pYUBkDLZ landed 2 of its transactions and then failed` |
| attempt #1 balancing swap (77 bins, `38hfSJMv…`) | blockTime **02:01:55 WIB** (slot 445685556) |
| attempt #2 balancing swap (27 bins, `4stmuaAS…`) | blockTime **02:32:08 WIB** (slot 445691275) |

What this kills and what it leaves:

- **Hypothesis 1 is DEAD.** The 02:01 failure was NOT a free pre-swap refusal — the swap
  landed at 02:01:55, the position landed 2 of its transactions, and the strike WAS stored
  (02:02:49 WIB, stage `open`).
- **What survives is worse than the hypothesis.** The pool was benched at 02:02:49 WIB
  ("one is enough to bench", 24 h), and a SECOND live attempt on KNOT-SOL still ran at
  **02:32:08 WIB** — a different screener cycle, ~29 min after the strike — spent a swap,
  and failed post-swap (`the swap confirmed but no token balance could be read`).
- **That second post-swap failure recorded NO strike.** The row still reads
  `consecutive_failures 1 / total_failures 1` with the WIDE reason as `last_reason`. So a
  post-swap failure (money spent) can fail to increment the bench counter.
- The guard itself works *later*: `[guard] skipped KNOTS-SOL: 1 on-chain execution failure
  AFTER the balancing swap spent (one is enough to bench)` repeats in the engine error log
  for subsequent cycles.
- **Caveat, stated so it is not overclaimed:** both failing swaps are Jupiter routes, so
  their account lists do **not** contain the DLMM pool address. This evidence cannot tell
  whether the 02:32 attempt targeted pool `nBXytBBf…` itself or a sibling pool of the same
  token (the known same-token multi-pool gap). That distinction decides the fix: "the bench
  was not consulted at all" vs "the bench is keyed per pool, so a sibling pool walks around
  it" — the second would mean the bench needs a token-level key.

## Verification

Unit tests and the SDK's shipped source — **not** a partial open recovered on-chain.

- `src/tests/orphanRecovery.test.ts` — the bridge's half: ordering (position before
  wallet), gating (only `DlmmPartialExecutionError`), never-throws, writes-no-row, and
  the alert's four renderings.
- the two new blocks in `src/tests/onchainExecutor.test.ts` — the executor's half: no
  owner scan, SDK-derived memcmp offsets, withdraw-claim-close, shortfall vs. stale-bin
  discrimination, the re-quote bound, and one shared budget resolver.
- Both files were confirmed to **fail against the pre-fix source**, not merely pass
  against the new one.
- The tests are split along the import boundary on purpose: the executor allowlist still
  has **four** entries, so only `onchainExecutor.test.ts` may import the signer.

`npm run build` clean, `npm run typecheck` clean, `npm test` 606/606 on an unarmed
checkout.

## Files touched

- `src/services/liveExecution.ts` — `recoverPartiallyFundedPosition`, `describeOrphan`,
  `OrphanRecovery`, the catch-path ordering, `depositedPairedAmount` from the executor.
- `src/services/onchainExecutor.ts` — `closeOrphanPosition`, `readPositionDirect`,
  `positionHoldsValue`, `withdrawClaimAndClose`, `readAtaBalance`,
  `isInsufficientFundsRejection`, `simulateAgainstCluster`, `DlmmOpenResult`,
  `NARROW_OPEN_REQUOTE_ATTEMPTS`, the narrow pre-send simulation, the guarded wide
  auto-close.
- `src/tests/orphanRecovery.test.ts` (new), `src/tests/onchainExecutor.test.ts`.
- `CLAUDE.md` — "The half-landed open" section, and the corrected "no orphan left behind"
  claim under the SOLCAT-SOL second strike.
