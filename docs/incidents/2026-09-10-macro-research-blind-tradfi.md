# Incident note — 10 Sep 2026: macro research has no cross-asset inputs (FRED key empty)

Found while backfilling the missed `research:once` run (engine was paused 06:17–08:05 WIB for
the deploy, so the 07:00 WIB daily research was skipped; re-run manually at 14:00 WIB, logged
as `daily_research_logs.id = 7`, bias RISK-OFF).

## Symptom

Every research run reports the same five gaps:

```
[researcher] missing inputs: DXY, US 10Y yield, S&P 500, BTC spot ETF net flow, ETH spot ETF net flow
```

and the report body says so explicitly ("DXY, US 10Y Treasury yield, and S&P 500 are
UNAVAILABLE ... BTC/ETH spot ETF net flow: UNAVAILABLE"). Not new: `daily_research_logs`
rows for 8, 9 and 10 Sep all carry the identical gaps, so sections 1 (Macro & Geopolitics)
and 2 (Institutional & On-Chain Flows) of the daily research have **never** had real data.

## Root cause (verified, not guessed)

- `FRED_API_KEY=` in `~/flowmetrix-ai-agent/.env` line 77 is present but **EMPTY**
  (`awk` reports `value_len=0`). `fetchTradFiMacro()` (`src/services/marketData.ts:394`) reads
  that env var and only calls FRED when it is non-empty, so `dxy`, `us10yYieldPct`, `sp500`
  stay `null` and get pushed into `unavailable`.
- Direct probe of the FRED endpoint with the (empty) key returns
  `HTTP 400: "The value for variable api_key is not a 32 character alpha-numeric lower-case string"`
  — confirms the key is missing, not a network/FRED outage.
- BTC/ETH spot ETF net flow is a **known unsupported** input by design:
  `marketData.ts:423-424` unconditionally pushes both into `unavailable` with the comment
  "No keyless programmatic source; Farside blocks non-browser clients (HTTP 403)."

## Impact

The research agent is NOT fabricating numbers (good — the nullable fields + explicit gap list
work as intended), but its macro read is effectively crypto-internal only (Fear & Greed, total
market cap, dominance, price action). Any "RISK-ON/RISK-OFF" verdict is derived without DXY,
the 10Y, the S&P or institutional flows. The daily bias feeds the engine's context, so this is
a quality gap in the decision layer, not a crash.

## Fix (cheap, no code change needed for 3 of 5 inputs)

1. Create a free FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html, 30 s) and set
   `FRED_API_KEY=<32-char key>` in `.env` — populates DXY (`DTWEXBGS`), US 10Y (`DGS10`),
   S&P 500 (`SP500`). `.env` change takes effect on the next engine restart (Hermes writes the
   file; restart = pause → start, with user approval).
2. ETF flows are a separate, optional project: needs a scraping/browser-capable source or a paid
   feed. Do NOT fabricate; leaving them in `unavailable` is correct until a real source exists.

## Do NOT change

The nullable-field + `unavailable` design in `marketData.ts` — it is what keeps the model honest.
