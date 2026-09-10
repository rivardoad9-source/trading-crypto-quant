# Fix brief — 10 Sep 2026: news-aware entry blackout (FlowMetrix × NewsAgent)

Status: ENGINE IS RUNNING (flat, 0 positions) and must stay untouched until this lands.
Deploy later = stop → build → start (Hermes handles the server side; the user approves).

The calendar file already exists and is being refreshed by a Hermes cron:
`/home/ubuntu/flowmetrix-ai-agent/data/news_blackout.json`
(written from the NewsAgent BLS/FOMC forward calendar by
`~/.hermes/scripts/news_blackout_write.py`; windows = release −60 min → +45 min;
optional ad-hoc windows come from `~/.hermes/scripts/news_blackout_manual.json`).

## Feature: skip NEW entries while a high-impact news window is open

Why: the strategy is DLMM fee-farming with narrow ranges (27–95 bins ≈ 1–2% wide).
Around US releases (CPI/PPI/NFP/FOMC) a 1–3% spike in the first minutes pushes the
position out of range instantly — fees stop, IL keeps running — and the entry itself
is fragile (10 Sep 2026: an open on a pumping pool half-landed and left a funded
position unmonitored for 4h; the fixed recovery now closes such orphans, but the
slippage cost is still real). The engine has no news awareness today: it would happily
enter 10 minutes before PPI if a candidate clears the gates.

### Required changes (minimal; no risk-gate changes)

1. **Read the blackout file each cycle** (before `seekNewEntry`, mirroring where the
   `LIVE_MAX_POSITION_BINS` filter lives — i.e. inside `isLiveExecutionActive()` so
   PAPER mode stays byte-identical, per CLAUDE.md; add a test asserting that).
   - Env: `NEWS_BLACKOUT_FILE` (default `data/news_blackout.json`, resolved like the
     other data paths), `NEWS_BLACKOUT_ENABLED` default `true`.
   - Parse `windows[].start_utc` / `end_utc` (ISO 8601 UTC). Now ∈ [start, end) → in
     blackout.
   - **Fail-open, loudly**: missing/unparseable file → normal operation + a warn line.
     File whose `generated_at` is older than **48 h** → ignored (a stale calendar must
     not silently freeze trading) + warn. Never throw from this path.
   - Log once per cycle when active:
     `[news] blackout: PPI until Thu 10 Sep 2026 20:15 WIB — skipping new entries (monitoring continues)`
2. **Behaviour = exactly engine-paused for ENTRIES only**: skip `seekNewEntry`; keep
   monitoring, fee accrual, and closes fully active. Do NOT touch the pause/resume
   command state or `engineControl` semantics (a Telegram `/pause` and a news blackout
   are independent reasons to skip entries; the engine should log which one applied).
3. **Expose it**: add `newsBlackout: { event, untilWib } | null` to `GET /api/overview`
   (and the Telegram `/status` payload, same shared payload) so the pre-news briefing
   job and the dashboard can show "engine: blackout until 20:15 WIB".
4. **Tests** (`src/tests/`): window parsing incl. boundaries (start inclusive, end
   exclusive), stale >48 h ignored, missing file ignored, manual-source windows
   respected, paper-mode byte-identical assertion. Keep the whole suite green
   (armed server runs 442/446→ by design; unarmed checkout = clean).

### Do NOT change

Friction/breakeven gates, anti-rug fail-closed screens, volatility thresholds,
cooldowns, `LIVE_MAX_POSITION_BINS`, strategy parameters, env guardlocks,
`POOL_DENYLIST`, the pause/resume command semantics. Follow CLAUDE.md.

### Verify

- `source ~/.nvm/nvm.sh && nvm use 22 && npm run build` (never node v26; never
  `pm2 --update-env`); `nvm use 22 && npm test`.
- Manual check without touching the engine:
  `node --import tsx -e '…'`-style unit run of the new gate, or point
  `NEWS_BLACKOUT_FILE` at a fixture and assert the log line.

Commit message suggestion:
`feat(live): news blackout gate — skip new entries during CPI/PPI/NFP/FOMC windows`
