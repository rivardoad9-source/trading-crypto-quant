# 15 Sep 2026 — five consecutive cycles aborted by a malformed DeepSeek envelope

**Status:** fixed and deployed (commit `a77ede5`, deployed by Hermes 05:11 WIB the same morning)
**Impact:** no entry decision at 02:00, 02:30, 03:00, 03:30 and 04:00 WIB. Zero positions were
open, so monitoring, TP/SL and the wallet were untouched. No SOL spent.

## What the logs showed

`~/.pm2/logs/flowmetrix-engine-error.log`:

```
[dlmm] cycle failed: FetchError: Invalid response body while trying to fetch
  https://api.deepseek.com/chat/completions: Premature close
[dlmm] cycle failed: TypeError: Cannot read properties of undefined (reading '0')
    at structuredCompletion (/home/ubuntu/flowmetrix-ai-agent/src/services/deepseek.ts:200)
    ...
```

repeated four more times, in the 02:00–04:00 WIB window.

`res.choices[0]` — line 200 — was **outside the retry loop**. An envelope without `choices`
therefore escaped `structuredCompletion` as a raw `TypeError`, and the caller
(`seekNewEntry`) treated it as a cycle-ending failure. Nothing in the log named the cause: only
a line number and "reading '0'".

## Fastest detection (no log reading)

`scan_funnel_cycles` has **no row** for those half-hour slots, because the cycle died before the
screener recorded anything. A silent gap between two consecutive `cycle_at` values is the
signature of an aborted decision step — the API and the logs are secondary.

```
select id, cycle_at from scan_funnel_cycles order by id desc limit 6;   -- cycle_at is UTC
```

## Cause

The provider (or the transport) returned a response the OpenAI client accepted but which carried
no `choices`. The first failure of the run was a truncated body (`Premature close`), which points
at the upstream/connection rather than at our request. `firstChoiceOrThrow()` now records
`Object.keys(res)` in the message, so if it recurs the log will say whether the envelope was an
error object (`response keys: error`) or something else.

## Fix (commit `a77ede5`)

1. `firstChoiceOrThrow(res, model)` — exported, validated, tested. Missing choice ⇒ an ordinary
   `Error` naming the model and the response keys. Never a `TypeError`.
2. The provider call **and** the envelope read now sit inside the retry block: a transport error
   or an empty envelope is retried once (with a nudge message), and if it fails twice the cycle
   ends with a normal structured-output failure that names the provider problem.

Kept intact: the fixed reasoning budget (`REASONER_MAX_TOKENS`), the truncation path
(`DeepSeekTruncatedError` ⇒ skip the cycle), and the "no candidate / model declined" outcome.

## Verification

- `npm run typecheck` clean; `npm test` **993/993 pass, 0 fail** (3 new assertions on the envelope).
- Deploy via `~/.hermes/scripts/diag/fm_deploy_clean.py --go`: hold → build → restart with a
  minimal env → verify → release hold. Boot log showed the sizing guard, the execution-breaker
  line, migrations none, `command bot started (long-polling, attempt 1)`, 0 `bot launch failed`,
  0 `terminated by other getUpdates`.
- DeepSeek reachable at deploy time (balance $2.11, `choices` present on a live probe).

## Same morning, separately: the hourly wallet/book drift alert

`[drift] WALLET/BOOK DRIFT` paged: the book claims 3.311893 SOL against a wallet holding
3.013487 SOL (9.01%). **This is not missing SOL.** The book = `STARTING_BALANCE_USD=288.27` pin
+ realized book PnL ($43.12 over 7 trades), while the chain gained 0.1325 SOL over the same
period: the difference is the **exit cost the book never books** (bin-step spread — see
`exit_economics`: EMBER exits conceded 90–395 bps — plus priority fees). Lifetime check: total
deposits 3.14485 SOL against a wallet of 3.013487 SOL = −0.1314 SOL net, zero stranded tokens.

Re-pinning `STARTING_BALANCE_USD` is an operator `.env` edit; the engine never rebases itself.
