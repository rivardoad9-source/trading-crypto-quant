import { createHash } from "node:crypto";

/**
 * One page per CONDITION, not one page per check.
 *
 * `reportCapitalHealth` runs every hour and used to send a Telegram message every time a
 * check was in breach, so a condition that stood for a day was 24 identical pages — the
 * pattern that trains an operator to stop reading them, and the one the 10 Sep 2026
 * watchdog spam (every 15 minutes) already taught the ops runbook to forbid: a recurring
 * condition is deduped on STATE, because every non-empty output is delivered as it is.
 *
 * Keyed on the SET of violation CLASSES, hashed — never on the message text or its
 * numbers. The message carries live figures (a balance, a price-free SOL drift that still
 * moves by lamports), so keying on it would re-page on every tick and dedupe nothing.
 * A different set — a new threshold breached, the drift flipping sign, the sizing guard
 * going from over-capital to balance-unknown — is a different condition and pages at once.
 *
 * Rules:
 *  - first breach of a set: send the full message;
 *  - the same set again: hold it, and re-send once `repeatAfterMs` (6 h) has passed since
 *    the last send, so a condition nobody fixed is not forgotten either;
 *  - back to normal after a page was sent: send ONE recovery line, and forget the set;
 *  - back to normal with nothing ever sent: send nothing.
 *
 * Pure: the state goes in and comes out, and the clock is an argument. The caller keeps
 * the state in memory, so a restart forgets it and re-pages a standing condition once —
 * the safe direction for a process that has just come back up.
 */

export const STANDING_ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

export interface StandingAlertState {
  /** Hash of the violation set last paged, or null when nothing is standing. */
  key: string | null;
  lastSentAtMs: number | null;
}

export const initialStandingAlertState = (): StandingAlertState => ({ key: null, lastSentAtMs: null });

export type StandingAlertDecision =
  | { send: false; reason: "normal" | "held" }
  | { send: true; kind: "first" | "changed" | "repeat" | "recovered"; text: string };

/** Order- and duplicate-insensitive, so ["sol","pct"] and ["pct","sol"] are one condition. */
export function violationKey(violations: readonly string[]): string | null {
  const set = [...new Set(violations)].sort();
  if (set.length === 0) return null;
  return createHash("sha256").update(set.join("|")).digest("hex").slice(0, 16);
}

export function decideStandingAlert(
  state: StandingAlertState,
  input: {
    /** Violation classes currently breached. Empty means the check is normal. */
    violations: readonly string[];
    /** The full alert, with every number. Sent on first / changed / repeat. */
    message: string;
    /** One line for the transition back to normal. */
    recoveredMessage: string;
    nowMs: number;
    repeatAfterMs?: number;
  },
): { decision: StandingAlertDecision; next: StandingAlertState } {
  const repeatAfterMs = input.repeatAfterMs ?? STANDING_ALERT_REPEAT_MS;
  const key = violationKey(input.violations);

  if (key === null) {
    if (state.key === null) {
      return { decision: { send: false, reason: "normal" }, next: state };
    }
    return {
      decision: { send: true, kind: "recovered", text: input.recoveredMessage },
      next: initialStandingAlertState(),
    };
  }

  const sent = { key, lastSentAtMs: input.nowMs };

  if (state.key === null) {
    return { decision: { send: true, kind: "first", text: input.message }, next: sent };
  }
  if (state.key !== key) {
    return { decision: { send: true, kind: "changed", text: input.message }, next: sent };
  }
  // At exactly the window the repeat is due: "held at most 6 hours" includes the 6th.
  if (state.lastSentAtMs === null || input.nowMs - state.lastSentAtMs >= repeatAfterMs) {
    return { decision: { send: true, kind: "repeat", text: input.message }, next: sent };
  }
  return { decision: { send: false, reason: "held" }, next: state };
}
