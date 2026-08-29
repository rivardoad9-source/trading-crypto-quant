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
npm run sweep            # grid-search the risk guardrails against the cached dataset
npm run audit:report     # backtest JSON -> reports/backtest-audit.html (print to PDF)
npm run backtest         # 30-day replay of the live formula; --days --pools --refresh --tp etc.
npm run dlmm:once        # one screen -> decide -> monitor cycle
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
- `src/index.ts` — cron schedulers wrapped in `withLock`. Overlapping ticks would double-accrue fees
  on the same interval; keep the lock.

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

**Undefined metrics stay null.** `profitFactor` is null when there are no losing trades; returning
`Infinity` or `0` would render on the dashboard as a real measurement. Max drawdown runs over the
realised curve only — adding floating PnL would make it non-reproducible from history.

## Known behaviour, not a bug

With `STOP_LOSS_PCT=-8` and typical bin ranges the stop-loss is nearly unreachable: IL inside a ±10%
band is under 0.2% of notional, so price exits the range and fires `CLOSED_OUT_OF_RANGE` first.
Exits are dominated by out-of-range and timeout.

## Source of truth

`docs/prd/` holds the original PRD chapters. Two of its specifics are stale and were corrected
during the build — the Meteora endpoint (`dlmm-api.meteora.ag/pair/all_by_groups` is 404; use
`dlmm.datapi.meteora.ag/pools`) and Farside as an ETF source. `README.md` documents the derivations
of every reported number.
