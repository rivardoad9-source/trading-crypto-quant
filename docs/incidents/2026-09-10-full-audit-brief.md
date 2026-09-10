# Audit brief — full-engine audit, report-only (10 Sep 2026)

Hand-off to the dev agent (Claude Code, laptop). This is a SEPARATE work item from the fix pack
in `2026-09-10-claude-handoff-prompt.md` — do not bundle them. Fix pack first (it restores the
kill-switch), audit as its own session/branch, report only.

Paste the block below.

---

```
FlowMetrix engine — FULL audit, report only. No code changes, no commits, no restarts, no deploys.

Repo: ~/flowmetrix-ai-agent (main, at/after the commit that carries this file).
Read first: CLAUDE.md, docs/incidents/*.md (esp. the three 10 Sep 2026 ones), and the last
10 commits (`git log --oneline -10`).

WHY: this engine trades REAL money (micro-capital, wallet FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi,
0.8 SOL profile, max 1 position) and in the last 3 days it has produced three live incidents:
9 Sep a restart mid-cycle stranded 0.9 SOL as an unmonitored token; 10 Sep a post-swap deposit
half-landed and left a funded position the engine could not see (closed by hand ~4h later);
10 Sep the execution bench turned out to be keyed per pool_address, so the same token was
attempted live twice 29 minutes apart via two sibling pools and ~0.078 SOL was burned on the
second attempt. All three are the same theme: a failure path where money sits outside the
engine's supervision, or where a protective counter is keyed at the wrong granularity.
Assume there are more.

DELIVERABLE — exactly one document: docs/audits/2026-09-10-full-engine-audit.md
  plus a one-screen summary at the top: top findings ranked by money-at-risk, and the three
  things you would fix first. No code edits anywhere. No fix branches.

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
4. CONFIG / ARMING. env.ts guardlocks, the two switches needed for live, ONCHAIN_MAX_LAMPORTS_PER_TX
   vs position size + rent, LIVE_MAX_POSITION_BINS, and that PAPER mode stays byte-identical when
   live-only reads (news blackout, control file) are added.
5. LIFECYCLE / CONCURRENCY. schedulers vs overlapping cycles, double-open on one pool, restart or
   deploy mid-cycle, sqlite write safety under concurrent writers, idempotency of reconcilers and
   of resume paths (a bug here previously produced a second attempt 30 min after a failure).
6. EXTERNAL DEPENDENCIES. deepseek structuredCompletion failure/retry modes (reasoner burning
   max_tokens), GMGN rate limits, RPC error handling at each call site, GMGN/report-mode gates.
7. TEST COVERAGE GAPS. For every finding, say whether an existing test would have caught it and
   name the exact missing assertion. Also list the 5 highest-value tests that do not exist yet.

METHOD (mandatory, this is what makes the audit usable)
- Every finding: severity (critical / major / minor), file:line, the concrete scenario to
  reproduce, the evidence you actually observed (log line, DB query + output, tx signature,
  or a simulation), why the existing tests missed it, and the minimal fix sketch.
- Ground every claim in code, logs, DB or chain. Comments and incident docs are NOT evidence —
  verify against the implementation. Mark anything you could not verify as "UNVERIFIED".
- No speculation dressed as a finding. No fabricated numbers. If a data source is unavailable,
  write "unavailable".
- Regression safety section: for each of the last 10 commits, what it could plausibly have broken
  and which test covers that risk. Explicitly call out unprotected cross-module effects
  (e.g. adding a per-cycle file read must not change PAPER behaviour).
- Reproduce the baseline first and record it: npm run build, npm run typecheck, and
  `npm test 2>&1 | grep 'not ok'` on an unarmed checkout (clean) — note the armed-server set is
  NOT clean by design (10 Sep 2026: 644/651, 7 failures, all asserting the live profile is inert).
- For every finding, list the exact command/query you ran so a reviewer can re-run it.

RULES (non-negotiable)
- READ-ONLY. No source edits, no commits, no branch with fixes, no pm2 restart, no deploy,
  no .env edits, no gate changes — not even "safe" ones.
- Do not propose a refactor or a rewrite. Minimal, targeted fixes only, and you are not applying
  them in this session.
- Do not loosen or tighten any risk gate to make a finding go away.
- If you disagree with an existing gate's value, report the disagreement as a finding with
  evidence; do not change it.

DONE WHEN
- docs/audits/2026-09-10-full-engine-audit.md exists, every finding carries evidence + severity +
  file:line + a minimal fix sketch, the regression-safety section covers the last 10 commits,
  and the one-screen summary names the top findings and the first three fixes.
- You report explicitly what you could NOT verify and what you need (queries, log slices,
  chain lookups) to close those gaps.
```
