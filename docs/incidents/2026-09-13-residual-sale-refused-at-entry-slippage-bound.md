# 13 Sep 2026 — the residual sale was refused at the ENTRY slippage bound, and the operator sold by hand

## What happened (19:05 → 19:56 WIB, real money)

The engine opened EMBER-SOL (position `AxQcU8Uavddqmsj2Z2Vz3Pn2xgB3F9FFEsr4JN96acC4`), the price
ran, and at 19:53:15 the take-profit fired:

- close landed in 2 tx, final `cdMoAzjWNaPjEzqiyyuUEqGB3kwafDzprtZaJvWKE6vLEp4QQp49W4pYRR…`,
  `CLOSED_PROFIT`, booked **+$9.53 (5.31%)**
- `closePosition` returned **1,568.25323 EMBER** to the wallet (plus SOL)
- **the residual sale failed**: `Program JUP6LkbZ… failed: custom program error: 0xe`, logged as
  *"the swap's outcome may be ambiguous"*, `residual_sweep = 'failed'`, `sweep_signature = NULL`

The 12/13 Sep self-heal cron retried once, 10 minutes later, and failed **the same way** — the
operator gave up waiting and sold the 1,568 EMBER by hand (`3conQxaritdSvGEWn3zM72oc…`, landed).
Wallet: 2.219445 → **3.143187 SOL**, no tokens left.

## Root cause: one slippage bound was serving two opposite decisions

`HARD_MAX_SLIPPAGE_BPS = 50` (0.5%) bounds **every** Jupiter swap in the engine — the balancing
swap before an open, the auto-unwind after a failed open, and the residual sale after an exit.

For an **entry** that bound is right: refusing a bad entry costs nothing.

For an **exit** it is exactly backwards. The token is already in the wallet, the market moves
(EMBER moved ~10.5% in 0.8h that evening), and a refused sale leaves the position's value
sitting as a memecoin nothing monitors. Worse, the failure mode was **self-repeating**:

- `executeJupiterSwapFreshQuote` re-quotes on a slippage refusal — but with the **same**
  `slippageBps`, so three re-quotes at 0.5% is 0.5% three times;
- `~/.hermes/scripts/fm_residual_selfheal.py` had `RETRY_AFTER_SECONDS = 3600`, so the second
  attempt arrived **10 minutes** later with the same bound.

The engine had the intent and not the room. The operator's words: *"perbaiki masalah ini, swapnya
harus fast karena kan pasar fluktuatif."*

## The fix (deployed 13 Sep 2026 ~20:08 WIB)

1. **A second hard cap, for exit legs only.** `HARD_MAX_EXIT_SLIPPAGE_BPS = 500` (5%), resolved
   from the new knob `EXIT_MAX_SLIPPAGE_BPS` (default **300 bps**). Entries still ride
   `ONCHAIN_MAX_SLIPPAGE_BPS` and `HARD_MAX_SLIPPAGE_BPS`; exit legs never consult either.
2. **`executeJupiterSwap(..., { leg: "exit" })`** — the dispatcher. Exactly TWO call sites are
   exit legs: the residual sale and the auto-unwind after a failed open. The balancing swap
   before an open is an entry, and a test asserts the count stays 2.
3. **The residual sale walks a ladder**: `50 → 150 → cap` bps, each rung a FRESH quote
   (`SWEEP_SLIPPAGE_LADDER_BPS`, `sweepSlippageLadder(exitSlippageCapBps())`). It stops at the
   first success and only pages the operator after the WIDEST rung has failed. A sale refused at
   0.5% is now retried at 1.5% and 3% within seconds, in-process.
4. **The self-heal cron is faster where it matters**: `*/2` instead of every 10 minutes, and the
   pace is now age-aware — **every 5 minutes for the first 30 minutes** after a close, hourly
   afterwards (`fast_retry_window`/`fast_retry_after`). The 5-minute behaviour is unit-checked
   against synthetic close times.

## Verification

- `src/tests/exitSlippage.test.ts` (new, 10 assertions): the exit bound ignores the entry bound;
  a requested 5,000 bps settles at the cap; a configured cap above the hard cap settles AT the
  hard cap; a nonsense bound throws rather than rounding into a trade; the ladder always ends at
  the cap; the sweep sells at the first working rung and does NOT go wider; it pages only after
  the widest rung fails; dust is still dust; exactly two `leg: "exit"` call sites exist.
- Full suite: **882 tests / 882 pass / 0 fail**; typecheck clean for both projects.
- Live: deployed with `fm_deploy_clean.py --go` (boot shows the sizing guard, the bot polling on
  attempt 1, 0 `bot launch failed`). `scripts/checkEntryBrakes.ts` now prints
  `slippage: entry max 50 bps | exit max 300 bps | ladder sisa token 50 -> 150 -> 300 bps`.
- The one honest limit: this fix cannot be proven end-to-end until a residual sale is refused at
  50 bps again and lands at 150. The next such close will say so in the log
  (`the residual sale of <mint> was refused at 50 bps slippage (attempt 1/3) … retrying with a
  FRESH quote at 150 bps`).

## Notes

- The 1,568 EMBER was **not lost** at any point: it sat in the wallet, visible to the chain scan
  and to `fm_chain_sweep.mjs`, and the self-heal cron would have kept retrying. The cost of the
  incident was the ~40 minutes of exposure to a moving price, not the tokens.
- `residual_sweep` for position id 8 stays `'failed'` in the DB until the self-heal cron reads the
  now-empty balance and records `dust` — that is the loop closing itself, not a loose end.
- A third, separate question the same evening exposed (see
  `docs/backtests/2026-09-13-v11-vs-variants-300usd.md`): the backtest does not price the
  balancing swap at all. That is a measurement defect, not an execution one.
