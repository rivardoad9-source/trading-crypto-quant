# Claude Code handoff — 10 Sep 2026 (prompt text)

Copy the block below into Claude Code. Source of truth for every claim is
`docs/incidents/` at the commit this file landed in.

---

```
FlowMetrix engine — three deferred fixes (10 Sep 2026). Work READ-ONLY on the repo; Hermes owns the deploy.

Repo: ~/flowmetrix-ai-agent (branch main, at/after e930184). READ FIRST:
  - docs/incidents/2026-09-10-bot-selfheal-and-file-control-brief.md   <- Tasks 1+2 in full
  - docs/incidents/2026-09-10-half-landed-open-unmonitored-position.md <- Task 3, see "Partial answer"
  - CLAUDE.md (authoritative architecture + correctness constraints)

CONTEXT THAT MATTERS
- The engine is LIVE (DRY_RUN=false, ONCHAIN_EXECUTION_ARMED=true) and currently FLAT.
  Never restart or pm2-stop it; Hermes deploys after user approval (pause -> build -> start).
- The Telegram command bot is DEAD on every boot with `409 Conflict: terminated by other
  getUpdates` (an EXTERNAL poller holds the token — nothing server-side can fix that).
  Consequence: /pause, /resume, /close_all, /status are ALL unusable, and
  src/services/engineControl.ts holds pause state in memory only (19 lines, `let paused`),
  so there is NO way to hold new entries from outside the process today.
  Alert DELIVERY still works; only command intake is dead.

TASK 1 — bot launch retries with backoff (self-heal)
  File: src/services/telegramCommands.ts (~484-497).
  Replace the single bot.launch().catch(...) with retries: on rejection log
  `[telegram] bot launch failed (attempt N): <err>`, retry after 5s, 15s, 30s, then every 60s
  indefinitely; on success log `[telegram] command bot started (long-polling, attempt N)`.
  stopTelegramCommands() must cancel the pending timer, set a `stopped` flag, and not throw
  when the bot never launched. Keep the "readiness logged immediately, launch() never resolves"
  success semantics — do not await launch() in the boot path.
  Tests: launch rejects twice then resolves -> asserts documented delays + started state;
  stop() during backoff -> no further attempts.

TASK 2 — file-based engine control (kill-switch independent of Telegram)
  Mirror the news-blackout file pattern. New file: data/engine_control.json
    { "paused": true, "reason": "operator: news window", "updated_at": "2026-09-10T11:00:00Z" }
  - Read once per cycle in the SAME place the news blackout is read, inside
    isLiveExecutionActive() so PAPER stays byte-identical. `paused: true` behaves EXACTLY like
    a Telegram /pause: skip seekNewEntry, keep monitoring/fees/closes running.
  - The two sources are INDEPENDENT and reported separately: /resume must NOT clear a file
    pause. Log which source(s) hold entries, e.g.
    `[control] entries held: file (operator: news window); telegram: running`.
  - Failure handling is deliberate: file ABSENT -> not paused. File present but
    unreadable/unparseable -> treat as PAUSED and warn loudly EVERY cycle (an operator asked
    for something we cannot read; skipping entries is the conservative choice). A readable
    `paused: false` with an unparseable rest is still a readable instruction.
  - Expose in GET /api/overview and the shared /status payload:
    control: { pausedByTelegram: bool, pausedByFile: bool, fileReason: string | null }
  - Path from env ENGINE_CONTROL_FILE (default data/engine_control.json).
  - Tests: absent -> running; paused: true -> entries skipped, monitoring untouched;
    unparseable -> paused + warning; /resume does not clear a file pause; paper byte-identical.

TASK 3 — a benched pool got a second live attempt, and the second post-swap failure recorded no strike
  Evidence (verified 10 Sep 2026, DB + on-chain blockTime; full table in
  docs/incidents/2026-09-10-half-landed-open-unmonitored-position.md -> "Partial answer"):
  - pool_execution_failures for pool nBXytBBfKLhj6teXarAv8rk6WNgUFBMyybUFRkuK7ad:
    consecutive_failures 1, total_failures 1, last_stage "open", last_failure_at 02:02:49 WIB,
    last_reason = the WIDE "landed 2 of its transactions" error.
  - attempt #1 balancing swap (77 bins) landed 02:01:55 WIB; attempt #2 (27 bins, narrower,
    different screener cycle) landed 02:32:08 WIB — i.e. ~29 min AFTER the immediate bench.
  - attempt #2 failed post-swap (`the balancing swap CONFIRMED but the position open failed`;
    `the swap confirmed but no token balance could be read`) and did NOT increment the counter.
  - Later cycles DO show `[guard] skipped KNOTS-SOL: 1 on-chain execution failure AFTER the
    balancing swap spent (one is enough to bench)`, so the guard works once it sees the strike.
  Determine, with log/DB/code evidence, and report:
  (a) why the 02:32 cycle reached a live attempt on an already-benched pool
      (candidate list built before the strike? filter keyed per pool while the candidate came
      from a sibling pool of the same token? retry path that skips the breaker?);
  (b) why a post-swap failure did not record a strike (which `stage`/error classes increment
      `consecutive_failures`; the narrow fused path's failure looked like it should count).
  Fix minimally once (a)/(b) are proven — e.g. key the bench at token level if that is the
  answer. Do NOT change gate thresholds to paper over it. If the evidence is inconclusive,
  say so and hand back the exact queries/log lines you need.

TASK 4 (optional, low priority) — make the research blind spot loud
  src/services/marketData.ts: when FRED_API_KEY is empty, `fetchTradFiMacro()` silently
  returns dxy/us10yYieldPct/sp500 = null and the gaps only surface in the researcher's prompt.
  Add a one-line startup/run warning (e.g. `[marketData] FRED_API_KEY unset — DXY/10Y/S&P
  unavailable`). See docs/incidents/2026-09-10-macro-research-blind-tradfi.md. Do NOT fabricate
  values and do NOT change the nullable-field design.

DO NOT CHANGE
  friction/breakeven gates, anti-rug fail-closed, volatility thresholds, cooldowns,
  LIVE_MAX_POSITION_BINS, strategy parameters, env guardlocks, POOL_DENYLIST, news-blackout
  semantics, Telegram authorization. Keep one-off helpers OUT of scripts/*.ts.

VERIFY
  - source ~/.nvm/nvm.sh && nvm use 22 (node v26 breaks better-sqlite3: ERR_DLOPEN_FAILED).
  - npm run build, npm run typecheck clean; npm test on an UNARMED checkout must be 100% clean.
    On the ARMED server the suite is NOT clean and that is expected: baseline 10 Sep 2026
    14:05 WIB = 644/651 pass, 7 fail (the armed-machine set that asserts the live profile is
    INERT — shipped defaults, execution guard operator width cap, engine cannot reach it,
    status report, V1.1 baseline baseline, +2 nested). Identical with and without code changes:
    NOT regressions. Regenerate the exact list with `npm test 2>&1 | grep 'not ok'`.
  - Do NOT run `pm2 --update-env`. Do NOT restart the live engine to test Task 2 — the control
    file is read per cycle; verify by writing data/engine_control.json and watching the log.
  - Commit suggestion: feat(engine): bot launch retries + file-based pause control + bench hardening
```
