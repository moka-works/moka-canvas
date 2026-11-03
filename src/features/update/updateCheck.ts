import { currentUiPrefs, rememberUiPrefs } from "../../shared/prefs/prefsData";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const UPDATE_STARTUP_DELAY_MS = 3_000;

/** Whether a day has passed since the last silent check, if there was one. */
export function updateCheckDue(now: number, last: number | null): boolean {
  return (
    last === null || !Number.isFinite(last) || now - last >= CHECK_INTERVAL_MS
  );
}

export function lastUpdateCheck(): number | null {
  const kept = currentUiPrefs().lastUpdateCheck;
  return typeof kept === "number" && Number.isFinite(kept) ? kept : null;
}

export function markUpdateChecked(at: number) {
  rememberUiPrefs({ lastUpdateCheck: at });
}
