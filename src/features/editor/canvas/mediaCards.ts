import type {
  AssetId,
  GenerationSpec,
  MokaFile,
  ResourceEntry,
  SelfCheckReport,
  WorkflowNode,
} from "../../../shared/domain";
import { assetThumbUrl, assetUrl } from "../../../api";
import { i18n } from "../../../shared/i18n";

export type MediaState = "ready" | "missing" | "changed" | "empty";

/** How wide a card's material is drawn: the card is smaller, and its picture
    is a preview — the inspector and the preview dialog show the file. */
const CARD_THUMB_WIDTH = 768;

export interface MediaCardInfo {
  state: MediaState;
  /**
   * The picture to show: the asset itself, or a video's poster when one has
   * been made. A video without a poster has none — its own file is not a
   * picture, and handing it to an image is a decode nobody gets back.
   */
  url?: string;
  /** The file a video plays from. Videos only. */
  playable?: string;
  /** Compact label for the card body: dimensions, duration, sample rate. */
  label: string;
  entry?: ResourceEntry;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Flattens the registry into an id → entry lookup. */
export function buildResourceIndex(
  moka: MokaFile,
): Map<AssetId, ResourceEntry> {
  const index = new Map<AssetId, ResourceEntry>();
  for (const entries of Object.values(moka.resources)) {
    for (const entry of entries) index.set(entry.id, entry);
  }
  return index;
}

/** assetId → issue reason for everything the open-time self-check flagged. */
export function buildIssueIndex(
  selfCheck: SelfCheckReport | null,
): Map<AssetId, Exclude<MediaState, "ready">> {
  const index = new Map<AssetId, Exclude<MediaState, "ready">>();
  for (const issue of selfCheck?.issues ?? []) {
    index.set(issue.assetId, issue.reason);
  }
  return index;
}

function labelFor(entry: ResourceEntry): string {
  const probe = entry.probe;
  const parts: string[] = [];
  if (probe?.width && probe.height)
    parts.push(`${probe.width}×${probe.height}`);
  const duration = formatDuration(probe?.durationMs);
  if (duration) parts.push(duration);
  if (probe?.sampleRate)
    parts.push(`${Math.round(probe.sampleRate / 100) / 10} kHz`);
  if (parts.length === 0) parts.push(formatBytes(entry.bytes) || entry.name);
  return parts.join(" · ");
}

const MENTION_PATTERN = /@\[node:[^\]]+\]/g;
const MENTION_STAND_IN = "@ref";

/** The identifier a node names its model by, or the default label. */
function modelAlias(model: string): string {
  return model.trim() || i18n.t("editor:canvas.defaultModel");
}

/**
 * Collapsed card line for a node's generation spec: model alias, then the
 * prompt's first line with mentions shortened. Empty when the node carries no
 * spec, so callers keep their own fallback copy.
 */
export function generationSummary(node: WorkflowNode): string {
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  if (!spec) return "";
  const alias = modelAlias(spec.model);
  const lead = (spec.prompt.split("\n", 1)[0] ?? "")
    .replace(MENTION_PATTERN, MENTION_STAND_IN)
    .trim();
  return lead ? `${alias} · ${lead}` : alias;
}

/** Change signature for a node's media card; compared by renderer and scene differ. */
export function mediaSignature(media: MediaCardInfo | null): string {
  if (!media) return "";
  return `${media.state}|${media.url ?? ""}|${media.playable ?? ""}|${media.label}`;
}

/**
 * Resolves a media node's card presentation from its assetId. Returns null
 * for nodes without an asset reference (the empty-state card).
 */
export function mediaInfoForNode(
  node: WorkflowNode,
  resources: ReadonlyMap<AssetId, ResourceEntry>,
  issues: ReadonlyMap<AssetId, MediaState>,
): MediaCardInfo | null {
  if (node.kind !== "image" && node.kind !== "audio" && node.kind !== "video") {
    return null;
  }
  const data = node.data as { assetId?: AssetId; posterAssetId?: AssetId };
  if (!data.assetId) return null;
  const issue = issues.get(data.assetId);
  const entry = resources.get(data.assetId);
  if (issue || !entry) {
    return {
      state: issue ?? "missing",
      label: entry?.name ?? i18n.t("editor:canvas.missingAsset"),
      entry,
    };
  }
  const posterId =
    node.kind === "video"
      ? (data.posterAssetId ?? entry.probe?.posterAssetId)
      : undefined;
  return {
    state: "ready",
    url:
      node.kind === "video"
        ? posterId
          ? assetThumbUrl(posterId, CARD_THUMB_WIDTH)
          : undefined
        : assetThumbUrl(data.assetId, CARD_THUMB_WIDTH),
    // What a video card plays is the film, not a picture of it: the element
    // gets the file itself.
    playable: node.kind === "video" ? assetUrl(data.assetId) : undefined,
    label: labelFor(entry),
    entry,
  };
}

/**
 * Deterministic pseudo-waveform (0..1 peaks) derived from the asset hash —
 * a stand-in for a true sampled waveform until derivative jobs land.
 */
export function waveformPeaks(
  sha256: string | undefined,
  count = 28,
): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    const ch = sha256?.charCodeAt((i * 2) % Math.max(sha256.length, 1)) ?? 0;
    const nibble = Number.isNaN(ch) ? 0 : ch % 16;
    peaks.push(0.25 + (nibble / 15) * 0.75);
  }
  return peaks;
}
