# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
