# Should the engine accept USDC-quoted pools? — 91-day backtest, $300 account

**Date:** 9 Sep 2026 · **Runner:** `npm run backtest:quote` · **Window:** 2026-06-10 → 2026-09-09 (2184 hourly bars)
**Command:** `npm run backtest:quote -- --days=91 --pools=12 --deadpools=12 --capital=300 --sizepct=59 --concurrent=1`
**Raw output:** `backtest_quote_comparison.json`

## Why this was run

On 9 Sep 2026 the engine picked pool `9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t` — a
memecoin/USDC pair with **no wSOL leg at all** — cleared every screening gate with it, and
then died at the last step inside `describePair()`, which sizes the deposit in SOL and
requires one side of the pair to be wSOL. The pool was denylisted by hand
(`docs/incidents/2026-09-09-no-wsol-pool-recurring.md`).

The proper fix is one of two opposite things: filter no-wSOL pools out of the funnel, or
teach the engine to fund them. This backtest was run to decide which — **before** writing
either.

---

## VERDICT: the question cannot be answered yet, and the reason is the answer

**Do not accept USDC-quoted pools on this evidence.** Not because they lost — because over
91 days, on an 18-pool USDC universe, the live V1.1 rules found exactly **one** tradeable
pool.

| Arm | Trades | Distinct pools traded | Win rate | Net PnL | PF |
|---|---|---|---|---|---|
| SOL-quoted | 47 | **5** | 72.3% | $186.95 | 1.60 |
| USDC-quoted | 10 | **1** | 90.0% | $74.48 | 19.32 |
| BOTH | 53 | 6 | 73.6% | $234.34 | 1.74 |

The USDC arm's entire result is `OPENAI-USDC`, ten times:

```
== USDC-quoted (10 trades) ==
   OPENAI-USDC [survivor]    10 trades   $74.48
```

A 90% win rate and a profit factor of 19.32 over one pool in one window is not a property
of USDC-quoted pools. It is a description of what OPENAI-USDC did between June and
September. CLAUDE.md already states the rule this run runs into: *"A run whose trades all
come from one cohort is an artefact, not a result."* This is the same failure, one level
finer — a single **pool**, not merely a single cohort.

**Reading `PF 19.32` as "USDC pools are excellent" is the exact mistake this report exists
to prevent.**

---

## The survivorship asymmetry, which points the same way

| Arm | Pools | Survivors / Dead | Trades on DEAD pools |
|---|---|---|---|
| SOL-quoted | 24 | 12 / 12 | **42 of 47** |
| USDC-quoted | 18 | 12 / **6** | **0 of 10** |

Two things went wrong for the USDC arm here, and both flatter it:

1. **The ingest could not find 12 dead USDC pools.** It exhausted its candidate list at 6.
   There are simply fewer no-wSOL pools that once traded seriously and then died with
   enough history to replay.
2. **The USDC arm never traded a dead pool at all.** Every one of its ten trades was on a
   survivor — a pool that is alive today, selected because it is alive today.

So the USDC arm is a **survivors-only** result sitting next to a SOL arm that took 42 of
its 47 trades on pools that are now dead. That is not a like-for-like comparison, and the
bias runs in the USDC arm's favour. Its flattering statistics are what survivorship bias
looks like — the thing the dead cohort exists to remove, and here it did not get removed.

Had the USDC arm still lost under that advantage, the case against it would be strong.
It did not lose. It simply produced no evidence.

---

## What IS solid

### 1. The prize is real: a third of the screened universe is invisible

Measured against the live pool list on 9 Sep 2026 (1,200 pools scanned, engine's own band:
TVL $50k–$500k, fee/TVL 0.8%–25%, 24h volume ≥ $10k):

| | Pools passing the band | Median fee/TVL |
|---|---|---|
| SOL-quoted (tradeable today) | 32 | 5.19% |
| USDC-quoted (refused today) | **16 (33%)** | 3.72% |

So the capability gap is a third of the screened universe — but the pools behind it carry a
**lower** median fee/TVL, which is the metric the entry gate keys on. The gap is smaller
in economic terms than it is in pool count.

### 2. USDC support costs double the swap friction, and that was never priced

The wallet holds SOL. A pool with a wSOL leg needs half the deposit swapped into the other
token and swapped back: **2 legs, 1.0× the position through the book per round trip.** A
USDC-quoted pool holds *neither* asset the wallet has, so **both** halves must be
converted, out and back: **4 legs, 2.0×.**

Until this run, `src/backtest/engine.ts` charged **nothing at all** for the balancing swap
— gas covered two transactions and slippage applied only to forced exits, so the swap that
runs on *every* entry was modelled as free. That affected every existing SOL backtest too,
not only this question. It is now a named, swept cost (`swapSlippagePct`,
`swapGasSolPerLeg`), charged at the entry gate as well as at the close, and **defaulting to
zero** so no previously published figure moves.

| Per-leg swap | SOL PnL | USDC PnL | BOTH PnL |
|---|---|---|---|
| 0.00% | $224.23 (47 tr) | $85.73 (10 tr) | $291.23 (53 tr) |
| 0.10% | $209.01 (47 tr) | $81.19 (10 tr) | $267.83 (53 tr) |
| 0.25% | $186.95 (47 tr) | $74.48 (10 tr) | $234.34 (53 tr) |
| **0.50% (on-chain cap)** | $152.14 (47 tr) | **$0.00 (0 tr)** | $182.55 (53 tr) |

0.50% is not a pessimistic guess: `HARD_MAX_SLIPPAGE_BPS = 50` and Jupiter's
`otherAmountThreshold` rejects a worse fill, so it is the worst fill the live path can
physically take.

### 3. At worst-case fills, USDC viability is a function of ACCOUNT SIZE — and $300 is on the cliff

At 0.50%/leg the USDC arm drops to zero trades, while the SOL arm keeps all 47. That is not
the pools failing; it is the **fixed** per-leg gas (4 legs × 0.0035 SOL ≈ $1.45) failing to
clear the 2.5× coverage bar against a $177 notional. Raise the notional and it dilutes:

| Starting capital | USDC trades @ 0.50%/leg | SOL trades |
|---|---|---|
| $300 | **0** | 47 |
| $450 | 10 | 47 |
| $600 | 10 | 47 |
| $900 | 10 | 47 |

**$300 sits exactly at the edge.** If USDC support is ever built, this is the number that
decides whether it functions on a bad-fill day, and it is a sizing decision, not a gate
setting.

### 4. SOL ran 58.74% in this window, and the engine's own PnL cannot see it

| Arm | Net PnL (engine) | SOL beta | Net PnL (USD) |
|---|---|---|---|
| SOL-quoted | $186.95 | **+$41.75** | $228.69 |
| USDC-quoted | $74.48 | $0.00 | $74.48 |
| BOTH | $234.34 | +$39.93 | $274.27 |

The engine values a position in its **quote asset**. For a USDC pool that is already a USD
figure; for a SOL pool it is a SOL figure carried on a USD notional, which silently assumes
SOL/USD was flat. It moved **+58.74%**.

This matters in both directions and must not be quoted as a win for SOL pools: had SOL
fallen 40% instead, the same term would have gone the other way just as hard. It means a
TOKEN/SOL LP carries SOL exposure that the engine's accounting does not show, and a
TOKEN/USDC LP does not. **That is a genuine reason to want USDC pools** — they are the only
way this strategy can hold a position without also being long SOL — and it is an argument
about portfolio risk, not about the fee edge.

The correction is a diagnostic only. `closeAt` was **not** changed: redefining a historical
PnL column is worse than reporting the gap.

### 5. None of this is reachable today anyway

| Arm | Pools fitting ≤70 bins | Fitting ≤1400 bins |
|---|---|---|
| SOL-quoted | **0 / 24** | 21 / 24 |
| USDC-quoted | **0 / 18** | 16 / 18 |

`LIVE_MAX_POSITION_BINS=70` is the interim breaker while the wide path is unvalidated.
**Not one pool in either arm fits under it.** This entire comparison describes the wide
path — the one that is halted, with zero successful live opens ever.

(The sampled universe is more bin-hungry than the live one: the ingest takes the
highest-volume pools in the TVL band, which skew to low `bin_step`. The live scan finds 9/32
SOL-quoted and 4/16 USDC-quoted pools under the 70-bin cap. The point stands either way —
under the current cap, USDC support would add roughly **four** reachable pools.)

---

## Recommendation

**Filter no-wSOL pools out of the funnel. Do not build USDC support yet.**

1. **Now — cheap, and it is the fix the incident actually needs.** Add a "pool must have a
   wSOL leg" check inside `isLiveExecutionActive()`, alongside the bin-cap filter, so
   no-wSOL pools never reach the model. This stops the 30-minute cycle burn and the
   recurring execution-error alert without a hand-maintained denylist entry per pool. It
   also keeps paper mode byte-identical, the same discipline the bin cap follows.
2. **Not now — USDC funding.** The evidence for it is one pool. Re-run this comparison
   after the wide path is re-armed and the bin cap is lifted, when the tradeable USDC
   universe is 16 pools instead of 4 and a real sample is possible.
3. **When it is built, three things are already known:** it costs 4 swap legs instead of 2;
   it needs the account above roughly $450 to survive worst-case fills at the current
   sizing; and it is worth wanting mainly because it removes SOL exposure from the book,
   not because the pools yield more — they yield less (3.72% vs 5.19% median fee/TVL).

## What changed in the code

| Change | Why it is safe |
|---|---|
| `swapSlippagePct` / `swapGasSolPerLeg` in `BacktestConfig` | Default **0** — every existing backtest, sweep and cached result is byte-identical. Only this runner sets them. |
| `balancingSwapCost()` / `balancingSwapFrictionUsd()` | Charged at the entry gate *and* the close, so the advertised bar is the enforced one. |
| `swapCostUsd` on `BacktestTrade`, `totalSwapCostUsd` on the summary | Additive fields. |
| `poolFilter` on `loadHistoricalData` | Undefined = no restriction; existing callers ingest exactly what they did before. |
| `src/backtest/runQuoteComparison.ts`, `npm run backtest:quote` | New; nothing else imports it. |
| `src/tests/quoteComparison.test.ts` | 16 tests binding the arm definitions, the swap-leg counts, and the SOL-beta correction. Full suite: **562 passing**. |

## Caveats

Everything in `BACKTEST_CAVEATS` applies — above all **modelled TVL** (`k × 24h volume`,
k median 0.165, IQR 0.117–0.395), which every entry filter runs against. In addition:

1. **The USDC arm is one pool.** Nothing in this report should be read as a measurement of
   USDC-quoted pools as a class.
2. **The arms are not the same size** (24 vs 18 pools) and not equally survivorship-
   corrected (12 vs 6 dead). The imbalance favours the USDC arm.
3. **The two sub-universes are different in kind.** The SOL arm's survivors are memecoin
   pairs; the USDC arm's are largely majors and blue chips — JLP, ZEC, HYPE, JUP, FO-USDT —
   with a median TVL of $152k against the SOL arm's $51k. Accepting USDC pools is not "more
   of the same strategy"; it changes what the engine trades.
4. **Per-arm attribution inside BOTH is path-dependent.** In the combined run, USDC pools
   took 11 of 53 slots and $140.62 of the PnL while the SOL pools' share fell from $186.95
   to $93.72 — the ordering of entries changed, so those figures cannot be read as
   contributions.
5. **Swap slippage is an assumption, not a measurement.** No free provider serves historical
   Jupiter fill quality. That is why it is swept rather than published as one number.
