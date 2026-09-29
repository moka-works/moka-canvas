import { findResource, formatDuration } from "../../../shared/domain";
import type { MokaFile } from "../../../shared/domain/types";

/** How long a sound file runs, as the shelf reads it back. */
export function secondsOf(moka: MokaFile | null, assetId: string): string {
  const entry = moka === null ? undefined : findResource(moka, assetId);
  const durationMs = entry?.probe?.durationMs;
  return durationMs === undefined ? "—" : formatDuration(durationMs);
}
