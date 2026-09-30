import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { filesystemApi } from "../../../api";
import {
  defaultTextStyle,
  type TextClipData,
  type TimelineClip,
} from "../../../shared/domain";
import { trackClipsInOrder } from "../../../shared/domain/timeline";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { TextFields } from "../inspector/TextFields";
import { materialHoldsSound } from "../interactions/clipActions";
import {
  MAX_SUBTITLE_FILE_BYTES,
  addTextClipAtPlayhead,
  cueSummary,
  importSrt,
} from "../interactions/textActions";
import { useClipStore } from "../stores/clipStore";
import { useTranscribeStore } from "../stores/transcribeStore";
import { cueOfClip, serializeSrt } from "../subtitles/srt";
import { sourceClip } from "../subtitles/transcribe";
import {
  TEXT_STYLE_PRESETS,
  presetById,
  type TextStylePresetId,
} from "../textStyles";
import { formatTimecode } from "../timeline/timecode";

/**
 * The Text page: the words about to be laid down, and the words already on
 * the cut.
 *
 * The composer is a text clip's shape held as a form — one style, and the
 * words being written with it — and `Add at the playhead` turns it into a
 * clip through the same planning the inspector edits after the fact. Adding
 * costs the words and keeps the style, so a run of subtitles is written
 * without setting the same look again for each line.
 *
 * Below it the subtitle tools: an `.srt` brought in as a whole batch of clips
 * in one step of history, a speech recognizer asked to write one, the text
 * track being read written back out as an `.srt`, and the cue list — every
 * text clip of that track, in time order — where a click chooses the clip and
 * takes the playhead to its words.
 *
 * The tools read one track: the one a chosen text clip stands on, and the
 * first text row otherwise. That is what makes a transcript visible the moment
 * it lands — it is put on a row of its own, and its first cue is chosen for
 * it — while bringing a file in and writing one out keep meaning the same row.
 *
 * The page reads the selection and never writes back to the composer: editing
 * a chosen clip is the inspector's job, and two forms over one clip would
 * take turns overwriting each other.
 */

/** What the picker calls each preset of the four the page offers. */
const PRESET_LABELS: Record<TextStylePresetId, string> = {
  basic: "clip:textPresets.basic",
  title: "clip:textPresets.title",
  lowerThird: "clip:textPresets.lowerThird",
  caption: "clip:textPresets.caption",
};

/**
 * The languages a recording can be said to be in, by the code a recognizer
 * knows. `auto` is the absence of an answer rather than one of them, which is
 * why it is the first choice and why nothing is sent when it stands.
 */
const LANGUAGES = ["auto", "zh", "en", "ja", "ko", "yue"] as const;

const LANGUAGE_LABELS: Record<(typeof LANGUAGES)[number], string> = {
  auto: "clip:textPanel.languageAuto",
  zh: "clip:textPanel.languageZh",
  en: "clip:textPanel.languageEn",
  ja: "clip:textPanel.languageJa",
  ko: "clip:textPanel.languageKo",
  yue: "clip:textPanel.languageYue",
};

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

export function TextPanel() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const clipIds = useClipStore((state) => state.selection.clipIds);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const phase = useTranscribeStore((state) => state.phase);
  const transcribeError = useTranscribeStore((state) => state.error);
  const timeline =
    (moka?.timelines ?? []).find((each) => each.id === activeTimelineId) ??
    null;
  const [composer, setComposer] = useState<TextClipData>(() => ({
    content: "",
    style: defaultTextStyle(),
  }));
  const [presetId, setPresetId] = useState<string>("basic");
  const [language, setLanguage] = useState<string>("auto");
  const [diarize, setDiarize] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The subtitle tools read one text track: the one a chosen text clip is on,
  // and the first of them otherwise. A transcript lands on a row of its own,
  // so following the selection is what lets the reader see what just arrived.
  const shownTrack = useMemo(() => {
    const textTracks = (timeline?.tracks ?? []).filter(
      (track) => track.kind === "text",
    );
    if (!timeline || textTracks.length === 0) return null;
    const chosen = timeline.clips.find(
      (clip) => clipIds.includes(clip.id) && clip.kind === "text",
    );
    const holder = textTracks.find((track) => track.id === chosen?.trackId);
    return holder ?? textTracks[0];
  }, [timeline, clipIds]);
  const cues = useMemo(() => {
    if (!timeline || !shownTrack) return [];
    return trackClipsInOrder(timeline, shownTrack.id).filter(
      (clip) => clip.kind === "text",
    );
  }, [timeline, shownTrack]);
  const fps = timeline?.settings.fps ?? 30;
  // What recognition would be asked about, by the rule the ask itself uses.
  const source = useMemo(
    () =>
      timeline
        ? sourceClip(timeline, clipIds, playheadMs, materialHoldsSound)
        : null,
    [timeline, clipIds, playheadMs],
  );
  const busy = phase !== "idle";

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = presetById(id);
    if (!preset) return;
    // A preset fills the whole style and never the words.
    setComposer((held) => ({
      content: held.content,
      style: { ...preset.style },
    }));
  };

  const add = () => {
    const clip = addTextClipAtPlayhead(composer.content, composer.style);
    if (!clip) return;
    // The words are spent, the style stays: the next line is the same look.
    setComposer((held) => ({ content: "", style: held.style }));
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The input lets go of the file at once, so choosing the same one twice
    // is still a change.
    event.target.value = "";
    if (!file || !timeline) return;
    if (file.size > MAX_SUBTITLE_FILE_BYTES) {
      toast("error", t("clip:textPanel.fileTooLarge"));
      return;
    }
    const text = await file.text();
    importSrt(text, composer.style);
  };

  const exportSrt = async () => {
    if (!timeline || cues.length === 0) return;
    const blob = new Blob([serializeSrt(cues.map(cueOfClip))], {
      type: "application/x-subrip",
    });
    const destination = await askSavePath({
      title: t("clip:textPanel.saveSrtTitle"),
      defaultName: `${fileSafeName(timeline.name)}.srt`,
      extensions: ["srt"],
    });
    if (destination === null) return;
    try {
      await filesystemApi.write(destination, blob);
      toast("success", t("clip:textPanel.srtSaved", { path: destination }));
    } catch (problem) {
      toast(
        "error",
        problem instanceof Error ? problem.message : String(problem),
      );
    }
  };

  /** A cue row's click: choose the clip it stands for and go to its words. */
  const jump = (clip: TimelineClip) => {
    useClipStore.getState().select({ clipIds: [clip.id], transitionId: null });
    useClipStore.getState().setPlayhead(clip.startMs);
  };

  // Why the one button of the transcription row cannot be pressed, if it
  // cannot: the reading itself is the store's from the moment it starts.
  const blocked = !timeline
    ? t("clip:textPanel.noTimeline")
    : source === null
      ? t("clip:textPanel.noSourceClip")
      : null;
  const ask = () => {
    void useTranscribeStore.getState().start({
      style: composer.style,
      language: language === "auto" ? "" : language,
      // The words around the speaker's number belong to whoever is reading,
      // and a recognizer only knows how to count.
      speakerLabel: diarize ? t("clip:textPanel.speakerLabel") : "",
    });
  };
  const busyLabel = t(
    phase === "submitting"
      ? "clip:textPanel.transcribingSubmit"
      : phase === "landing"
        ? "clip:textPanel.transcribingLand"
        : "clip:textPanel.transcribing",
  );

  return (
    <div className="clip-text-page" data-testid="clip-text-panel">
      <label className="clip-text-field">
        <span className="clip-text-label">{t("clip:textPanel.preset")}</span>
        <select
          aria-label={t("clip:textPanel.preset")}
          onChange={(event) => applyPreset(event.target.value)}
          value={presetId}
        >
          {TEXT_STYLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {t(PRESET_LABELS[preset.id])}
            </option>
          ))}
        </select>
      </label>

      <TextFields
        onChange={(next) => setComposer(next)}
        value={composer}
        words
      />

      <button
        className="clip-text-add"
        disabled={!timeline || composer.content.trim().length === 0}
        onClick={add}
        type="button"
      >
        {t("clip:common.addAtPlayhead")}
      </button>

      <section className="clip-text-subtitles">
        <div className="clip-text-subtitle-head">
          <h3>{t("clip:textPanel.subtitles")}</h3>
          <div className="clip-text-subtitle-actions">
            <button
              disabled={!timeline}
              onClick={() => fileRef.current?.click()}
              type="button"
            >
              {t("clip:textPanel.importSrt")}
            </button>
            <button
              disabled={cues.length === 0}
              onClick={exportSrt}
              type="button"
            >
              {t("clip:textPanel.exportSrt")}
            </button>
          </div>
        </div>
        <input
          accept=".srt,.txt"
          aria-label={t("clip:textPanel.importSubtitles")}
          className="clip-text-file"
          onChange={(event) => void onFile(event)}
          ref={fileRef}
          type="file"
        />

        <div className="clip-text-transcribe">
          <label className="clip-text-field">
            <span className="clip-text-label">
              {t("clip:textPanel.language")}
            </span>
            <select
              aria-label={t("clip:textPanel.language")}
              disabled={busy}
              onChange={(event) => setLanguage(event.target.value)}
              value={language}
            >
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(LANGUAGE_LABELS[code])}
                </option>
              ))}
            </select>
          </label>
          {/* The option and the ask it changes travel as one: however the row
              wraps, telling speakers apart never drifts away from the button
              it belongs to. */}
          <div className="clip-text-transcribe-run">
            <label className="clip-text-check">
              <input
                checked={diarize}
                disabled={busy}
                onChange={(event) => setDiarize(event.target.checked)}
                type="checkbox"
              />
              <span>{t("clip:textPanel.diarize")}</span>
            </label>
            <button
              className="clip-text-transcribe-go"
              disabled={busy || blocked !== null}
              onClick={ask}
              title={busy ? busyLabel : (blocked ?? undefined)}
              type="button"
            >
              {busy ? busyLabel : t("clip:textPanel.transcribe")}
            </button>
          </div>
        </div>
        {transcribeError ? (
          <p className="clip-text-hint" role="alert">
            {transcribeError}
          </p>
        ) : null}

        {cues.length === 0 ? (
          <p className="clip-text-hint">{t("clip:textPanel.noClips")}</p>
        ) : (
          <div className="clip-subtitle-list">
            {cues.map((clip) => (
              <button
                className={
                  clipIds.includes(clip.id)
                    ? "clip-subtitle-row is-selected"
                    : "clip-subtitle-row"
                }
                data-clip-id={clip.id}
                data-testid="clip-subtitle-row"
                key={clip.id}
                onClick={() => jump(clip)}
                type="button"
              >
                <span className="clip-subtitle-time">
                  {formatTimecode(clip.startMs, fps)}
                </span>
                <span className="clip-subtitle-text">
                  {cueSummary(clip.text?.content ?? "")}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
