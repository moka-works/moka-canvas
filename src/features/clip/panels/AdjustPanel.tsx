import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipAdjust } from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  adjustFromSlider,
  adjustIsUntouched,
  clampAdjust,
  patchCommands,
  sharedValue,
  sliderFromAdjust,
} from "../inspector/clipFieldMath";
import { useClipStore } from "../stores/clipStore";

/**
 * Brightness, contrast and saturation as three sliders, dragged live.
 *
 * A drag writes a draft into the store rather than sending commands: the
 * compositor dresses the chosen clips in the draft while the pointer is down,
 * so the picture answers the hand at once and no history is spent on the way.
 * The release sends one command — one undo puts the grade back — and lets the
 * draft go, whatever the command layer decided about it.
 *
 * A set of clips that disagree about an axis starts from the middle of that
 * axis, which is the honest thing to show: there is no one value to drag.
 */

const AXES = [
  { key: "brightness", labelKey: "clip:adjust.brightness" },
  { key: "contrast", labelKey: "clip:adjust.contrast" },
  { key: "saturation", labelKey: "clip:adjust.saturation" },
  { key: "temperature", labelKey: "clip:adjust.temperature" },
  { key: "tint", labelKey: "clip:adjust.tint" },
] as const;

type Axis = (typeof AXES)[number]["key"];

export function AdjustPanel() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const clipIds = useClipStore((state) => state.selection.clipIds);
  const timeline =
    (moka?.timelines ?? []).find((each) => each.id === activeTimelineId) ??
    null;
  const chosen = new Set(clipIds);
  const clips = (timeline?.clips ?? []).filter((clip) => chosen.has(clip.id));

  const shared: ClipAdjust = {
    brightness:
      sharedValue(clips.map((clip) => clip.adjust?.brightness ?? 0)) ?? 0,
    contrast: sharedValue(clips.map((clip) => clip.adjust?.contrast ?? 0)) ?? 0,
    saturation:
      sharedValue(clips.map((clip) => clip.adjust?.saturation ?? 0)) ?? 0,
    temperature:
      sharedValue(clips.map((clip) => clip.adjust?.temperature ?? 0)) ?? 0,
    tint: sharedValue(clips.map((clip) => clip.adjust?.tint ?? 0)) ?? 0,
  };
  const [held, setHeld] = useState<ClipAdjust | null>(null);
  const shown = held ?? shared;

  // A draft belongs to a held pointer; a panel leaving with one still in the
  // store would leave the preview wearing a grade nobody is dragging.
  useEffect(() => () => useClipStore.getState().setAdjustDraft(null), []);

  const write = (next: ClipAdjust) => {
    setHeld(next);
    useClipStore
      .getState()
      .setAdjustDraft({ clipIds: clips.map((clip) => clip.id), adjust: next });
  };

  const commit = (next: ClipAdjust) => {
    const wrapped = clampAdjust(next);
    useClipStore.getState().setAdjustDraft(null);
    setHeld(null);
    if (!timeline || clips.length === 0) return;
    // Untouched is stored as no grade at all, which is what makes one undo of
    // a drag bring the clip back to what it wore before rather than to zeroes.
    const after = adjustIsUntouched(wrapped) ? null : wrapped;
    const patches = clips.flatMap((clip) => {
      const before = clip.adjust ?? null;
      const same =
        before === null
          ? after === null
          : after !== null &&
            before.brightness === after.brightness &&
            before.contrast === after.contrast &&
            before.saturation === after.saturation &&
            (before.temperature ?? 0) === (after.temperature ?? 0) &&
            (before.tint ?? 0) === (after.tint ?? 0);
      return same ? [] : [{ clipId: clip.id, patch: { adjust: after } }];
    });
    if (patches.length === 0) return;
    execute(t("clip:history.adjustClip"), patchCommands(timeline.id, patches));
  };

  const apply = (axis: Axis, slider: number) => {
    write({ ...shown, [axis]: adjustFromSlider(slider) });
  };

  return (
    <div className="clip-adjust-page" data-testid="clip-adjust-panel">
      {AXES.map(({ key, labelKey }) => {
        const label = t(labelKey);
        const slider = sliderFromAdjust(shown[key] ?? 0);
        return (
          <label className="clip-adjust-row" key={key}>
            <span>{label}</span>
            <input
              aria-label={label}
              disabled={clips.length === 0}
              max={100}
              min={-100}
              onChange={(event) => apply(key, Number(event.target.value))}
              onBlur={() => {
                if (held !== null) commit(held);
              }}
              onPointerUp={() => {
                if (held !== null) commit(held);
              }}
              step={1}
              type="range"
              value={slider}
            />
            <span className="clip-adjust-value">{slider}</span>
          </label>
        );
      })}
      <button
        disabled={clips.length === 0}
        onClick={() => commit({ brightness: 0, contrast: 0, saturation: 0 })}
        type="button"
      >
        {t("clip:common.reset")}
      </button>
      {clips.length === 0 && (
        <p className="clip-filter-hint">{t("clip:adjust.selectHint")}</p>
      )}
    </div>
  );
}
