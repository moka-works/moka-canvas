const LAST_CHECK_KEY = "moka-canvas:last-update-check";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const UPDATE_STARTUP_DELAY_MS = 3_000;

/** Whether a day has passed since the last silent check, if there was one. */
export function updateCheckDue(now: number, last: number | null): boolean {
  return (
    last === null || !Number.isFinite(last) || now - last >= CHECK_INTERVAL_MS
  );
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // A runtime that denies storage still updates; it only asks once per run.
    return undefined;
  }
}

export function lastUpdateCheck(): number | null {
  const kept = storage()?.getItem(LAST_CHECK_KEY);
  if (kept === null || kept === undefined) return null;
  const at = Number(kept);
  return Number.isFinite(at) ? at : null;
}

export function markUpdateChecked(at: number) {
  try {
    storage()?.setItem(LAST_CHECK_KEY, String(at));
  } catch {
    // Same as above: the choice to update is unaffected by a missed timestamp.
  }
}
