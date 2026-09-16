/**
 * `--sweep=field:v1,v2` — the spec parser, and the validation that makes it honest.
 *
 * It lives here rather than in `scripts/scenarioLab.ts` because it is backtest logic, not
 * CLI plumbing: it reasons about the shape of `BacktestConfig`, and a test under
 * `src/tests` cannot import from `scripts/` (outside `rootDir`). The script imports and
 * re-exports it, so the command line is unchanged.
 */
import type { BacktestConfig } from "./engine.js";

const INF = Number.POSITIVE_INFINITY;

export interface Scenario {
  key: string;
  label: string;
  family: "baseline" | "entry" | "exit" | "range" | "risk" | "combo";
  /** What this row changes against scenario A. Printed verbatim. */
  diff: string;
  apply: (base: BacktestConfig) => BacktestConfig;
}


/** Levenshtein distance, for "did you mean" on a misspelled field. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] =
        a[i - 1] === b[j - 1]
          ? d[i - 1]![j - 1]!
          : 1 + Math.min(d[i - 1]![j]!, d[i]![j - 1]!, d[i - 1]![j - 1]!);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The numeric fields `--sweep` may walk, derived from the BASE CONFIG OBJECT itself.
 *
 * Deriving it rather than hard-coding a second list is the point: a hand-written list is a
 * copy of the config's shape and would drift from it the first time a field is added. A
 * non-numeric field (`exitCostModel`, `gateUsesExitCostModel`, `startingCapitalUsd` when
 * null) is excluded, because `--sweep` only produces numbers and writing one into a
 * non-numeric field would corrupt the config rather than measure it.
 */
export function sweepableFields(base: BacktestConfig): string[] {
  return Object.entries(base)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k)
    .sort();
}

/**
 * Builds one scenario per value of one config field, from `--sweep`.
 *
 * VALIDATES THE FIELD NAME FIRST, and throws before a single scenario runs.
 *
 * WHY THIS IS NOT A NICETY. This function used to cast an unchecked string
 * (`field as keyof BacktestConfig`) and spread it onto the config, so a name that is not a
 * config field became an inert extra property. `--sweep=stopLoss:-12` — the real field is
 * `stopLossPct` — then produced a row identical to the baseline in every column, printing
 * `vs A $0.00`. That reads as "this lever does nothing" when the flag never applied: the
 * tool turned NOT MEASURED into MEASURED NO EFFECT, in a program whose entire product is
 * the measurement. Same failure mode as the "all bin arrays exist" line CLAUDE.md records.
 */
export function sweepScenarios(spec: string | undefined, base: BacktestConfig): Scenario[] {
  if (!spec) return [];
  const allowed = sweepableFields(base);
  const out: Scenario[] = [];

  for (const group of spec.split(";").filter(Boolean)) {
    const [field, list] = group.split(":");
    if (!field || !list) throw new Error(`--sweep entry "${group}" is not field:v1,v2,...`);
    const key = field.trim();

    if (!allowed.includes(key)) {
      const near = allowed
        .map((candidate) => ({ candidate, d: editDistance(key.toLowerCase(), candidate.toLowerCase()) }))
        .filter(({ d }) => d <= Math.max(2, Math.ceil(key.length / 3)))
        .sort((a, b) => a.d - b.d)[0];
      throw new Error(
        `--sweep: "${key}" is not a numeric field of BacktestConfig, so sweeping it would ` +
          `measure NOTHING while printing a row that looks like a result.` +
          (near ? `\n  Did you mean: ${near.candidate}` : "") +
          `\n  Sweepable fields:\n    ${allowed.join("\n    ")}`,
      );
    }

    for (const rawValue of list.split(",").filter(Boolean)) {
      const value = rawValue.trim() === "off" ? INF : Number(rawValue);
      if (!Number.isFinite(value) && value !== INF) {
        throw new Error(`--sweep ${key}: "${rawValue}" is not a number (or "off")`);
      }
      out.push({
        key: `S:${key}=${rawValue}`,
        family: "combo",
        label: `${key} = ${rawValue}`,
        diff: `${key} -> ${rawValue}`,
        apply: (cfg) => ({ ...cfg, [key]: value }) as BacktestConfig,
      });
    }
  }
  return out;
}
