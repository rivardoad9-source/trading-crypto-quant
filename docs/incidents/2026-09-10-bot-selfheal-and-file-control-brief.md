# Fix brief — 10 Sep 2026: bot self-heal + file-based engine control

Two small changes that remove the single points of failure the 10 Sep 2026 incident exposed.
Engine is RUNNING (flat). Deploy = stop → build → start, Hermes does it after user approval.

## Context: what actually broke

Every engine boot logged `[telegram] bot launch failed: TelegramError: 409: Conflict:
terminated by other getUpdates request`. Telegraf's `launch()` rejects on that error and
`startTelegramCommands()` has no retry, so **the command bot is dead for the whole boot**:
`/pause`, `/resume`, `/close_all`, `/status` all unresponsive — the operator kill-switch.
Root cause is an EXTERNAL poller holding the same bot token (ruled out on the server:
single engine process, no docker, no other users, distinct tokens vs Hermes/News bots, no
webhook). Nothing in this repo caused it and nothing in this repo can fix the poller — but
the engine should not lose its kill-switch because of it, and the kill-switch should not
depend on Telegram polling at all.

## Why there is no workaround in the current build (verified 10 Sep 2026, 14:00 WIB)

- **Pause state is IN-MEMORY and Telegram-only.** `src/services/engineControl.ts` is 19 lines:
  `let paused = false` + `isEnginePaused()` / `setEnginePaused()`. Its own header comment says
  the store is deliberately not persisted. So while the bot cannot poll, **there is NO way to
  hold new entries from outside the process** — no file, no HTTP route (`src/api/server.ts`
  exposes GET routes only: `/api/health|wallet|overview|positions*|research*|funnel|reconciliation|analytics`).
  Restarting the engine resets pause to RUNNING; `pm2 stop` is NOT an acceptable substitute
  (it kills monitoring of open positions and can strand a mid-cycle swap — 9 Sep lesson).
- **Interim mitigation that exists today (Hermes-side, entry-only):** the news-blackout gate
  (commit d1420c7) reads `data/news_blackout.json` before `seekNewEntry`. Appending an ad-hoc
  window to `~/.hermes/scripts/news_blackout_manual.json` and running
  `~/.hermes/scripts/news_blackout_write.py` (NewsAgent venv python) makes the engine skip new
  entries within one cycle (~30 min) while monitoring/fees/closes keep running. Verified
  10 Sep 14:01 WIB (manual window merged, `source: "manual"`, cleaned up afterwards). This is
  a brake on ENTRIES — it is **not** a replacement for `/close_all`.
- **Only the receive side is dead.** Alert delivery still works (the bot sends), so the
  watchdog keeps reaching the operator. The missing capability is command intake, i.e. exactly
  the kill-switch this brief removes the Telegram dependency from.

## Feature A — bot launch retries with backoff (self-healing)

`src/services/telegramCommands.ts` (~484-497): replace the single
`bot.launch().catch(...)` with a retry loop:

- On rejection, log `[telegram] bot launch failed (attempt N): <err>` then retry after
  backoff 5s, 15s, 30s, then every 60s (indefinite — a kill-switch must come back on its
  own the moment the conflict clears).
- On success, log `[telegram] command bot started (long-polling, attempt N)`.
- `stopTelegramCommands()` must cancel any pending retry timer and prevent further
  retries (`stopped` flag), and must not throw when the bot never launched.
- Keep the existing "readiness logged immediately, launch() never resolves" semantics for
  the success path — do not await launch() in the boot path.
- Tests (mock the bot's launch): rejects 2x then resolves → asserts retries with the
  documented delays and a final started state; stop() during backoff → no further attempts.

## Feature B — file-based engine control (kill-switch independent of Telegram)

Mirror the news-blackout file pattern. New `data/engine_control.json`:

```json
{ "paused": true, "reason": "operator: news window", "updated_at": "2026-09-10T11:00:00Z" }
```

- Read once per cycle (same place the news blackout is read, inside `isLiveExecutionActive()`
  so PAPER stays byte-identical). `paused: true` behaves EXACTLY like a Telegram `/pause`:
  skip `seekNewEntry`, keep monitoring/fees/closes.
- Sources are INDEPENDENT and reported separately: Telegram `/pause` and the control file
  each hold entries still on their own; `/resume` must NOT clear a file pause.
  Log which source(s) are holding entries, e.g.
  `[control] entries held: file (operator: news window); telegram: running`.
- Failure handling, and it is deliberate: file ABSENT → not paused. File present but
  unreadable/unparseable → **treat as PAUSED** + warn every cycle (an operator asked for
  something and we cannot read it; skipping entries is the conservative choice, and the
  warning is loud). A `paused: false` with an unparseable rest of the object is still a
  readable instruction.
- Expose in `GET /api/overview` and the shared `/status` payload:
  `control: { pausedByTelegram: bool, pausedByFile: bool, fileReason: string | null }`.
- The path comes from env `ENGINE_CONTROL_FILE` (default `data/engine_control.json`).
- Tests: absent → running; `paused: true` → entries skipped, monitoring untouched;
  unparseable → paused + warning; `/resume` does not clear a file pause; paper byte-identical.

## Do NOT change

Risk gates (friction/breakeven, anti-rug, volatility, cooldowns, width cap), strategy
parameters, env guardlocks, `POOL_DENYLIST`, the news-blackout semantics, Telegram command
authorization (owner-only, unchanged).

## Verify

- `source ~/.nvm/nvm.sh && nvm use 22 && npm run build && npm test` (armed server: the 7
  known env-assertion failures; unarmed = clean). `npm run typecheck` must stay clean —
  keep one-off helpers OUT of `scripts/*.ts`.
- Manual: write `data/engine_control.json` with `paused: true`, confirm the cycle logs the
  hold and skips entries, then remove it and confirm entries resume. Do NOT restart the
  live engine to test; the file is read per cycle.

Commit: `feat(engine): bot launch retries + file-based pause control (kill-switch resilience)`
