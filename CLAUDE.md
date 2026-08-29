# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run dlmm:once        # one screen -> decide -> monitor cycle (monitor included)
npm run research:once    # one macro research run
npm run smoke            # probe every external API, print screener output + rejection counts
npm run seed:demo        # demo positions marked [DEMO]; npm run db:reset clears everything
```

`npm install` on npm 11+ blocks native install scripts. After installing, run
`npm approve-scripts better-sqlite3 esbuild` or `better-sqlite3` won't build and `tsx` won't run.

Dashboard commands must run inside `dashboard/` (or via the `dashboard:*` root scripts) — it has
its own `package.json`, `node_modules`, and its own git repo created by `create-next-app`.

## Architecture

Data flows one way: **external APIs → agents → SQLite → REST API → dashboard**. The dashboard is a
read-only view and holds no trading logic.

- `src/config/env.ts` — Zod-validated env, parsed once at import. Placeholder values matching
  `/^(your_|<|changeme|...)/` count as unset, so a stale `.env.example` value doesn't read as
  configured. **Boot fails if `DRY_RUN=false`** — live execution is unimplemented and must not be
  half-armed.
- `src/database/repositories.ts` — every SQL statement in the project. Agents and the API share it;
  don't write queries elsewhere.
- `src/database/db.ts` — `initDatabase()` applies `schema.sql` then runs `addColumnIfMissing`
  migrations. Add new columns there, not by editing `schema.sql` alone, or existing databases break.
- `src/services/meteora.ts` — pool fetching, screening, and **all position maths** (IL, fee accrual,
  valuation). The agent orchestrates; the maths lives here and is unit-tested.
- `src/services/solana.ts` — JSON-RPC helper: priority-fee estimation, mint/freeze authority,
  holder concentration. Method availability differs by provider (see below).
- `src/services/metrics.ts` — max drawdown and profit factor as pure functions over an ordered PnL
  array, so they are testable without a database.
- `src/services/http.ts` — `getJson` retries 429/5xx and fails fast on 4xx; `getJsonSafe` never
  throws, so one dead upstream can't abort a whole cycle.
- `src/index.ts` — cron schedulers wrapped in `withLock`. Two position-facing clocks: the 60s fast
  monitor (`CRON.FAST_MONITOR`) marks open positions and fires exits; the 10m screener
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
mutate positions: the 60s fast monitor, the 10m screener, and Telegram `/close_all`. Fee
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
