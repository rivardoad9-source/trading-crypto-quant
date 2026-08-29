/**
 * In-process engine control state (pause/resume), driven by the Telegram
 * /pause and /resume commands.
 *
 * Deliberately in-memory, not persisted: a process restart brings the engine
 * back in the RUNNING state, which is the safe default for an unattended
 * scheduler. Pausing is a temporary operator intervention, not a config.
 */
let paused = false;

export function isEnginePaused(): boolean {
  return paused;
}

/** Returns the new state. */
export function setEnginePaused(value: boolean): boolean {
  paused = value;
  return paused;
}
