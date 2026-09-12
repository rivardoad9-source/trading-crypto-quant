# 2026-09-12 — half-landed live open left a FUNDED position unattended; recovered by hand

**Status:** capital recovered (99.5%). Root cause of the failure itself is NOT fixed — brief at
`docs/prompts/fix-post-swap-deposit-and-orphan-recovery-2026-09-12.txt`.

## What happened

At **11:08 WIB (04:08 UTC) 2026-09-12** the engine took MANLET-SOL again — pool
`68C62WPYiiNZxprbuaMj2ULXpiTDKcs5xsX7kBGnyajR`, 106 bins, bin_step 80 — after the 11 Sep trade on
the same token. Sequence on-chain (wallet `FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkP6twzi1yQKi`):

| time (UTC) | tx | SOL delta | what |
|---|---|---|---|
| 04:01:07 | `pAxuS8Ea…` | −0.900021 | balancing swap 0.9 SOL → 99 285.446674 MANLET (`HxQhDGYq…`) |
| 04:01:08 | `287JPjBV…` | 0 | compute only |
| 04:01:55 | `3N92iF3y…` | −0.062437 | position account `2uYWjuvEFR65…` created (rent) |
| 04:03:35 | `59cBjLSC…` | −0.840085 | funding tx 1/2 — the **wSOL leg landed** |

Then funding tx 2/2 was **rejected at preflight** and never reached the network:

```
Program log: Instruction: RebalanceLiquidity
Program log: process deposit
Program Tokenkeg… invoke [2]
Program log: Error: insufficient funds          <- custom program error: 0x1
```

The deposit asked for more of the paired token than the wallet actually held. The wallet held
99 285.446674 MANLET the swap had just produced; the deposit was sized to the **pre-swap estimate**.

**Both recovery paths then failed on expired blockhashes**, three builds each:

* auto-unwind (sell 99 285 MANLET → SOL): `aEL78kPC…` expired → gave up after 3 builds;
* `dlmmExecutor.closeOrphanPosition`: `2ru445UT…` expired → gave up after 3 builds.

Result: **1.802543 SOL out of the wallet**, a position funded with 0.84 SOL that nothing
monitored, and 99 285 MANLET in the wallet. The engine's own error line said exactly that
(`ORPHAN LEFT — capital is STILL ON-CHAIN and needs a human`), and `fm_live_watchdog.sh` section 5
(the on-chain sweep) paged it at 11:05/11:10 WIB — the sweep's DB cross-check correctly
distinguished it from the engine's own tracked position.

## What the operator (Hermes) did, 11:17–11:22 WIB

Entries were held first (`data/engine_control.json`), the database and `.env` backed up
(`/tmp/fm_db_backup_before_orphan_recovery.db`). Recovery went through
**`scripts/recoverFundedOrphan.ts`** (new), which adds no signing code of its own: it calls
`dlmmExecutor.closeOrphanPosition` (→ `withdrawClaimAndClose`, `removeLiquidity(10 000 bps)` +
`shouldClaimAndClose`), then `executeJupiterSwap` and `closeEmptyTokenAccount`.

A dry run **simulated the close against mainnet before spending** (`sigVerify: false`) and
reported `+0.902377386 SOL` in one transaction, `err=null`.

Executed:

| step | result |
|---|---|
| close funded orphan | `2FBVbFtXJREaJ8Wftgc83Zj5YxYG1Z7Kxg6qSDFemDvFx9NJnxYpvFZBbqGnGLMT3H8qHqfvQkcfAwDthmmFqkhC` — withdrew `0 X + 839 999 986 Y` (wSOL), no fees to claim, account closed |
| sell residual MANLET | `4bMg2b8d2kfpUeJPkYmuASFzyLD6rZpfwQ8VyhWHNQMVFUskeWPAqhjVhk54CcCvVhwymaJE78g7d42eGXPCaVLm` — 99 285.446674 → **0.871252198 SOL** |
| sell USDC residual (pre-existing, 1.062727 USDC) | `5Ngv3vVvNwbYfzUgND7djG8sUPk5xtdnGD3HcVp88zh23e9BTTa8QLuzDtGq4jFUSAPsXaGZ2M8TbDteWzA8CrD4z` → 0.010464758 SOL |
| reclaim ATA rent (MANLET + USDC) | `2XLEB31u…`, `At7Xv3M1…` |

**Wallet: 1.158476886 → 2.946203635 SOL (+1.787726749).** Against the 2.961019685 SOL held before
the attempt, the incident cost the wallet **0.014816 SOL (~$1.53)** — fees and slippage on the
round trip. Zero token balances left, zero DLMM accounts owned by the wallet, sweep clean.

## Why this is the same bug as 10 Sep, not a new one

`docs/incidents/2026-09-10-half-landed-open-unmonitored-position.md` describes the KNOTS-SOL case
with the same shape: swap confirms → position created → funding partially lands → the last leg
dies on `insufficient funds` in the deposit → wallet tokens unwound (or not) → **a funded position
stays on-chain with nothing watching it**. What this incident adds is that the two automated
recovery paths can BOTH lose to an expired blockhash, so "auto-unwind will handle it" is not a
guarantee. That gap is the reason the capital needed a human.

## Follow-ups (brief: `docs/prompts/fix-post-swap-deposit-and-orphan-recovery-2026-09-12.txt`)

1. Size the paired deposit from the **actual post-swap token balance** (or cap to it), not the
   pre-swap estimate — the recurring 0x1.
2. Make the failed-open recovery **durable**: retry the unwind/close on later cycles instead of
   once, and escalate the priority fee after an expiry.
3. Give a recovery a **first-class record** — `live_execution_attempts` id 2 still reads
   `cost_lamports = 1 802 542 799` / `unwind = 'orphan'`, which was true at the moment of failure
   and is now false (the capital came back). Nothing in the schema can say "recovered".
