# Incident 2026-09-10 — engine command bot could not hold a getUpdates session (409 Conflict) — **RESOLVED**

**Status:** RESOLVED 10 Sep 2026 ~20:05 WIB (re-verified 22:33 WIB, 0 failures).
**Severity:** major — the operator had no Telegram kill-switch for ~2 days (real-money engine).
**Root cause class:** credential resolution — a leaked **process-env** token shadowing the correct `.env` value.

> This file supersedes `2026-09-10-bot-poll-conflict-unresolved.md` (same git object, renamed).
> Everything in that version that pointed at an *external poller* is **retracted** — see "Retracted hypotheses".

## Symptom

Engine log, every ~60 s, from 9 Sep through 10 Sep ~20:00 WIB:

```
bot launch failed: 409 Conflict: terminated by other getUpdates request
```

Measured kill interval: the poll was launched and then killed **~22 s later**, consistently
(`~/.hermes/scripts/diag/fm_timing.sh`). The engine itself was healthy — only the command bot died.

## Root cause

`pm2` had been started **from a Hermes agent shell**. The Hermes session environment leaked into the
app's process env, including Hermes' own `TELEGRAM_BOT_TOKEN` (= `@hermezemiz_bot`, sha8 `9d529965`).
`dotenv` does **not** override variables that already exist in `process.env`, so the process kept the
Hermes token even though `.env` on disk held the correct engine token (`@zemiztradebot`, sha8 `76e2d325`).

Consequence: the engine was polling **Hermes' own bot** every ~22 s, stealing its own gateway's
`getUpdates` lease → 409 → `bot launch failed` → retry ~60 s. It also means the engine's alerts were
being **sent from the Hermes bot**, not from the trading bot.

This explains why **two token rotations were no-ops**: they edited `.env`, never the process env.

## Evidence (all re-runnable; no secrets printed — sha8 fingerprints only)

| Probe | Result |
|---|---|
| `diag/fm_env_token_check.py` | running process token sha8 = `9d529965`; `.env` token sha8 = `76e2d325` |
| `diag/fm_confirm_root_cause.py` | `getMe` on the **process** token → `@hermezemiz_bot` |
| `diag/fm_raw_poll_probe.py` | raw long-poll with the `.env` token → HTTP 200, survives full 25 s |
| `diag/fm_hold_lease.py` | 5 × 50 s held with the `.env` token → clean, no interruption |
| `diag/fm_node_poll.mjs` | same fetch path as the engine (undici): 3/3 clean 50 s |
| `diag/fm_lease_semantics.py` | two concurrent `getUpdates` → **the later request wins**, the earlier dies with 409 |
| `diag/fm_find_poller.sh` | only ONE process holds Telegram connections: the engine itself |
| `diag/fm_packet_watch.sh` | no third-party TCP connection at the t+22 s kill |

Lease semantics is the key inference: the killer must be a *more recent* poller. A more recent poller
using a *different* token can only be a second poller **inside the same process** → the process env.

## Fix (applied 10 Sep 2026, `--go`)

`~/.hermes/scripts/diag/fm_fix_bot_token.py`

1. Backs up the app's **entire process env (90 vars)** to `~/.hermes/cache/fm_engine_env_backup.json` (mode `0600`).
2. Restarts the pm2 app with **only `TELEGRAM_BOT_TOKEN` overridden** — node 22 absolute path, cwd, `PATH`, `SSL_CERT_FILE` and every other var preserved verbatim.
3. `pm2 save`.

Default mode is **DRY RUN**; `--go` executes; `--rollback` restores the backup in <30 s.

**Verification:** `diag/fm_verify_bot_fix.sh` → **0 × `bot launch failed` over 150 s** (was dying every ~22 s),
process token `getMe` = `@zemiztradebot`, equity pinned, 0 positions. Re-checked at 22:33 WIB: 0 hits in the
last 200 log lines.

## Retracted hypotheses (do NOT re-litigate)

- ❌ **"There is an external poller / a second engine instance on the token."** Killed by the 50 s held-lease tests (raw HTTP *and* node/undici, 8/8 clean) with the `.env` token.
- ❌ **"The Hermes↔engine bridge is stealing the lease."** Killed by pausing bridge cron `68814bf47ff2` for 4 min → still 409.
- ❌ **"`.env` has the wrong token."** Wrong *layer*: the file was correct; the **process env** was wrong.

## Rules that follow (still binding)

1. **Never start the pm2 app from a Hermes agent shell** — the Hermes session env leaks in. Start it from a clean login shell, or reuse the fixer script's env-override pattern.
2. **`dotenv` never overrides `process.env`.** A `.env` edit can be a silent no-op. Always verify the token the **running process** uses (sha8 + `getMe`), never the file.
3. **Never rotate a credential before proving which value the process actually reads.** Two rotations were wasted here.
4. Side finding (non-blocking): the engine process env also carried `BUFFER_ACCESS_TOKEN`, `THREADS_API_TOKEN`, `HERMES_DEEPSEEK_API_KEY`, `HERMES_SESSION_KEY` (values redacted). Harmless but should be stripped on a future restart.

## Related

- `2026-09-10-claude-handoff-prompt.md` (fix pack `8aa3379`, `289099f`) — retries + file-based pause control.
- Watchdog follow-up: the 15-min "bot dead" alerts were a **separate** issue (watchdog cron spamming), fixed by dedupe-to-6h + alert-on-status-change only (`~/.hermes/scripts/fm_live_watchdog.sh`).
