import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CLIP_LABEL_MAX,
  MAX_CLIP_SPEED,
  MAX_CLIP_VOLUME,
  MIN_CLIP_DURATION_MS,
  MIN_CLIP_SPEED,
  defaultTextStyle,
  type ClipPatch,
  type TextClipData,
  type TextClipStyle,
  type TimelineClip,
  type TimelineDocument,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import {
  DuplicateIcon,
  ScissorsIcon,
  TrashIcon,
} from "../components/ClipIcons";
import {
  deleteSelection,
  detachAudio,
  duplicateSelection,
  materialHoldsSound,
  materialOf,
  splitSelectionAtPlayhead,
} from "../interactions/clipActions";
import {
  clampTextContent,
  legalStyle,
  sameText,
  styleApplyPatches,
} from "../interactions/textActions";
import { useClipStore } from "../stores/clipStore";
import { TEXT_STYLE_PRESET_LABELS, TEXT_STYLE_PRESETS } from "../textStyles";
import {
  formatTimecode,
  frameAligned,
  parseTimecode,
} from "../timeline/timecode";
import {
  clampFade,
  durationPatch,
  labelText,
  patchCommands,
  sharedValue,
  speedIsLocked,
  speedPatch,
  startPatch,
  wholeNumberIn,
} from "./clipFieldMath";
import { TextFields } from "./TextFields";

/**
 * What a clip is, and how it plays, as a form over the document.
 *
 * Every field commits on its own — a number on blur or Enter, a slider on
 * release — so one change is one entry of history and the undo of a volume
 * nudge never also takes back the trim that came before it. A selection of
 * several clips shows what they agree on: a value they do not share reads as
 * `Mixed`, and writing a value writes it to all of them in one step.
 *
 * The panel owns no draft beyond the text a reader is typing and a slider
 * held down: the document is only ever sent what a release decided.
 */

const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;

function toast(
  kind: "info" | "success" | "error",
  message: string,
  detail?: string,
): void {
  useAppStore.getState().pushToast(kind, message, undefined, detail);
}

/** Text held locally while a field is being typed in, synced when it is not. */
function useTypedText(value: string) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return { text, setText, focused };
}

/** A labelled clock field: `hh:mm:ss:ff`, parsed on the document's own rate. */
function TimecodeField({
  fps,
  label,
  ms,
  onCommit,
}: {
  fps: number;
  label: string;
  /** The moment the field stands for; null on a set of clips that disagree. */
  ms: number | null;
  onCommit: (ms: number) => void;
}) {
  const { t } = useTranslation();
  const shown = ms === null ? "" : formatTimecode(ms, fps);
  const { text, setText, focused } = useTypedText(shown);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (text.trim().length === 0) {
      setBad(false);
      setText(shown);
      return;
    }
    const parsed = parseTimecode(text, fps);
    if (parsed === null) {
      // A reading that is not a timecode is shown going red rather than
      // jumping a clip somewhere the reader did not ask for.
      setBad(true);
      return;
    }
    setBad(false);
    if (ms !== null && parsed === ms) return;
    onCommit(parsed);
  };
  return (
    <label className={`clip-inspector-field${bad ? " is-invalid" : ""}`}>
      <span>{label}</span>
      <input
        inputMode="numeric"
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(event) => {
          setText(event.target.value);
          setBad(false);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder={ms === null ? t("clip:common.mixed") : "hh:mm:ss:ff"}
        title={bad ? t("clip:clipFields.notATimecode") : undefined}
        value={text}
      />
    </label>
  );
}

/** A labelled whole-number field, milliseconds or a pace. */
function NumberField({
  label,
  max,
  min,
  onCommit,
  value,
}: {
  label: string;
  max: number;
  min: number;
  /** The number the field stands for; null on a set of clips that disagree. */
  value: number | null;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  const shown = value === null ? "" : String(value);
  const { text, setText, focused } = useTypedText(shown);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (text.trim().length === 0) {
      setBad(false);
      setText(shown);
      return;
    }
    const parsed = wholeNumberIn(text, min, max);
    if (parsed === null) {
      setBad(true);
      return;
    }
    setBad(false);
    if (value !== null && parsed === value) return;
    onCommit(parsed);
  };
  return (
    <label className={`clip-inspector-field${bad ? " is-invalid" : ""}`}>
      <span>{label}</span>
      <input
        inputMode="numeric"
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(event) => {
          setText(event.target.value);
          setBad(false);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder={value === null ? t("clip:common.mixed") : undefined}
        value={text}
      />
    </label>
  );
}

/** One line of facts that are read rather than written. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export interface ClipFieldsProps {
  timeline: TimelineDocument;
  /** The chosen clips, in the order the timeline holds them. */
  clips: TimelineClip[];
}

export function ClipFields({ timeline, clips }: ClipFieldsProps) {
  const { t } = useTranslation();
  const fps = timeline.settings.fps;
  const playheadMs = useClipStore((state) => state.playheadMs);
  const many = clips.length > 1;
  const single = clips.length === 1 ? clips[0] : null;
  const playhead = frameAligned(playheadMs, fps);

  /**
   * One change, sent over every chosen clip as one step of history.
   *
   * The window, the frame clock and the material ceiling are decided by the
   * pure arithmetic in clipFields; the command layer still has the last word
   * about a neighbour a move would land on, and says so where it refuses.
   */
  const commit = (patches: { clipId: string; patch: ClipPatch }[]) => {
    const filled = patches.filter(
      (entry) => Object.keys(entry.patch).length > 0,
    );
    if (filled.length === 0) return;
    execute(
      t(many ? "clip:history.editClips" : "clip:history.editClip"),
      patchCommands(timeline.id, filled),
    );
  };

  // The pace of a picture is its own length, so the speed controls are shut
  // for any set that holds one rather than offering a move that is refused.
  const materials = clips.map((clip) => materialOf(clip));
  const speedLocked = materials.some((material) => speedIsLocked(material));
  const speed = sharedValue(clips.map((clip) => clip.speed));

  const applySpeed = (next: number) => {
    const built = clips.map((clip, index) => ({
      clipId: clip.id,
      patch: speedPatch(clip, next, materials[index].ownClock),
    }));
    if (built.some((entry) => entry.patch === null)) {
      // Why it will not run that fast: the shortest a clip is allowed to be,
      // which is the number the reader has to stay under.
      toast(
        "error",
        t("clip:clipFields.tooFastToast"),
        t("errors:timeline.clipTooShort", { count: MIN_CLIP_DURATION_MS }),
      );
      return;
    }
    commit(
      built.map((entry) => ({
        clipId: entry.clipId,
        patch: entry.patch ?? {},
      })),
    );
  };

  const start = sharedValue(clips.map((clip) => clip.startMs));
  const earliest = Math.min(...clips.map((clip) => clip.startMs));
  const applyStart = (wantedMs: number) => {
    // A set that disagrees moves rigidly, measured from its earliest head:
    // typing one moment into a mixed field says where the front of the run
    // goes rather than setting every block onto the same place.
    const delta = wantedMs - (start ?? earliest);
    commit(
      clips.map((clip) => ({
        clipId: clip.id,
        patch: startPatch(clip, clip.startMs + delta, fps),
      })),
    );
  };

  const duration = sharedValue(clips.map((clip) => clip.durationMs));
  const applyDuration = (wantedMs: number) => {
    commit(
      clips.map((clip, index) => ({
        clipId: clip.id,
        patch: durationPatch(clip, wantedMs, fps, materials[index]),
      })),
    );
  };

  const transformClips = clips.filter((clip) => clip.kind === "video");
  const firstTransform = transformClips[0]?.transform;
  const transformDefaults = { scale: 1, x: 0, y: 0, rotation: 0 };
  const applyTransform = (
    patch: Partial<{ scale: number; x: number; y: number; rotation: number }>,
  ) => {
    commit(
      transformClips.map((clip) => ({
        clipId: clip.id,
        patch: {
          transform: {
            ...transformDefaults,
            ...(clip.transform ?? {}),
            ...patch,
          },
        },
      })),
    );
  };

  const soundClips = clips.filter(materialHoldsSound);
  const volume = sharedValue(soundClips.map((clip) => clip.volume));
  const muted = sharedValue(soundClips.map((clip) => clip.muted));
  const [heldVolume, setHeldVolume] = useState<number | null>(null);
  const volumeShown = heldVolume ?? volume ?? 1;

  const fadeIn = sharedValue(soundClips.map((clip) => clip.fadeInMs));
  const fadeOut = sharedValue(soundClips.map((clip) => clip.fadeOutMs));
  const longest = Math.max(0, ...soundClips.map((clip) => clip.durationMs));

  const applyFade = (which: "in" | "out", valueMs: number) => {
    // A mixed pair of fades is written per clip from what that clip holds
    // as the other, so a set can share one number without losing its own.
    commit(
      soundClips.map((clip) => {
        const other = which === "in" ? clip.fadeOutMs : clip.fadeInMs;
        const own = clampFade(valueMs, clip.durationMs, other);
        return {
          clipId: clip.id,
          patch:
            which === "in"
              ? { fadeInMs: own, fadeOutMs: clip.fadeOutMs }
              : { fadeInMs: clip.fadeInMs, fadeOutMs: own },
        };
      }),
    );
  };

  const opacityClips = clips.filter((clip) => clip.kind !== "audio");
  const opacity = sharedValue(opacityClips.map((clip) => clip.opacity));
  const [heldOpacity, setHeldOpacity] = useState<number | null>(null);
  const opacityShown = heldOpacity ?? opacity ?? 1;

  const applyOpacity = (value: number) => {
    commit(
      opacityClips.map((clip) => ({
        clipId: clip.id,
        patch: { opacity: value },
      })),
    );
  };

  const crossing = clips.filter(
    (clip) =>
      clip.startMs < playhead && playhead < clip.startMs + clip.durationMs,
  ).length;

  // The text clips of the selection, and the style they agree on. A field the
  // set disagrees about reads as `Mixed`, and the words are editable exactly
  // when one clip is chosen: a whole-object patch has one content to carry.
  const textClips = clips.filter(
    (clip): clip is TimelineClip & { text: TextClipData } =>
      clip.kind === "text" && clip.text !== undefined,
  );
  const textDraft = useClipStore((state) => state.textDraft);
  const wordsEditable = clips.length === 1 && textClips.length === 1;
  const textBase = defaultTextStyle();
  const textStyles = textClips.map((clip) => clip.text.style);
  const mixedStyle = new Set<keyof TextClipStyle>(
    textStyles.length > 1
      ? (Object.keys(textBase) as (keyof TextClipStyle)[]).filter((key) => {
          const first = textStyles[0][key];
          return !textStyles.every((style) => style[key] === first);
        })
      : [],
  );
  const sharedTextStyle: TextClipStyle = {
    fontFamily:
      sharedValue(textStyles.map((style) => style.fontFamily)) ??
      textBase.fontFamily,
    fontSize:
      sharedValue(textStyles.map((style) => style.fontSize)) ??
      textBase.fontSize,
    color:
      sharedValue(textStyles.map((style) => style.color)) ?? textBase.color,
    bold: sharedValue(textStyles.map((style) => style.bold)) ?? textBase.bold,
    italic:
      sharedValue(textStyles.map((style) => style.italic)) ?? textBase.italic,
    align:
      sharedValue(textStyles.map((style) => style.align)) ?? textBase.align,
    position:
      sharedValue(textStyles.map((style) => style.position)) ??
      textBase.position,
    background: textStyles.every((style) => style.background === null)
      ? null
      : (sharedValue(textStyles.map((style) => style.background)) ??
        textBase.background),
    strokeWidth:
      sharedValue(textStyles.map((style) => style.strokeWidth)) ??
      textBase.strokeWidth,
    strokeColor:
      sharedValue(textStyles.map((style) => style.strokeColor)) ??
      textBase.strokeColor,
  };
  // A draft stands in for the same set of clips, exactly as a grade draft does.
  const drafted =
    textDraft !== null &&
    textDraft.clipIds.length === textClips.length &&
    textDraft.clipIds.every((id) => textClips.some((clip) => clip.id === id));
  const textValue: TextClipData = drafted
    ? textDraft.text
    : {
        content: wordsEditable ? textClips[0].text.content : "",
        style: sharedTextStyle,
      };

  /**
   * One change to the words, committed the way §2 says each gesture is.
   *
   * While a keystroke or a drag is still going on the value goes to the draft
   * in the store, which is what the compositor reads; the commit point sends
   * one whole-object patch — every chosen clip's own words kept when the set
   * is plural, since only the style could have been edited there. A commit is
   * measured against the document, never against the draft: a draft is by
   * definition different, and reading it as "already written" would leave the
   * words in the store and out of the cut.
   */
  const changeText = (next: TextClipData, committed: boolean) => {
    if (!timeline || textClips.length === 0) return;
    const text: TextClipData = {
      content: clampTextContent(next.content),
      style: legalStyle(next.style),
    };
    if (!committed) {
      useClipStore
        .getState()
        .setTextDraft({ clipIds: textClips.map((clip) => clip.id), text });
      return;
    }
    useClipStore.getState().setTextDraft(null);
    const patches = wordsEditable
      ? sameText(text, textClips[0].text)
        ? []
        : [{ clipId: textClips[0].id, patch: { text } }]
      : styleApplyPatches(textClips, text.style);
    if (patches.length === 0) return;
    execute(
      t(
        wordsEditable
          ? "clip:history.editTextClip"
          : "clip:history.editTextClips",
      ),
      patchCommands(timeline.id, patches),
    );
  };

  /** Gives every chosen text clip one whole style, leaving its words alone. */
  const applyTextPreset = (style: TextClipStyle) => {
    if (!timeline || textClips.length === 0) return;
    const patches = styleApplyPatches(textClips, style);
    if (patches.length === 0) return;
    execute(
      t(
        textClips.length === 1
          ? "clip:history.editTextClip"
          : "clip:history.editTextClips",
      ),
      patchCommands(timeline.id, patches),
    );
  };

  return (
    <div className="clip-inspector-body" data-testid="clip-fields">
      {textClips.length > 0 && (
        <section className="inspector-section">
          <h3>{t("clip:clipFields.textSection")}</h3>
          <div className="clip-text-presets" data-testid="clip-text-presets">
            {TEXT_STYLE_PRESETS.map((preset) => (
              <button
                className="link"
                data-testid={`clip-text-preset-${preset.id}`}
                key={preset.id}
                onClick={() => applyTextPreset(preset.style)}
                type="button"
              >
                {t(TEXT_STYLE_PRESET_LABELS[preset.id])}
              </button>
            ))}
          </div>
          <TextFields
            mixed={mixedStyle}
            onChange={changeText}
            onEscape={() => useClipStore.getState().setTextDraft(null)}
            value={textValue}
            words={wordsEditable}
          />
        </section>
      )}
      <section className="inspector-section">
        <h3>
          {many
            ? t("clip:clipFields.manyClips", { count: clips.length })
            : (single?.label ?? t("clip:common.clip"))}
        </h3>
        <div className="clip-inspector-pair">
          <TimecodeField
            fps={fps}
            label={t("clip:clipFields.start")}
            ms={start}
            onCommit={applyStart}
          />
          <TimecodeField
            fps={fps}
            label={t("clip:clipFields.duration")}
            ms={duration}
            onCommit={applyDuration}
          />
        </div>
        {start !== null && duration !== null && (
          <Row
            label={t("clip:clipFields.end")}
            value={formatTimecode(start + duration, fps)}
          />
        )}
        {single && single.kind !== "text" && single.assetId && (
          <>
            <Row
              label={t("clip:clipFields.in")}
              value={formatTimecode(single.inPointMs, fps)}
            />
            <Row
              label={t("clip:clipFields.out")}
              value={formatTimecode(single.outPointMs, fps)}
            />
          </>
        )}
      </section>

      <section className="inspector-section">
        <h3>{t("clip:clipFields.speedSection")}</h3>
        <div className="clip-inspector-speed">
          {SPEED_PRESETS.map((preset) => (
            <button
              aria-label={`${preset}×`}
              aria-pressed={speed === preset}
              disabled={speedLocked}
              key={preset}
              onClick={() => applySpeed(preset)}
              type="button"
            >
              {preset}×
            </button>
          ))}
        </div>
        <NumberField
          label={t("clip:clipFields.speedLabel")}
          max={MAX_CLIP_SPEED}
          min={MIN_CLIP_SPEED}
          onCommit={applySpeed}
          value={speed}
        />
        {speedLocked && (
          <p className="inspector-note">{t("clip:clipFields.speedLocked")}</p>
        )}
      </section>

      {transformClips.length > 0 && (
        <section className="inspector-section">
          <h3>{t("clip:clipFields.transformSection")}</h3>
          <div className="clip-inspector-pair">
            <NumberField
              label={t("clip:clipFields.scalePercent")}
              max={1_000}
              min={5}
              onCommit={(value) => applyTransform({ scale: value / 100 })}
              value={Math.round((firstTransform?.scale ?? 1) * 100)}
            />
            <NumberField
              label={t("clip:clipFields.rotation")}
              max={180}
              min={-180}
              onCommit={(value) => applyTransform({ rotation: value })}
              value={Math.round(firstTransform?.rotation ?? 0)}
            />
          </div>
          <div className="clip-inspector-pair">
            <NumberField
              label={t("clip:clipFields.positionX")}
              max={100}
              min={-100}
              onCommit={(value) => applyTransform({ x: value / 100 })}
              value={Math.round((firstTransform?.x ?? 0) * 100)}
            />
            <NumberField
              label={t("clip:clipFields.positionY")}
              max={100}
              min={-100}
              onCommit={(value) => applyTransform({ y: value / 100 })}
              value={Math.round((firstTransform?.y ?? 0) * 100)}
            />
          </div>
          <button
            onClick={() => applyTransform(transformDefaults)}
            type="button"
          >
            {t("clip:clipFields.resetTransform")}
          </button>
        </section>
      )}

      {soundClips.length > 0 && (
        <section className="inspector-section">
          <h3>{t("clip:clipFields.soundSection")}</h3>
          <div className="clip-inspector-slider">
            <input
              aria-label={t("clip:clipFields.volumeLabel")}
              max={MAX_CLIP_VOLUME}
              min={0}
              onChange={(event) => setHeldVolume(Number(event.target.value))}
              onBlur={() => {
                if (heldVolume !== null && heldVolume !== volume)
                  commit(
                    soundClips.map((clip) => ({
                      clipId: clip.id,
                      patch: { volume: heldVolume },
                    })),
                  );
                setHeldVolume(null);
              }}
              onPointerUp={() => {
                if (heldVolume !== null && heldVolume !== volume)
                  commit(
                    soundClips.map((clip) => ({
                      clipId: clip.id,
                      patch: { volume: heldVolume },
                    })),
                  );
                setHeldVolume(null);
              }}
              step={0.05}
              type="range"
              value={volumeShown}
            />
            <span>{volumeShown.toFixed(2)}</span>
          </div>
          <div className="clip-inspector-pair">
            <NumberField
              label={t("clip:clipFields.fadeIn")}
              max={longest}
              min={0}
              onCommit={(value) => applyFade("in", value)}
              value={fadeIn}
            />
            <NumberField
              label={t("clip:clipFields.fadeOut")}
              max={longest}
              min={0}
              onCommit={(value) => applyFade("out", value)}
              value={fadeOut}
            />
          </div>
          <button
            aria-label={t("clip:clipFields.mute")}
            aria-pressed={muted === true}
            onClick={() =>
              commit(
                soundClips.map((clip) => ({
                  clipId: clip.id,
                  patch: { muted: muted !== true },
                })),
              )
            }
            type="button"
          >
            {t("clip:clipFields.mute")}
          </button>
        </section>
      )}

      {opacityClips.length > 0 && (
        <section className="inspector-section">
          <h3>{t("clip:clipFields.opacitySection")}</h3>
          <div className="clip-inspector-slider">
            <input
              aria-label={t("clip:clipFields.opacityLabel")}
              max={1}
              min={0}
              onChange={(event) => setHeldOpacity(Number(event.target.value))}
              onBlur={() => {
                if (heldOpacity !== null && heldOpacity !== opacity)
                  applyOpacity(heldOpacity);
                setHeldOpacity(null);
              }}
              onPointerUp={() => {
                if (heldOpacity !== null && heldOpacity !== opacity)
                  applyOpacity(heldOpacity);
                setHeldOpacity(null);
              }}
              step={0.01}
              type="range"
              value={opacityShown}
            />
            <span>{opacityShown.toFixed(2)}</span>
          </div>
        </section>
      )}

      {single && (
        <section className="inspector-section">
          <h3>{t("clip:clipFields.nameSection")}</h3>
          <label className="clip-inspector-field">
            <span>{t("clip:clipFields.labelField")}</span>
            <input
              defaultValue={single.label}
              key={single.id}
              maxLength={CLIP_LABEL_MAX}
              onBlur={(event) => {
                const next = labelText(event.target.value);
                if (next !== null && next !== single.label)
                  commit([{ clipId: single.id, patch: { label: next } }]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        </section>
      )}

      <section className="inspector-section">
        <h3>{t("clip:clipFields.actionsSection")}</h3>
        <div className="clip-inspector-actions">
          <button
            disabled={crossing === 0}
            onClick={() => splitSelectionAtPlayhead()}
            type="button"
          >
            <ScissorsIcon size={14} /> {t("clip:common.splitAtPlayhead")}
          </button>
          <button onClick={() => duplicateSelection()} type="button">
            <DuplicateIcon size={14} /> {t("clip:common.duplicate")}
          </button>
          {clips.some((clip) => clip.kind === "video") && (
            <button onClick={() => detachAudio()} type="button">
              {t("clip:clipFields.detachAudio")}
            </button>
          )}
          <button
            className="danger"
            onClick={() => deleteSelection()}
            type="button"
          >
            <TrashIcon size={14} /> {t("clip:common.delete")}
          </button>
        </div>
      </section>
    </div>
  );
}
