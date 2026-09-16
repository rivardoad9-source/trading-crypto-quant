# Code audit — 16 Sep 2026

HEAD `5dc3faf` · branch `work/backtest-scenario-lab` · read-only, nothing executed on-chain
Scope requested: find bugs and errors that could occur. **Nothing was fixed.** Every finding
below is reported with the evidence that establishes it and nothing more.

## What this audit did and did not cover

Covered, by reading and by running the code: the live money path (`liveExecution.ts`,
`onchainExecutor.ts`), accounting and reporting (`reconciliation.ts`, `liveReport.ts`,
`repositories.ts`), concurrency (`mutex.ts` and its callers), the timestamp rules, the
backtest harness, the REST API's input handling, the database migrations, and the new
scenario lab added in this branch.

**Not covered**, and no statement here should be read as covering it: the `dashboard/`
project (separate npm project and git repo), anything that requires a cluster or a funded
wallet to exercise, the DeepSeek prompt behaviour, and line-by-line review of all ~22,000
non-test source lines. This audit targeted the places where a defect costs money or
misstates a number, which is where this repository's history says they live.

**Verified clean** (stated so the silence is not mistaken for "not looked at"): no
`TODO`/`FIXME`/`HACK`/`@ts-ignore`/`eslint-disable` anywhere in `src/` or `scripts/`; no
empty or swallowing `catch` blocks; the executor import allowlist holds (every mention of
`onchainExecutor` outside it is a comment, not an import specifier); `/close_all` keeps the
two-phase mutex discipline; no `new Date(row.<timestamp>)` anywhere; `addColumnIfMissing`
is idempotent and takes no caller-supplied identifiers. `npm test` 1102/1102, `tsc` clean
on both projects, `npm run build` green.

---

## HIGH — 1. A raw token amount crosses into `Number` on three money paths, and can ask to sell more than the wallet holds

**Where.** All three are token → SOL:

| site | call |
|---|---|
| `src/services/liveExecution.ts:1843` | auto-unwind after a failed open — `amountLamports: Number(current)` |
| `src/services/liveExecution.ts:2350` | residual sweep sale — `amountLamports: Number(amount)` |
| `src/services/liveExecution.ts:2341` | the sweep's own quote — `amountLamports: Number(amount)` |

`ResidualSweepDeps` declares these amounts as `bigint`
(`readBalance(mint): Promise<bigint | null>`, `quoteToSol(mint, amount: bigint, …)`)
precisely because a raw token balance does not fit a double. The concrete implementation
narrows it to `Number(...)` at the Jupiter boundary. `getJupiterQuote` and
`executeJupiterSwap` both take `amountLamports: number`, so the loss happens before
`Math.floor` is applied at the URL — flooring a value that has already been rounded to the
nearest representable double does not undo an upward round.

**Why it bites.** A double holds integers exactly only up to `2^53 - 1 = 9,007,199,254,740,991`.
In raw token units that is about **9.0 million tokens at 9 decimals** and **9.0 billion at
6 decimals** — both ordinary sizes for the memecoins this strategy pairs against. Above
that threshold the conversion rounds to nearest, and a balance produced by a swap is an
arbitrary number, not a round one. Measured over 20,000 random balances per bucket:

| residual | above 2^53 | rounds UP | rounds down | exact | worst over-request |
|---|---|---|---|---|---|
| ~12.3M tokens, 9 dp | yes | 25.2% | 24.8% | 50.0% | 1 unit |
| ~500M tokens, 9 dp | yes | 49.1% | 49.3% | 1.6% | 32 units |
| ~30B tokens, 6 dp | yes | 37.8% | 37.5% | 24.7% | 2 units |

An over-request of **one raw unit is enough**: SPL `TransferChecked` fails when the amount
exceeds the balance. That is `0x1` — the same error class as the three KNOTS-SOL incidents
of 11 Sep, reached from the exit side instead of the entry side.

**Consequence per path.** The residual sweep is what stops an exit's proceeds sitting in a
memecoin; it "NEVER THROWS", so a failure here is reported and paged rather than retried,
and the capital stays in the token. The auto-unwind is what puts a failed open's SOL back;
its failure is what `StrandedSwapError` exists to announce. Both are the last line, and
both are the paths CLAUDE.md records as **still unproven by a funded exit** — so the
absence of an incident is not evidence the threshold has been crossed.

**The tell that this is an oversight rather than a decision.** Inside the *same* deps
object, the pool-sale route passes `amount.toString()` — exact — while the Jupiter route
passes `Number(amount)`. One quantity, two conversions, one of them lossy.

**Not verified:** whether any residual actually seen in production exceeded 2^53. The
`exit_economics` rows and `live_execution_attempts` would settle it and were not queried.

---

## MEDIUM — 2. One stored-timestamp rule, three implementations, two of them narrower

`parseDbTimestamp` (`meteora.ts:432`) is the canonical reader. Two copies exist:
`parseStamp` (`liveReport.ts:197`) and `ms` (`reconciliation.ts:132`). The canonical treats
a value as already-zoned when it contains `T` **or** ends in a zone marker:

```
hasZone = raw.includes("T") || /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)
```

Both copies test only `stamp.includes("T")`. Measured:

| value | canonical | the two copies |
|---|---|---|
| `2026-09-16 10:00:00` | 1789552800000 | 1789552800000 |
| `2026-09-16T10:00:00Z` | 1789552800000 | 1789552800000 |
| `2026-09-16 10:00:00Z` | 1789552800000 | **null** |
| `2026-09-16 10:00:00+07:00` | 1789527600000 | **null** |

SQLite `CURRENT_TIMESTAMP` writes no zone marker, so all three agree on every row the
engine writes today — this is latent, not active. It matters because of *where* the copies
live: in `reconciliation.ts`, `null` is not a parse detail, it is the difference between a
row being compared and being excluded from both totals as unmeasured. Any future writer
that formats with a zone and a space separator would be silently dropped there while the
cooldown gate reads it fine. The canonical function's regex shows someone expected that
form to occur.

---

## MEDIUM — 3. `scripts/scenarioLab.ts`: a misspelled `--sweep` field silently produces a row identical to the baseline

Introduced in this branch. `sweepScenarios` casts the field name into the config
(`{ ...base, [key]: value } as BacktestConfig`), so a name that is not a config field is
added as an inert extra property. Reproduced:

```
--sweep="stopLoss:-12"          (the real field is stopLossPct)
  A               59 trade  $568.72
  S:stopLoss=-12  59 trade  $568.72
```

The row renders as a legitimate measurement. A reader concludes the lever does nothing,
when in fact the flag never applied. This is the "a gate that silently does nothing is the
'all bin arrays exist' line again" failure mode, in a measurement tool — where the output
is the whole product.

---

## MEDIUM — 4. `scripts/scenarioLab.ts`: `--days` is reported as achieved even when the cache is shorter

Introduced in this branch. `trimDataset` takes whatever the cache holds inside the
requested span; it never compares requested against achieved. Reproduced against the
91-day micro cache:

```
--days=200
window : 2026-06-09 10:00 -> 2026-09-08 09:00 UTC (200d)     <- claims 200, delivered 91
JSON   : dataset.windowDays = 200
```

The printed dates do disclose the real span to a human reading the header, but the JSON —
the machine-readable artefact any later comparison would key on — records 200. `runAnnual.ts`
already solves exactly this ("compares requested against achieved days and warns in the
header, the terminal and the caveats"), and CLAUDE.md says not to remove that warning
because "a 208-day result gets quoted as an annual one". The new runner never had it.

---

## LOW — 5. `scripts/scenarioLab.ts`: the JSON does not record which universe arm ran

When no pool passes `partitionLiveEligible`, the runner falls back to the full universe. It
says so on the console, but the JSON records only `universe: { pools, survivors, dead }` —
not which arm produced them. Two result files can therefore be compared as like-for-like
when one was live-eligible-filtered and the other was not. This is not hypothetical: in the
16 Sep scenario report the integrity dataset ran LIVE-ELIGIBLE 23/32 while the micro dataset
fell back to FULL 22/22, and only the console transcript distinguishes them.

## LOW — 6. `scripts/scenarioLab.ts`: the cohort-concentration flag is binary

It fires only when a cohort contributes 0 of the trades. Every scenario in the 16 Sep run,
baseline included, drew **88–91%** of its trades from the dead-or-dormant cohort and passed
without a word. The check as written cannot see the condition it exists to catch; a share
threshold would.

## LOW — 7. `GET /api/pnl-calendar` accepts an impossible month — **CORRECTED: it is a 500, not an empty 200**

`^\d{4}-\d{2}$` admits `2026-00`, `2026-13`, `2026-99`. That root cause stands.

> **CORRECTED 16 Sep 2026.** The original finding said: *"The caller gets HTTP 200 and an
> empty month, which is indistinguishable from a month in which nothing traded — the 'not
> measured vs measured zero' distinction this repository enforces elsewhere. No crash."*
> **That consequence was wrong, and it was reasoned from the code rather than measured.**
> The operator ran it against the live API; it answers **HTTP 500**
> `{"error":"internal error","statusCode":500}`. Reproduced offline here afterwards, with
> the same stack:
>
> ```
> [api] GET /api/pnl-calendar?month=2026-13&cohort=all failed: RangeError: Invalid time value
>     at DateTimeFormat.formatToParts (<anonymous>)
>     at offsetMinutesAt (src/services/timezone.ts:40:6)
>     at zonedDayStartUtc (src/services/timezone.ts:77:55)
>     at aggregateClosedTradesByDate (src/database/repositories.ts:523:16)
> ```
>
> `new Date("2026-99-01T00:00:00Z")` is an Invalid Date, so the day-start resolver throws
> **before any SQL runs**. The failure is loud, not silent, so the "not measured vs measured
> zero" danger invoked above does not occur here. The original claim is kept visible rather
> than deleted: a wrong evidence line quietly removed is the failure mode this repository
> keeps paying for, and the lesson is that a consequence read off the code is a hypothesis
> until it is executed.

The fix is still the same and still right — a 500 on a GET is a bug, and range-checking the
month is the honest repair for the cause. Fixed under WORK ORDER #7 Task 2 with tests that
cover both directions: `2026-00` / `2026-13` / `2026-99` → 400, and a real month with no
trades → 200 with a full, empty day list, because "measured, nothing traded" must stay
distinguishable from "that month does not exist".

## LOW — 8. CLAUDE.md understates the executor import allowlist

CLAUDE.md says the allowlist "has four entries" (twice). It has **six**:
`onchainExecutor.ts`, `liveExecution.ts`, `onchainExecutor.test.ts`, `scripts/testMicroSwap.ts`,
`scripts/recoverFundedOrphan.ts`, `scripts/retryResidualSweep.ts`. The lock itself is
intact — the two extra entries are operator recovery scripts, and every other file that
mentions the executor mentions it in a comment. The documented count is the trigger for
"a fifth is the moment to ask whether it should call the bridge instead", so a stale count
retires the tripwire.

---

## Ranking, and what it would take to settle each

| # | Severity | Costs money if it fires | Settled by |
|---|---|---|---|
| 1 | HIGH | yes — a stranded token after an exit, or a failed unwind | querying stored residual amounts against 2^53; a unit test at the boundary |
| 2 | MEDIUM | no, but misstates reconciliation | one shared implementation |
| 3 | MEDIUM | no — corrupts a measurement | validating the field name against the config keys |
| 4 | MEDIUM | no — overstates a window | the `runAnnual.ts` warning |
| 5 | LOW | no | recording the arm in the JSON |
| 6 | LOW | no | a share threshold instead of a zero test |
| 7 | LOW | no — but it is a **500 on a GET**, not the empty 200 this report first claimed | a month range check |
| 8 | LOW | no | updating the count |

Finding 1 is the only one that can lose capital, and it is the only one whose trigger
condition is a property of the token rather than of an operator's input.
