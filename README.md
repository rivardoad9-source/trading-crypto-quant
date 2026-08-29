# FlowMetrix / Meteora AI Engine

Modular AI agent stack for Solana **Meteora DLMM** liquidity research and **zero-capital paper
trading**, with a local quant dashboard.

> **No real funds are ever deployed.** The engine simulates liquidity positions and never signs a
> Solana transaction. `DRY_RUN=true` is the default, and the process refuses to boot if it is set
> to `false` (live execution is not implemented).

---

## What it does

| Subsystem | What it does | Entry point |
|---|---|---|
| **Macro Researcher** | Pulls Fear & Greed, CoinGecko global + spot prices, DEXScreener trending, and optional FRED macro; asks DeepSeek for a 4-section Markdown brief; stores it and pushes it to Telegram. Runs 07:00 WIB. | `src/agents/researcherAgent.ts` |
| **DLMM Paper Trader** | Screens live Meteora pools on hard quantitative filters, runs an anti-rug screen, asks DeepSeek (Zod-validated JSON) to pick a pool and bin range, then runs a position state machine tracking fee yield vs impermanent loss. Runs every 10 min. | `src/agents/dlmmTraderAgent.ts` |
| **Post-Trade Reflection** | On close, asks DeepSeek for a one-sentence post-mortem and stores it. Failures are retried on later cycles. | `src/agents/postMortemAgent.ts` |
| **REST API** | Fastify server on port 4000 serving the dashboard. | `src/api/server.ts` |
| **Dashboard** | Next.js 16 + Tailwind v4 dark command center, polling every 10s. | `dashboard/` |

---

## Setup

```bash
npm install
npm approve-scripts better-sqlite3 esbuild   # npm 11+ blocks native install scripts by default
cp .env.example .env                         # then fill in DEEPSEEK_API_KEY

cd dashboard && npm install && cd ..
```

Node 20+ required (developed on Node 24).

### Required configuration

Only `DEEPSEEK_API_KEY` is needed for the agents to make decisions. Without it the engine still
screens pools and serves the API, but declines every entry and skips research runs.

Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) is optional; alerts fall back to console logs.
`FRED_API_KEY` is optional and fills in DXY / US 10Y / S&P 500.

---

## Running

```bash
npm run dev              # orchestrator: cron schedulers + REST API (port 4000)
npm run api              # REST API only, no schedulers
npm run dashboard:dev    # Next.js dashboard on port 3000
```

Run `npm run dev` and `npm run dashboard:dev` in two terminals, then open http://localhost:3000.

### Manual triggers

```bash
npm run dlmm:once        # one screen -> decide -> monitor cycle
npm run research:once    # one macro research run
npm run snapshot:once    # roll today's closed trades into daily_pnl_snapshots
npm run smoke            # probe every external API and print screener output
npm run seed:demo        # insert demo positions marked [DEMO] so the dashboard has data
npm run db:reset         # wipe all tables
```

### Failure-avoidance guardrails

Four hard gates, derived from ~13k enumerated entries and validated on a 15d/15d out-of-sample
split. Together they cut the rate of losses worse than -10% from **6.5% to 1.5%** in-sample and
**8.3% to 0.9%** out-of-sample.

| Gate | Threshold | Big-loss lift when breached | Where |
|---|---|---|---|
| Pool age | >= 48h | 7.3x | `screenPools` |
| 24h pump | <= +150% | 6.9x | `dlmmTraderAgent` |
| 1h surge | <= +10% | 6.8x | `dlmmTraderAgent` |
| Realized volatility | <= 20%/h | 5.8x | `dlmmTraderAgent` |
| TVL band | $50k - $500k | 2.9x below, 0.00% mean net above | `screenPools` |

Every gate **fails closed**: an unknown age, price change or volatility is rejected. Data that was
never measured is not evidence of safety.

Candidates that clear the gates are ranked by the plain `fee/TVL x volume` rule. The composite
Pool Quality Score from `npm run research` is deliberately **not** wired in — it did not hold its
sign across the two halves of the sample, so using it would be fitting to noise.

### Anti-churn: pool cooldown & failure lockout

The guardrails above judge a pool on its live metrics alone. They have no memory of what
this engine already did to it, so a pool that ranks first keeps ranking first — live paper
trading re-opened the same pair within minutes of closing it out of range, paying entry gas
and forced-exit slippage on every lap. Two rules in `assessPoolCooldown` supply that memory.

| Rule | Trigger | Bench | Env |
|---|---|---|---|
| Cooldown | any close, profit included | `POOL_COOLDOWN_HOURS` (4h) from `closed_at` | `POOL_COOLDOWN_HOURS` |
| Lockout | N consecutive `CLOSED_LOSS` / `CLOSED_OUT_OF_RANGE` | `POOL_LOCKOUT_HOURS` (24h) from the last failure | `POOL_LOCKOUT_CONSECUTIVE_FAILURES`, `POOL_LOCKOUT_HOURS` |

Lockout is evaluated first, being the longer and the more serious of the two. The failure run
is counted newest-first and **reset by any non-failing close** — a win or a timeout clears it.
A timeout is deliberately not a failure: the position simply aged out while still in range.

A `CLOSED_MANUAL` close — Telegram `/close_all` — is **invisible to both gates**: it starts no
cooldown, trips no lockout, and clears no failure run. Benching every pool the operator just
flattened would silently stop trading for hours right after an intervention, and letting a
manual close reset the run would un-arm a breaker that two genuine failures had earned. The
gates measure the pool, not the operator.
Setting any of the three values to `0` disables that gate; all three are validated as
non-negative at boot.

The gate runs **before** the anti-rug, volatility and breakeven screens, because it is the only
one answered from local state — skipping a pool here saves several RPC and HTTP round trips per
candidate. It is not a safety gate and never overrides one.

Two failure modes it is explicitly built against:

- **Timestamp zones.** SQLite's `CURRENT_TIMESTAMP` is `YYYY-MM-DD HH:MM:SS` in UTC with no zone
  marker, which `new Date()` reads as *local* time — a 7-hour error on an Asia/Jakarta box, enough
  for a 4-hour cooldown to expire before it began. `parseDbTimestamp` normalises it; the monitor
  and the gate share that one parser so they cannot drift apart.
- **Unreadable clocks fail open.** A record whose timestamp will not parse is treated as expired,
  not as an indefinite ban. This is the opposite of the anti-rug screen's fail-closed rule, and
  deliberately so: this gate protects returns, not capital, and a broken clock must not silently
  freeze the screener.

### Two clocks: fast monitor and screener

The engine runs position marking and pool screening on separate schedules, because they
are limited by different things.

| Loop | Cadence | Does | Costs |
|---|---|---|---|
| Fast monitor | 60s | Marks open positions (≤ `MAX_CONCURRENT_POSITIONS`), fires exits | ≤3 Meteora pool reads, fetched concurrently |
| Screener | 10m | 600-pool scan, GeckoTerminal volume, anti-rug RPC, DeepSeek reasoning | Every rate-limited upstream in the project |

**Why.** An exit threshold is only as tight as the interval that tests it. On the old
single 10-minute loop the dry run in `exports/` fired its `STOP_LOSS_PCT=-8` stop at a
median -9.79% and a worst **-13.84%**: price crossed the level and kept going while the
engine sat between ticks. `evaluateExit` was never wrong — it just was not asked often
enough. Checking every 60 seconds bounds the overshoot to what a pool moves in a minute.

The screener stays on 10 minutes on purpose. It is the loop that touches the
rate-limited upstreams, and running it 10x more often to fix an exit-timing problem
would trade one failure for another. When `FAST_MONITOR_ENABLED` is true the screener
skips its own monitor stage (`runDlmmTradingCycle({ skipMonitor: true })`); when it is
false the stage returns, so positions are never left unmonitored.

Prices for the fast monitor come from **Meteora**, not DexScreener. `entry_price`,
`lower_bin_price` and `upper_bin_price` are all stored from `DlmmPool.currentPrice`, so
marking against a differently-derived price could fire a stop-loss or an out-of-range
exit on a unit mismatch rather than a real move.

**Concurrency.** Both loops, plus Telegram's `/close_all`, mutate `simulated_positions`.
Fee accrual is `rate x (now - last_checked_at)`, so two overlapping passes would book the
same interval twice. Every write is taken under `positionMutex` (`src/services/mutex.ts`).
The cron locks in `index.ts` only stop a job overlapping *itself*; this is the lock that
stops different jobs overlapping each other. A fast tick that cannot take the lock
**skips** rather than queues — whoever holds it is already valuing the same positions
against fresher prices. `/close_all` and the screener's own writes queue instead, because
those must happen.

### In-context learning for the entry model

The entry prompt carries a `RECENT LOSSES` block: the last `LOSS_CONTEXT_TRADES` losing
closes that have a post-mortem, each with the range the position **actually** ran
(reconstructed from the stored prices, so the floors in `computeBinRange` are reflected),
how it closed, and the lesson written afterwards.

The model is then given a bounded licence to improvise on range width:

- Losses dominated by leaving the range — wicks, false breakouts, post-mortems describing
  chop — are grounds to **widen** `binRangeDownsideCoverPct` / `binRangeUpsideCoverPct`.
- Losses from sustained directional moves are not: a wider range would only have lost
  more slowly, so `SKIP` is preferred.
- `MIN_DOWNSIDE_COVER_PCT` / `MIN_UPSIDE_COVER_PCT` are quoted in the prompt and remain
  hard floors — `computeBinRange` clamps regardless of what the model returns.
- Widening is stated as a real cost (thinner liquidity, less fee income per unit), so it
  has to be justified in the thesis rather than applied reflexively.

With no qualifying history the block reads `RECENT LOSSES: UNAVAILABLE` and the model is
told not to assume a regime it has no evidence for — the same contract the macro metrics
use. Nothing is fabricated to fill the slot.

### Session / cohort filter

The engine changed materially at `ENGINE_V11_CUTOFF`: the anti-churn cooldown/lockout and
the 60-second exit monitor went in together. Trades either side of that line came from
different machines, and averaging them hides whether the fix worked. The dashboard reads
one cohort at a time, defaulting to the clean run.

| Cohort | `?cohort=` | Contents |
|---|---|---|
| Current Run (v1.1) | `current` | Positions **opened** at or after the cutoff |
| All-Time Archive | `all` | Every simulated trade, both versions |

`?cohort=` is accepted by `/api/overview`, `/api/positions/active`,
`/api/positions/history` and `/api/pnl-calendar`. An unknown value is a **400**, never a
silent fallback — serving the archive to a client that asked for the clean run would
mislabel the numbers. Omitting it means `all`, so an unparameterised call never returns a
subset by surprise; the dashboard therefore sends its choice on every request. The
Telegram `/status` command keeps reading the unfiltered archive.

**Membership is decided by `opened_at`, not `closed_at`.** The cohort names the engine
that made the *entry* decision, so a position the old screener picked stays v1.0's trade
however long it took to close. Ordering still runs on `closed_at` where a chronological
curve is needed.

**Filtered figures are rebased, and the UI says so.** In `current`, equity, drawdown and
profit factor restart from `startingBalanceUSD` at the cutoff. They answer *what would
this engine version have done from a standing start* — not what the account holds. The
payload carries `cohort.filtered`, `excludedTrades` and `excludedRealizedPnLUSD` so the
banner can quantify exactly what was left out, and the dashboard renders that as a
warning strip rather than leaving a rebased number to be read as a balance.

**Setting the cutoff.** The default is the v1.1 commit, `2026-08-29T13:20:40Z` — not
midnight that day. 13 of the 27 legacy trades were opened later that same morning, the
last at 12:40Z, so a date-only cutoff would file pre-fix trades under "Clean Engine".
Set `ENGINE_V11_CUTOFF` to the moment you actually **restart** the engine on v1.1: the
commit time is a safe floor, not a deploy record, and anything opened between the commit
and the restart is still v1.0's work.

### Exit thresholds: what the sweep found (and why they were not changed)

`npm run sweep:exits` grid-searches `TAKE_PROFIT_PCT` x `STOP_LOSS_PCT` over the 30-day
window, fitting on the first half and scoring on the second. `npm run sweep:exits --
--live-entry` repeats it with the entry gates from `.env` instead of the looser backtest
defaults.

The live dry run showed an inverted risk/reward: **avg win $8.76 against avg loss
$10.88**, payoff 0.81, expectancy **-$1.06/trade**. The config is the direct cause —
`TAKE_PROFIT_PCT=5` against `STOP_LOSS_PCT=-8` risks 8 to make 5, a structural payoff
ceiling of **0.63**.

64 combinations, backtest-default entry gates (78 trades in-sample at the current
setting):

| TP | SL | payoff | in-sample exp | **out-of-sample exp** | maxDD |
|---|---|---|---|---|---|
| **+5% / -8% (current)** | | 0.69 | -$0.68 | **-$2.43** | 71.6% |
| +8% | -8% | 0.95 | -$0.70 | -$3.59 | 65.9% |
| none | -6% | **1.10** | -$0.75 | -$3.43 | 70.3% |
| none | -5% | **1.25** | -$0.86 | -$3.07 | 77.1% |

Two findings, and they point the same way:

1. **Payoff > 1 is reachable, but it costs more than it buys.** Only a tight stop
   (-5%/-6%) with the take-profit disabled gets the average win above the average loss.
   Every one of those settings is *worse* out-of-sample than the current config, and
   none is profitable.
2. **No combination is profitable at all.** Not one of the 64 has positive expectancy in
   both halves. With `--live-entry` it is starker: 9-15 trades per half and an
   out-of-sample profit factor of **0.00** — every out-of-sample trade lost.

So the thresholds were left alone. Moving them to chase a ratio the data does not reward
would be fitting to noise, the same reason the composite Pool Quality Score is not wired
into the screener. **The exits are not where the edge is missing; the entry rule is.**

One caveat in the strategy's favour: the fee model is a deliberate conservative lower
bound (pool-level, no concentration multiplier, zero while out of range), so absolute
profitability is understated. That does not rescue the comparison — every cell shares the
same fee model, so the ranking between settings still holds.

### Backtest (survivorship-bias controlled)

```bash
npm run backtest                                          # 30 days, $100 compounding
npm run backtest -- --days=30 --pools=16 --deadpools=10 --refresh
npm run backtest -- --downside=20 --upside=20 --tp=3 --maxhours=48
npm run backtest -- --gas=0.005 --slippage=2.5            # harsher execution costs
```

Runs the **same strategy twice over the same window** and prints the two side by side:

| Run | Universe |
|---|---|
| **Biased** | survivor pools only — what a naive harness picking today's top pools measures |
| **Unbiased** | survivors **plus** pools that died during or after the window |

The gap between the two *is* the survivorship bias, measured rather than asserted.

**How the dead cohort is found.** Meteora's pool listing is not pruned — it returns ~123k pools
including ones created 600+ days ago now reporting `tvl: 0, volume: 0`. Dead pools are reachable;
they are simply not near the top of a volume sort. `src/backtest/universe.ts` combines today's
volume leaders with pools sorted by `pool_created_at` whose *lifetime* volume shows real past
activity but whose current volume has collapsed.

**Realistic execution.** Gas is charged at `--gas` SOL per transaction (two per position), forced
exits pay `--slippage`, and a position whose pool lost all liquidity is marked to the worst forward
price rather than an exit price nobody would have filled. Those trades are reported as `RUGGED`.

#### The two assumptions that carry the result

- **Modelled TVL.** No free provider serves historical TVL for Meteora DLMM pools. TVL at each bar
  is estimated as `k x trailing-24h-volume`, with `k` fitted per pool where observable and
  otherwise from the live cross-sectional median. Every entry filter runs against that estimate,
  not a measurement, and the report prints `k`'s interquartile range so the looseness is visible.
  A snapshot cannot be substituted: a rugged pool reads ~$0 TVL today, so a snapshot `MIN_TVL_USD`
  filter would reject every dead pool and silently restore the bias.
- **The universe is a sample**, not all 123k pools. Sampling deeper would surface more failures,
  so whatever residual bias remains still points optimistic.

Forward bars are consulted only to decide whether an exit was *executable* — whether there was
anyone left to sell to. They never inform an entry or exit decision, which would be look-ahead bias
in the strategy itself.

### Running 24/7 on a VPS

The engine is a single long-lived Node process. These are the things that were wrong for
that, found in the v1.1 pre-flight audit, and what they are now.

**Crash containment.** `index.ts` registers `unhandledRejection` and `uncaughtException`.
Since Node 15 an unhandled rejection *terminates the process* — every cron job is wrapped
in `withLock`, which catches, but one stray floating promise anywhere would have killed
the engine with no explanation beyond the process being gone. Rejections are logged and
swallowed (paper trading, no capital at risk, so staying up beats exiting silently);
uncaught exceptions close the database and exit 1 for the process manager to restart,
because at that point state may genuinely be corrupt.

**No network calls hold the position lock.** `sendPositionClosed` (Telegram) and
`reflectOnPosition` (DeepSeek, timeout in minutes) used to be awaited inside
`monitorOpenPositions`, i.e. while holding `positionMutex`. That silently voided the
60-second exit guarantee for up to two minutes after *every* close. They are now queued
as `DeferredCloseWork` and settled after the lock is released. `/close_all` still does
both under the lock, which is accepted: once it finishes there are no open positions, so
the fast monitor has nothing it could have been doing.

**Bounded logging.** At 1440 ticks a day, one unreachable pool used to write two lines
per tick — the same fact from `fetchPoolByAddress` and from the monitor — about 2,880
lines a day per position. Staleness is now reported on the first tick, then hourly, then
once on recovery, and the fast monitor logs only when it actually closes something. A
two-hour outage produces **3 lines instead of 360**.

**Bounded memory.** The only mutable module state is `staleStreaks`, pruned to the live
position set on every pass, so it is bounded by `MAX_CONCURRENT_POSITIONS` rather than by
uptime. Cron tasks are created once at boot; no timer is created per tick.

**API failures are visible and graceful.** Fastify runs with `logger: false`, so a route
that threw was answered 500 and logged **nowhere** — a broken dashboard with no trace on
the VPS. There is now an error handler that logs 5xx to the console and returns a generic
body (never the internal message), plus a JSON 404 handler.

**Upstream failure is fail-closed, not fatal.** With every upstream refused, a full cycle
returns null and the process stays up; the fast monitor marks positions stale and leaves
them untouched rather than marking against a stale price. DeepSeek is bounded by
`DEEPSEEK_TIMEOUT_MS` (default 120s) with one retry, instead of the SDK default of 10
minutes with two — which could stall the screener for half an hour.

**SOL/USD has fallbacks.** It used to read CoinGecko only, so one rate-limited API stopped
trading completely — the engine refuses to size a position without a price, which is
correct but total. `fetchSolPriceUsd` now walks `SOL_PRICE_SOURCES` in order:

| Order | Source | Why |
|---|---|---|
| 1 | CoinGecko | Also feeds BTC/ETH and the 24h changes the macro agent needs |
| 2 | Jupiter (`lite-api.jup.ag/price/v3`) | Keyless, Solana-native USD oracle |
| 3 | DexScreener SOL/USDC pool | Already a project dependency; same pool the backtest quotes SOL from |

A fallback being used is logged, so a degraded price path is visible rather than silent.
Every quote is re-validated **by the chain**, not just inside each source: a source that
returned 0, NaN or 1e30 would otherwise feed it straight into position sizing, and
notional is fixed at entry, so a bad price is baked into that trade's PnL permanently.
The bounds are deliberately absurd ($0.01–$100,000) — they reject garbage without
asserting a view on what SOL is worth, which would silently reject real prices in a
violent move.

When every source fails the function still returns null and the engine still opens
nothing. Fallbacks reduce the chance of that; they do not license inventing a price.

Note that a CoinGecko 429 can still make `npm run test:local` report red checks in Stage
3 if it happens to hit `fetchSpotPrices` (BTC/ETH have no fallback — nothing sizes a
position from them). Re-run after a minute before believing a Stage 3 failure.

### Local verification (pre-deploy smoke test)

```bash
npm run test:local              # 5-stage end-to-end check against live upstreams
npm run test:local -- --keep-db # keep the throwaway database for inspection
```

Verifies env + migrations, every external service, the paper-trading state machine
(open -> accrue -> trigger -> close -> snapshot), and all REST endpoints, then prints a
PASS/FAIL/SKIP checklist. Exit code is 1 if anything FAILs.

It runs against a **throwaway SQLite file in the OS temp dir**, never `./data/flowmetrix.db`,
so it can never pollute real paper-trading history. Unconfigured optional services report
**SKIP**, not PASS (which would claim a connection never made) and not FAIL (which would flag a
healthy install as broken) — but a SKIP still means that path is unverified for the deploy.

SKIP is reserved for exactly that: a path left unverified because an optional service
(DeepSeek, Telegram, FRED) is unconfigured. A check that made its request and got the answer it
expected is a PASS, even when the expected answer is "this endpoint is dead". With every optional
service configured the run reports **0 skipped**.

### Tests

```bash
npm test                                                  # full suite
node --import tsx --test src/tests/math.test.ts           # a single file
node --import tsx --test --test-name-pattern "impermanent" src/tests/math.test.ts
```

---

## How the numbers are produced

These are the figures the dashboard reports, and how they are derived. Read this before trusting
any of them.

**Position notional** is fixed at entry: `virtual_sol_amount × SOL/USD price at entry`. If the
SOL price is unavailable the engine refuses to open a position rather than guess a size.

**Fee yield** is accrued per monitor tick:

```
fee += notional × poolFeeTvlRatio24h × (hoursElapsed / 24)      … only while in range
```

This is a **pool-level approximation and a conservative lower bound**. Without per-bin liquidity
depth there is no way to model the concentration multiplier that makes a tight DLMM range earn
more than its pro-rata share, so a concentrated range is *not* credited with extra fees here.
A position that drifts out of range accrues nothing, matching real DLMM behaviour.

**Impermanent loss** uses the standard constant-product formula against holding:

```
IL_fraction = 2·√r / (1 + r) − 1        where r = currentPrice / entryPrice
```

**Net PnL** = accrued fees + impermanent loss (IL is negative or zero). IL and fees are kept as
independent terms, which is why the notional is *not* re-marked as price moves — doing so would
double-count the price change.

> **Known issue — the live engine's PnL understates real losses.** `impermanentLossFraction`
> measures how far the LP trailed *holding* the two tokens, not what happened to the capital. Those
> diverge sharply: a token that halves gives **-5.7% against holding but -29.3% against capital**.
> The backtest was fixed to use `lpValueReturnFraction` (`sqrt(r) - 1`), which is the number that
> actually moves an account balance; the live engine in `dlmmTraderAgent.ts` still reports the
> divergence figure as `realized_pnl_usd`. Switching it is a one-line change, but it redefines every
> historical row, so it is left as an explicit decision rather than applied silently.

**Win rate** is computed over closed trades by realised PnL sign; a break-even trade counts as a
loss, not a win.

**Max drawdown** is the largest peak-to-trough decline of the realised equity curve, which starts
at `STARTING_BALANCE_USD` and steps once per closed trade in close order. Open positions are
excluded deliberately: including floating PnL would make the figure jump on every poll and stop
being reproducible from stored history.

**Profit factor** is gross profit ÷ gross loss over closed trades. It is `null` — not `0`, not
`Infinity` — when the ratio is undefined (no closed trades, or no losing trades yet); the dashboard
renders that as `∞` or `—` rather than as a measurement.

### Fee/TVL units — a live trap

The upstream `fee_tvl_ratio.24h` field is expressed in **percent** (`0.4877` means 0.4877%), while
`MIN_FEE_TVL_RATIO=0.008` is a **ratio** (0.8%). Comparing them directly would pass essentially
every pool. `src/services/meteora.ts` therefore computes the ratio itself as `fees.24h / tvl` and
never uses the upstream field. Do not "simplify" that.

`MAX_FEE_TVL_RATIO` (default `2.0`) rejects pools reporting an implausible 24h fee/TVL — live data
really does contain pools at 300%+, almost always a collapsed TVL denominator rather than real
yield. Without the ceiling they dominate the `(fee/TVL) × volume` ranking.

### Anti-rug screen

Runs **before** any candidate reaches the LLM, on the non-quote leg of the pair (a SOL-USDC pool
has no rug surface and passes automatically).

| Rule | Env | Default |
|---|---|---|
| Top 10 holders below | `ANTIRUG_MAX_TOP10_HOLDER_PCT` | 25% |
| Mint authority revoked | `ANTIRUG_REQUIRE_MINT_REVOKED` | true |
| Freeze authority revoked | `ANTIRUG_REQUIRE_FREEZE_REVOKED` | true |

A check returns one of three verdicts. `PASS` and `FAIL` are decisions; `UNKNOWN` means the check
could not be executed. `ANTIRUG_ON_ERROR` decides what `UNKNOWN` means and **defaults to `reject`
(fail closed)** — a filter that silently passes when it cannot run manufactures confidence that was
never earned. A definitive `FAIL` is never overridable, even under `allow`.

> **You need a paid RPC for this.** The public `api.mainnet-beta.solana.com` node permanently
> rejects `getTokenLargestAccounts` with HTTP 429, so holder concentration always resolves to
> `UNKNOWN` there and — under the default policy — **every candidate is rejected and the engine
> never opens a position.** That is the filter working as designed, not a bug. Point
> `SOLANA_RPC_URL` at Helius/Triton/QuickNode, or set `ANTIRUG_ON_ERROR=allow` if you accept
> trading unscreened pools. Mint/freeze authority checks do work on the public node.

Caveat on the concentration number: `getTokenLargestAccounts` returns raw SPL token accounts, so a
pool vault, a CEX omnibus wallet or a vesting contract each count as one "holder". A high reading
is evidence to investigate, not proof of a rug.

### Priority fee estimation

`getPriorityFeeEstimate()` samples `getRecentPrioritizationFees` (~150 recent slots) and takes the
`PRIORITY_FEE_PERCENTILE` (default p75) — most slots report zero, so a mean would collapse to zero
and a max would chase outliers. Total = priority portion (`µlamports/CU × PRIORITY_FEE_COMPUTE_UNITS
÷ 1e6`) + the 5000-lamport base signature fee.

The round-trip estimate (open + close) is recorded on each position as `est_gas_cost_usd` and fed
into the LLM prompt so it can reject pools whose fee income cannot clear the cost.

> **Gas is recorded, not deducted.** `realized_pnl_usd` stays fees + IL. Subtracting gas would
> silently change what every existing PnL figure means. An unavailable estimate is stored as
> `null`, never `0` — "unknown" and "free" are different claims.

### Exit triggers, in priority order

1. **Out of range** — price left `[lower, upper]`; the position stopped earning.
2. **Take profit** — net PnL ≥ `TAKE_PROFIT_PCT`.
3. **Stop loss** — net PnL ≤ `STOP_LOSS_PCT`.
4. **Max age** — held longer than `MAX_POSITION_AGE_HOURS`.

> **Known behaviour:** with the default `STOP_LOSS_PCT=-8` and typical bin ranges, the stop-loss is
> nearly unreachable. Impermanent loss inside a ±10% band is under 0.2% of notional, so price
> leaves the range and triggers rule 1 long before net PnL reaches −8%. Expect exits to be
> dominated by `OUT_OF_RANGE` and `TIMEOUT`. Tighten `STOP_LOSS_PCT` toward −1 if you want it to
> bind.

---

## Data sources

| Source | Used for | Notes |
|---|---|---|
| `dlmm.datapi.meteora.ag/pools` | Pool screening + position marks | The PRD's `dlmm-api.meteora.ag/pair/all_by_groups` is **dead (404)**; this is the current host. |
| Solana RPC (`SOLANA_RPC_URL`) | Priority fees, mint/freeze authority, holder concentration | `getTokenLargestAccounts` needs a paid provider — see the anti-rug section |
| `api.alternative.me/fng` | Fear & Greed | |
| `api.coingecko.com` | Global market cap, dominance, spot prices | Public tier, rate-limited |
| `api.dexscreener.com/token-boosts/top/v1` | Trending tokens | Carries no ticker symbol; the first word of the description is used |
| `api.stlouisfed.org` (FRED) | DXY, US 10Y, S&P 500 | Optional, needs a free key |

**Not available:** BTC/ETH spot ETF net flows. Farside — the PRD's source — returns HTTP 403 to
programmatic clients. Rather than fabricate the number, these fields stay `null` and every gap is
listed in the prompt as `UNAVAILABLE` with an explicit instruction not to invent values.

---

## Layout

```
src/
  config/     env.ts (Zod-validated), constants.ts (cron, endpoints, thresholds)
  database/   db.ts (SQLite + auto-migration), schema.sql, repositories.ts (all SQL)
  services/   meteora.ts (screener + position maths), deepseek.ts, marketData.ts,
              solana.ts (RPC: priority fees, mint authorities, holder concentration),
              metrics.ts (drawdown, profit factor), telegram.ts, http.ts (retry/soft-fail)
  agents/     researcherAgent.ts, dlmmTraderAgent.ts, postMortemAgent.ts, snapshotJob.ts
  api/        server.ts
  scripts/    manual triggers, demo seed, smoke test
  tests/      math.test.ts, lifecycle.test.ts
dashboard/    Next.js app (own package.json)
docs/prd/     the original PRD chapters
```

All SQL lives in `repositories.ts`; the API and the agents share it rather than each writing their
own queries.

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/overview` | KPI card data: equity, balance, floating PnL, today's realised, win rate, max drawdown, profit factor |
| `GET /api/positions/active` | Open simulated positions |
| `GET /api/positions/history?limit&offset` | Closed trades |
| `GET /api/positions/:id` | One position |
| `GET /api/pnl-calendar?month=YYYY-MM` | Per-day PnL for the calendar heatmap |
| `GET /api/research/latest`, `/api/research/history?limit` | Macro briefs |
| `GET /api/health` | Liveness + dry-run flag |

The calendar aggregates live from closed trades rather than reading `daily_pnl_snapshots`, so
today's PnL appears before the nightly snapshot job writes its row.

`currentBalanceUSD` is a **simulation baseline** (`STARTING_BALANCE_USD = 1000` in `server.ts`)
plus realised PnL. It is not a custodial balance.
