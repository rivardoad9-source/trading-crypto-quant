/**
 * Engine version cohorts.
 *
 * The engine changed materially on ENGINE_V11_CUTOFF: the anti-churn cooldown/lockout
 * and the 60-second exit monitor went in together. Trades either side of that line were
 * produced by different machines, and averaging them hides whether the fix worked. The
 * dashboard therefore reads one cohort at a time.
 *
 * Cohort membership is decided by `opened_at`, never `closed_at` — the cohort names the
 * engine that made the ENTRY decision. A position the old screener picked stays v1.0's
 * trade however long it took to close.
 */
import { env } from "../config/env.js";

export const COHORT_IDS = ["current", "all"] as const;
export type CohortId = (typeof COHORT_IDS)[number];

export interface Cohort {
  id: CohortId;
  /** Short label for a segmented control. */
  label: string;
  /** One line explaining what the reader is looking at. */
  description: string;
  /**
   * Positions opened before this are excluded. Null means no filter at all.
   * Passed to SQLite's datetime(), so any format it accepts works.
   */
  openedAtFrom: string | null;
  /**
   * True when figures are computed over a subset of history.
   *
   * The UI must say so. Equity in a filtered cohort is rebased on
   * STARTING_BALANCE_USD, so it answers "what would this engine have done starting
   * fresh" — not "what is in the account". Presenting a rebased number as the live
   * balance would be a fabricated figure, which this project does not do.
   */
  filtered: boolean;
}

export function isCohortId(value: unknown): value is CohortId {
  return typeof value === "string" && (COHORT_IDS as readonly string[]).includes(value);
}

export function resolveCohort(id: CohortId): Cohort {
  if (id === "all") {
    return {
      id: "all",
      label: "All-Time Archive",
      description: "Every simulated trade, both engine versions.",
      openedAtFrom: null,
      filtered: false,
    };
  }

  return {
    id: "current",
    label: "Current Run (v1.1)",
    description: `Positions opened on or after ${env.ENGINE_V11_CUTOFF}, when the anti-churn gates and the 60s exit monitor went live.`,
    openedAtFrom: env.ENGINE_V11_CUTOFF,
    filtered: true,
  };
}

/** The API's default. All-time, so an unparameterised request is never a silent subset. */
export const DEFAULT_COHORT_ID: CohortId = "all";

export const defaultCohort = (): Cohort => resolveCohort(DEFAULT_COHORT_ID);
