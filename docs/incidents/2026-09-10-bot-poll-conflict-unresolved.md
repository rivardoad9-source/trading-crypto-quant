# Incident (UNRESOLVED) — 10 Sep 2026: engine command bot cannot hold a getUpdates session

Status: **open**. Engine's telegraf-based command bot gets `409 Conflict: terminated by
other getUpdates request` on every launch attempt, indefinitely, while the token is provably
free. A Hermes-side raw-HTTP bridge now provides the phone kill-switch in the meantime
(see "Interim mitigation"). The engine's own bot is still broken.

## Symptom

Every boot, the new retry loop (`launchWithBackoff`, commit 8aa3379) logs:

```
[telegram] bot launch failed (attempt N): Error: 409: Conflict: terminated by other getUpdates request
[telegram] retrying the command bot launch in 5s / 15s / 30s / 60s
```

Attempts keep failing forever (observed up to attempt 7+, 60 s apart). `/pause`, `/resume`,
`/close_all`, `/status` are all unusable.

## Instrumented evidence (all from this host, 10 Sep 2026 ~16:00-16:25 WIB)

Instrumented `node_modules/telegraf/lib/core/network/client.js` (every API call) and
`.../polling.js` (poller start + each getUpdates). Restored afterwards (md5 verified).

1. **One poller per attempt, one request at a time, no overlap.** Per attempt the sequence is
   exactly `getMe` → `deleteWebhook` → `getUpdates`. Nothing else calls the API in between.
2. **Each `getUpdates` is terminated 20-32 s after it is sent**, e.g.
   `getUpdates @ 09:19:00.587` → failure surfaces at `~09:19:27` (attempt 2 starts 5 s later).
3. **With the engine STOPPED the token is free:** a raw long poll
   (`getUpdates?timeout=50&offset=<last+1>`) returns **HTTP 200 after a full 50.5 s with 0
   updates** — twice (15:53 and 16:05). If another client were polling, that call would be
   rejected/terminated.
4. **No other poller exists on this host.** Only one `dist/index.js` process (PM2 id 4, one
   PID), no docker, `ss -tnp` shows a single Telegram socket from the engine plus Hermes' own
   bots, no script anywhere calls `getUpdates` except Hermes' own gateway (different token),
   and a token scan (engine `.env`, `~/.hermes/.env`, `~/.hermes/profiles/*`, NewsAgent,
   lynk receiver, Hermes `state.db`) finds **no duplicate of the engine token**.
5. **Reproduced with a brand-new token.** BotFather revoke twice; the second token was handed
   to exactly one place (the engine `.env`) and still produced 409 on attempt 1 of a fresh
   process (after a 60 s quiet stop). So this is not an external poller and not a stale session
   from the previous holder.
6. **Ruled out by experiment:** skipping telegraf's launch-time `deleteWebhook` (made it a
   no-op) and passing `dropPendingUpdates: true` to `bot.launch()` — both still 409.
7. **A raw-HTTP single poller works.** A hand-written poller (`~/.hermes/scripts/fm_bot_bridge.py`,
   `getUpdates?timeout=25`) held the session for a full 100 s window with **zero 409s while the
   engine was running and failing**.

## What is NOT known

Why Telegram terminates the engine's long poll while the same token, the same host and a raw
HTTP poller behave correctly. Remaining hypotheses (untested):
- something specific to the request telegraf sends (`timeout: 50`, `allowed_updates`
  serialisation, `offset=0` on every boot) that Telegram currently treats as a conflicting
  session;
- interaction with the `deleteWebhook` that telegraf issues immediately before polling;
- a Telegram-side session bookkeeping quirk for this bot id surviving a token rotation.

## Interim mitigation (LIVE now)

`~/.hermes/scripts/fm_bot_bridge.py` + Hermes cron `68814bf47ff2` (`*/2 * * * *`, `no_agent`,
flock-guarded, silent unless it needs to speak). The bridge polls with raw HTTP and translates:

| command | effect |
|---|---|
| `/status` | reads `GET :4000/api/overview`, replies with engine/mode/balance/positions/entry-hold |
| `/pause` | writes `data/engine_control.json` `{"paused": true}` → new entries held, monitoring continues |
| `/resume` | deletes that file → entries resume |
| `/close_all` | **not supported** — replies telling the operator to contact Hermes (needs the engine's on-chain code) |

Owner-only (id 6678941282). On 409 the bridge backs off 8 s and retries, so it never fights the
engine if the engine's poller ever comes back.

## Task for the dev agent

1. Reproduce with the engine's own code path and find the request-level difference vs the
   bridge (try `timeout: 25`, no `allowed_updates`, `offset` handling, a fresh `Telegraf`
   instance per attempt, `bot.stop()` before relaunch).
2. If telegraf cannot be made to hold the session, replace the engine's polling with a
   raw-HTTP long-poll loop (the bridge is a working reference) OR move the command intake to a
   Hermes-side bridge as the permanent design — decide with the operator.
3. **When the engine's bot polls again, retire the bridge cron `68814bf47ff2`** — two pollers
   on one token is exactly the conflict this incident is about.
4. Do not remove `launchWithBackoff`'s retry: it is correct and needed (it recovers
   post-restart 409s within 5-20 s), it just cannot fix *this* failure.
