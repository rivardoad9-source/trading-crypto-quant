# 13 Sep 2026 — a 3% transfer-fee mint reached the open path (NEARKAT-SOL, −0.079110 SOL)

## What happened

09:01:55 WIB (01:01:55 UTC), one live entry attempt, `live_execution_attempts` id 5.

| | |
|---|---|
| pool | `J3wZVx37wfEpGNjBHiJyuGZf948jsFe3toCiMkD4D1oz` (bin_step **400** = 4%/bin) |
| mint | `6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr` — Token-2022, `TransferFeeConfig` **300 bps** |
| swap in | 0.901586 SOL → NEARKAT, sig `5ZKh1EetUfWimNwjtCX7XYbrA7bpDrAUQo4yksbHtXwuK7DBqRAxUNtJfZHwN48P6oupCwREV7xjnjT458mr7vs2` |
| read | `getTokenAccountBalance` → `Invalid param: could not find account` |
| abort | `the swap confirmed but no token balance could be read` |
| unwind | 0.822476 SOL back, sig `WVwNrBwMBoYFAkavVn2FRgj11bmABrcK5jpb6t3z1PMi236VUVT9nB9qrrxY3msWAe1nbufetZfZ2XCiB3zhFJn` |
| **cost** | **0.079110 SOL** (8.77% of the swap); `unwind='clean'`, `position_address=NULL` |

Wallet after: 2.965856655 SOL, zero non-wSOL tokens. **No orphan, nothing for the
operator to sell by hand** — the guards did their job. This document is about the two
defects the incident exposed, not about the failure being mishandled.

## Defect 1 — nothing screened the mint's Token-2022 extensions

The token charges **3% on every transfer**, so a round trip pays it twice. Measured:
in 0.901586, back 0.822476. With a +5% take-profit, this pool could not have been
profitable at ANY momentum. It cleared anti-rug (authorities revoked, holders fine),
volatility, the 2.5x friction gate and the width cap, because none of them read the
mint's extensions:

- the friction gate (`meteora.ts`) models `gasCostRoundTripUsd + slippageUsd` only;
- `grep -rn "transferFee" src/` returned nothing outside comments;
- `pool.tokenX.owner` / `tokenY.owner` (the token program) was never inspected.

**Fix:** `src/services/tokenExtensions.ts` — raw TLV decode of the mint's extensions
(`TransferFeeConfig`, `TransferHook`, `NonTransferable`), enforced at the funnel in
`applyExecutionGuards` (a new `transferFee` bucket, `exec_transfer_fee_rejected`
column) behind `isLiveExecutionActive()`, so paper mode is byte-identical. **Fail
closed**: an unreadable mint is refused, a transfer hook is refused (every transfer goes
through a third party's program), a non-transferable mint is refused (the sell-back could
never land). Knob: `LIVE_MAX_TOKEN_TRANSFER_FEE_BPS`, default 0.

## Defect 2 — the post-swap balance read was a single unretried call

The ATA existed the whole time: seconds later the engine tried to CLOSE it and Token-2022
refused (`custom program error: 0x23`) because it still held a withheld-fee balance. The
destination account is created INSIDE the swap transaction, so the next read can race
that creation and answer "could not find account". One read, one chance, and the
expensive reaction to a measurement failure was a forced round trip.

**Fix:** `readPostSwapTokenBalance` — three attempts (1.5s / 3s), then the wallet's full
token list (both token programs) as an independent second source. A measured zero still
aborts the open exactly as before; the retry buys evidence, not optimism.

## Evidence / verification

- Unit: `src/tests/tokenTransferFee.test.ts` (decoder + fail-closed branches + placement),
  `src/tests/postSwapReadRetry.test.ts` (retry, second source, genuine zero, never throws).
- Full suite on the armed box: **871 tests / 871 pass / 0 fail** (baseline 845 before this
  change; typecheck clean for both tsconfig projects).
- Against the real chain, through the same code path the funnel uses:

      $ node --import tsx scripts/verifyTokenFee.ts <NEARKAT mint> <EMBER mint> <MANLET mint>
      REFUSED   6UtY9iTZ…  fee=300bps hook=false nonTransferable=false
      allowed   5dvXTZ5q…  fee=0bps
      allowed   HxQhDGYq…  fee=0bps

  i.e. the mint the money was lost on is now refused, and the two mints that traded
  successfully are not (no false positive).
- Deployed with `~/.hermes/scripts/diag/fm_deploy_clean.py --go` (build + restart with a
  SANITISED env: the previous process carried 34 inherited `HERMES_*` variables plus
  `PM2_HOME` from a 10 Sep agent-shell start; the new process carries none). Boot shows
  `[db] migration: added scan_funnel_cycles.exec_transfer_fee_rejected`, the sizing guard,
  the bot polling on attempt 1, and the guard line now ends with
  `token fees: ANY transfer fee refused (plus hooks and non-transferable mints)`.

## Side effects the operator should know

- `FailedCostBreakerError` held NEW entries for 24h from the attempt (0.079110 >
  `LIVE_MAX_FAILED_COST_SOL=0.05`), clearing ~14 Sep 08:01 WIB. Pool + mint benched 168h.
- The wallet's NEARKAT ATA (`657NASjTZ…`) could not be closed: Token-2022 refuses while a
  withheld-fee balance is present. ~0.0016 SOL of rent stays locked. Recorded/logged, not
  paged — the fee is harvested by the fee authority, not by us.
- The drift alert (book 3.173228 vs wallet 2.965857 SOL) has this 0.079 in it as REAL
  spend; the rest is the accumulated exit-spread gap on the three winning trades.
