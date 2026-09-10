# Audit brief — full-engine audit, report-only (10 Sep 2026, refreshed 22:40 WIB)

Hand-off to the dev agent (Claude Code, laptop). **SEPARATE work item** from the fix pack in
`2026-09-10-claude-handoff-prompt.md` — that one already landed. This is read-only investigation.

Refreshed after tonight's deploys: this version audits HEAD **`b6ed678`** and adds the three
commits shipped after the first draft (`e16eb61`, `e497880`, `c8240de` — screener cadence).
The 409 bot incident is **RESOLVED**; read the RESOLVED doc, not the old "unresolved" one.

Paste the block below.

---

```
FlowMetrix engine — FULL audit, report only. No code changes, no commits, no restarts, no deploys.

Repo: ~/flowmetrix-ai-agent (main, at/after b6ed678). Run `git log --oneline -12` first and record
the exact SHA you audited in the report.
Read first: CLAUDE.md, ALL of docs/incidents/*.md (the 10 Sep 2026 set is the important one),
and the last 12 commits.

WHY: this engine trades REAL money (micro-capital, wallet FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi,
0.8 SOL profile, max 1 position) and in the last 3 days it has produced four live incidents:
9 Sep a restart mid-cycle stranded 0.9 SOL as an unmonitored token; 10 Sep a post-swap deposit
half-landed and left a funded position the engine could not see (closed by hand ~4h later);
10 Sep the execution bench turned out to be keyed per pool_address, so the same token was attempted
live twice 29 minutes apart via two sibling pools and ~0.078 SOL was burned on the second attempt;
10 Sep the command bot was dead for ~2 days because a leaked Hermes process-env token shadowed the
correct .env token (dotenv does not override process.env) — the operator had NO kill-switch.
Themes: money sitting outside the engine's supervision; protective counters keyed at the wrong
granularity; and silent credential/config shadowing. Assume there are more of all three.

DELIVERABLE — exactly one document: docs/audits/2026-09-10-full-engine-audit.md
  (create the docs/audits/ dir). One-screen summary at the top: findings ranked by money-at-risk,
  then the three things you would fix first. No code edits anywhere. No fix branches.

SCOPE, in priority order

1. MONEY PATH (live execution). src/services/onchainExecutor.ts, src/services/liveExecution.ts.
   Walk every stage: balance/quote -> Jupiter swap -> create position -> fund (single and the
   chunked wide path) -> monitoring -> claim fees -> close -> auto-unwind -> recover-partially-
   funded. For EVERY failure point answer with evidence:
     (a) can money end up outside the engine's supervision (wallet tokens, position account,
         bin-array rent, in-flight tx)? (b) is the unwind guaranteed and ordered correctly?
     (c) is a strike recorded? (d) is the operator alerted, and does the alert distinguish
         "unwound clean" from "orphan left"? (e) does the DB row match the chain afterwards?
2. BOOKKEEPING GRANULARITY. pool_execution_failures (bench), simulated_positions, reconciliation.
   Known defect class: a per-pool key where a mint-level key is needed (the KNOTS case above).
   Find EVERY place keyed by pool address where a sibling pool of the same mint walks around it —
   bench/lockout/cooldown/denylist/de-dup — and say which ones are exploitable in live mode.
3. GATE INTEGRITY. Verify each .env gate is actually enforced in code and that no reachable path
   can bypass: friction/breakeven, anti-rug fail-closed (UNKNOWN must reject), volatility,
   cooldowns, width/bin caps, POOL_DENYLIST, max-concurrent. Report bypasses, especially any
   reachable with DRY_RUN=false.
4. CONFIG / ARMING / SHADOWING. env.ts guardlocks, the two switches needed for live,
   ONCHAIN_MAX_LAMPORTS_PER_TX vs position size + rent, LIVE_MAX_POSITION_BINS, and that PAPER mode
   stays byte-identical when live-only reads (news blackout, control file) are added.
   NEW (from the 409 incident): find every place a config value can be SHADOWED by process.env or
   by a stale pin, where a .env edit silently has no effect (dotenv does not override process.env).
   List every credential/config the process reads that could be wrong while the file looks right,
   and say how an operator would detect it. Also audit STARTING_BALANCE_USD as a manual pin that
   silently disables auto-seeding (it was stale at $120.16 while the wallet held ~$298).
5. LIFECYCLE / CONCURRENCY. schedulers vs overlapping cycles, double-open on one pool, restart or
   deploy mid-cycle, sqlite write safety under concurrent writers, idempotency of reconcilers and
   of resume paths (a bug here previously produced a second attempt 30 min after a failure).
6. EXTERNAL DEPENDENCIES. deepseek structuredCompletion failure/retry modes (reasoner burning
   max_tokens), GMGN rate limits, RPC error handling at each call site, GMGN/report-mode gates.
7. **NEW — SCREENER CADENCE (`e16eb61`, `e497880`, `c8240de`).** Audits the newest live code.
   src/services/screenerCadence.ts (new), src/config/constants.ts (CRON.DLMM_TICK `*/5`,
   DLMM_BASE_CADENCE_MIN 30, DLMM_POST_NEWS_FAST_MIN 90), src/index.ts (tick-driven gate),
   src/tests/screenerCadence.test.ts.
   Answer: (a) can a wrong clock/timezone/zone-boundary make it run every 5 minutes forever
     (token burn) or never at all? (b) does it FAIL SAFE — missing, corrupt or STALE calendar file
     must mean "no fast window", not "fast forever" (show the code path and the staleness bound)?
   (c) can the tick overlap a running cycle or starve the position monitor? (d) is PAPER mode
     byte-identical? (e) do the de-pinned tests (deepseekBudget.test.ts, v11Baseline.test.ts) still
     assert what protection they were written for, or did de-pinning quietly remove a guard?
   Also: quantify the worst-case extra DeepSeek spend if the window logic mis-fires 24/7.
8. **NEW — NEWS-BLACKOUT COUPLING.** The engine's entry gate reads a calendar file produced by
   EXTERNAL crons (writer lives in the Hermes workspace: ~/.hermes/scripts/news_blackout_write.py,
   NOT in this repo). Audit the coupling from the engine side: file path/format, what happens if the
   writer dies or the file goes stale, and — critical — can a missing/stale/parse-failed calendar
   make the blackout FAIL OPEN (entry allowed during a macro release)? State the fail direction for
   every branch with file:line. Distinguish the two meanings of "blackout" (in-window hold vs
   post-news fast cadence) and check they cannot be confused.
9. TEST COVERAGE GAPS. For every finding, say whether an existing test would have caught it and
   name the exact missing assertion. Also list the 5 highest-value tests that do not exist yet.

EVIDENCE RULES (important — you are on the laptop, the live state is on the server)
- Ground every claim in code, logs, DB or chain. Comments and incident docs are NOT evidence —
  verify against the implementation. Mark anything you could not verify as "UNVERIFIED".
- You do NOT have access to the live server, its pm2 logs, or the sqlite DB. Do not guess at them.
  For anything that needs live evidence, write a "REQUESTED EVIDENCE" entry with the exact command
  or SQL a reviewer must run on the server, and what you expect it to show. The operator will run
  them and return the output.
- No speculation dressed as a finding. No fabricated numbers. If a data source is unavailable,
  write "unavailable".
- Baseline you CAN reproduce locally: npm run build, npm run typecheck, and
  `npm test 2>&1 | grep 'not ok'`. On a clean unarmed checkout expect clean; the armed live server
  is NOT clean by design — 10 Sep 2026, HEAD b6ed678: 729 total / 722 pass / **7 failures**, all
  asserting the live profile is inert (documented, not regressions). Record what you get locally.
- Regression safety section: for each of the last 12 commits, what it could plausibly have broken
  and which test covers that risk. Explicitly call out unprotected cross-module effects.
- For every finding, list the exact command/query you ran so a reviewer can re-run it.

RULES (non-negotiable)
- READ-ONLY. No source edits, no commits, no branch with fixes, no pm2 restart, no deploy,
  no .env edits, no gate changes — not even "safe" ones. Your ONLY write is the audit document.
- Do not propose a refactor or a rewrite. Minimal, targeted fixes only, and you are not applying
  them in this session.
- Do not loosen or tighten any risk gate to make a finding go away.
- If you disagree with an existing gate's value, report the disagreement as a finding with
  evidence; do not change it.

DONE WHEN
- docs/audits/2026-09-10-full-engine-audit.md exists, names the audited SHA, every finding carries
  severity (critical/major/minor) + file:line + a concrete reproduction + the evidence you actually
  observed + why the existing tests missed it + a minimal fix sketch; the regression-safety section
  covers the last 12 commits; the one-screen summary names the top findings and the first three
  fixes; and the REQUESTED EVIDENCE section lists what the operator must run to close the gaps.
- Commit ONLY that document, with message `docs(audit): full-engine audit <sha>` and push to main.
  Do not touch any other file.
```
