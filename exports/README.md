# FlowMetrix — Exported Trading Data

Paper-trading data (DRY_RUN only) exported from `data/flowmetrix.db` so it can live in git
and be analyzed without shipping the raw SQLite file. **This is simulated data — no real
money was ever deployed.**

## Files

| File | Contents |
|---|---|
| `trades.csv` | Every simulated position: entry/exit prices, bin range, fees, IL, realized PnL, close reason, safety verdict, post-mortem notes, **`engine_version`** (v1.0 / v1.1 / …). 38 columns. |
| `daily_pnl.csv` | Daily PnL snapshots. |
| `research_logs.json` | Daily macro research reports (full markdown + sentiment bias RISK-ON/OFF/SIDEWAYS + raw snapshot). |
| `summary.json` | Quick glance: totals, win/loss counts, net PnL, **`perVersion` breakdown**, exported timestamp. |

## Engine version labels

Every trade is tagged `engine_version` by the same rule the engine's cohort filter
uses (`src/services/cohort.ts`): membership is decided by **`opened_at` vs the
`ENGINE_V*_CUTOFF` env vars** — never `closed_at`. The cohort names the engine that
made the ENTRY decision; a position the old screener picked stays v1.0's trade
however long it took to close.

- v1.1 cutoff: `ENGINE_V11_CUTOFF` (default `2026-08-29T13:20:40Z`, when the
  anti-churn gates + 60s exit monitor went live)
- Future versions: add `ENGINE_V12_CUTOFF=...` etc. to `.env` — the exporter picks
  them up automatically (no script edit needed).
- `summary.json → perVersion` gives one-glance results per version.

## Key columns in trades.csv

- `status`: `ACTIVE` / `CLOSED_PROFIT` / `CLOSED_LOSS` / `CLOSED_OUT_OF_RANGE`
- `realized_pnl_usd`: fees + position value change (gas is recorded in `est_gas_cost_usd`, not deducted)
- `breakeven_coverage_ratio`: 24h fee estimate ÷ round-trip cost — positions only open when ≥ 2.5x
- `safety_verdict`: anti-rug screen result (`PASS` / `FAIL` / `UNKNOWN` — UNKNOWN is rejected)
- `close_reason`: e.g. `take-profit`, `stop-loss`, `Price left the bin range`
- `post_mortem`: model's own lesson after each close

## How to refresh

```bash
source ~/.nvm/nvm.sh && nvm use 22   # better-sqlite3 needs node v22
node exports/export_data.cjs          # run from repo root
git add exports && git commit -m "chore: refresh exported trading data" && git push
```

The SQLite DB itself stays gitignored (`data/`, `*.db`) — it is the source of truth,
these exports are snapshots.

## Auto refresh (nightly)

A cron job (`~/.hermes/scripts/flowmetrix_export_cron.sh`, runs nightly 22:00 WIB,
no_agent = 0 LLM tokens) re-exports and pushes the data every night, unconditionally.
You get a short confirmation in Telegram each time it runs.
