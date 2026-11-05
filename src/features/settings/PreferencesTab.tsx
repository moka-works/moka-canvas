import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GenerationPreferences,
  ImagePreferences,
  MusicPreferences,
  PreferencesPatch,
  SpeechPreferences,
  StoryPreferences,
  VideoPreferences,
} from "../../api";
import {
  MAX_AUDIO_SPEED,
  MAX_IMAGES_PER_RUN,
  MAX_VIDEO_SECONDS,
  MIN_AUDIO_SPEED,
  STORY_CHARS_MAX,
  STORY_CHARS_MIN,
} from "../../shared/domain";
import { useModelStore } from "./modelStore";
import {
  ASKING_A_MODEL,
  BAR_ENTRIES,
  PICTURE_TOOLS,
  TOOL_LABELS,
  useToolPrefs,
} from "../editor/stores/toolPrefs";

/** A blank number field keeps its last value rather than becoming zero. */
function toNumber(value: string, fallback: number): number {
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** These are plain data, so comparing them is comparing their serialisation. */
function differs(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** The groups are objects, so adopting the stored preferences means copying. */
function clone(preferences: GenerationPreferences): GenerationPreferences {
  return {
    ...preferences,
    image: { ...preferences.image },
    video: { ...preferences.video },
    speech: { ...preferences.speech },
    music: { ...preferences.music },
    story: { ...preferences.story },
  };
}

/**
 * The generation defaults a node inherits.
 *
 * Only what moved is sent: a group travels whole because half of a
 * size-and-quality pair means nothing, but an untouched group is left alone so
 * that saving here cannot undo a change made somewhere else.
 */
function GenerationDefaults() {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const [draft, setDraft] = useState<GenerationPreferences | null>(() =>
    view ? clone(view.preferences) : null,
  );

  useEffect(() => {
    if (view) setDraft(clone(view.preferences));
  }, [view]);

  if (!view || !draft) {
    return <p className="settings-hint">{t("settings:loading")}</p>;
  }

  const stored = view.preferences;
  const patch: PreferencesPatch = {};
  if (draft.systemPrompt !== stored.systemPrompt) {
    patch.systemPrompt = draft.systemPrompt;
  }
  if (draft.reasoningEffort !== stored.reasoningEffort) {
    patch.reasoningEffort = draft.reasoningEffort;
  }
  if (differs(draft.image, stored.image)) patch.image = draft.image;
  if (differs(draft.video, stored.video)) patch.video = draft.video;
  if (differs(draft.speech, stored.speech)) patch.speech = draft.speech;
  if (differs(draft.music, stored.music)) patch.music = draft.music;
  if (differs(draft.story, stored.story)) patch.story = draft.story;
  const changed = Object.keys(patch).length > 0;

  const edit = (next: Partial<GenerationPreferences>) =>
    setDraft((state) => state && { ...state, ...next });
  const editImage = (next: Partial<ImagePreferences>) =>
    setDraft(
      (state) => state && { ...state, image: { ...state.image, ...next } },
    );
  const editVideo = (next: Partial<VideoPreferences>) =>
    setDraft(
      (state) => state && { ...state, video: { ...state.video, ...next } },
    );
  const editSpeech = (next: Partial<SpeechPreferences>) =>
    setDraft(
      (state) => state && { ...state, speech: { ...state.speech, ...next } },
    );
  const editMusic = (next: Partial<MusicPreferences>) =>
    setDraft(
      (state) => state && { ...state, music: { ...state.music, ...next } },
    );
  const editStory = (next: Partial<StoryPreferences>) =>
    setDraft(
      (state) => state && { ...state, story: { ...state.story, ...next } },
    );

  return (
    <div className="settings-section">
      <label className="dialog-field">
        <span>{t("settings:generation.systemPrompt")}</span>
        <textarea
          onChange={(event) => edit({ systemPrompt: event.target.value })}
          placeholder={t("settings:generation.systemPromptTip")}
          rows={3}
          value={draft.systemPrompt}
        />
      </label>

      <label className="dialog-field">
        <span>{t("settings:generation.reasoningEffort")}</span>
        <input
          onChange={(event) => edit({ reasoningEffort: event.target.value })}
          placeholder="auto"
          value={draft.reasoningEffort}
        />
      </label>

      <section
        aria-label={t("settings:generation.imageDefaults")}
        className="settings-section"
      >
        <h3 className="settings-heading">{t("settings:generation.image")}</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>{t("settings:generation.size")}</span>
            <input
              onChange={(event) => editImage({ size: event.target.value })}
              placeholder="1:1"
              value={draft.image.size}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.quality")}</span>
            <input
              onChange={(event) => editImage({ quality: event.target.value })}
              placeholder="auto"
              value={draft.image.quality}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.background")}</span>
            <input
              onChange={(event) =>
                editImage({ background: event.target.value })
              }
              placeholder="auto"
              value={draft.image.background}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.imagesPerRun")}</span>
            <input
              max={MAX_IMAGES_PER_RUN}
              min={1}
              onChange={(event) =>
                editImage({ count: toNumber(event.target.value, 1) })
              }
              step={1}
              type="number"
              value={draft.image.count}
            />
          </label>
        </div>
      </section>

      <section
        aria-label={t("settings:generation.videoDefaults")}
        className="settings-section"
      >
        <h3 className="settings-heading">{t("settings:generation.video")}</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>{t("settings:generation.seconds")}</span>
            <input
              max={MAX_VIDEO_SECONDS}
              min={1}
              onChange={(event) =>
                editVideo({ seconds: toNumber(event.target.value, 1) })
              }
              step={1}
              type="number"
              value={draft.video.seconds}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.resolution")}</span>
            <input
              onChange={(event) =>
                editVideo({ resolution: event.target.value })
              }
              placeholder="720"
              value={draft.video.resolution}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.mode")}</span>
            <input
              onChange={(event) => editVideo({ mode: event.target.value })}
              placeholder="auto"
              value={draft.video.mode}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.aspectRatio")}</span>
            <input
              onChange={(event) => editVideo({ ratio: event.target.value })}
              placeholder="16:9"
              value={draft.video.ratio}
            />
          </label>
        </div>
        <label className="settings-check">
          <input
            checked={draft.video.generateAudio}
            onChange={(event) =>
              editVideo({ generateAudio: event.target.checked })
            }
            type="checkbox"
          />
          <span>{t("settings:generation.generateAudio")}</span>
        </label>
        <label className="settings-check">
          <input
            checked={draft.video.watermark}
            onChange={(event) => editVideo({ watermark: event.target.checked })}
            type="checkbox"
          />
          <span>{t("settings:generation.watermark")}</span>
        </label>
      </section>

      <section
        aria-label={t("settings:generation.speechDefaults")}
        className="settings-section"
      >
        <h3 className="settings-heading">{t("settings:generation.speech")}</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>{t("settings:generation.voice")}</span>
            <input
              onChange={(event) => editSpeech({ voice: event.target.value })}
              placeholder={t("settings:generation.voiceTip")}
              value={draft.speech.voice}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.format")}</span>
            <input
              onChange={(event) => editSpeech({ format: event.target.value })}
              placeholder="mp3"
              value={draft.speech.format}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.speed")}</span>
            <input
              max={MAX_AUDIO_SPEED}
              min={MIN_AUDIO_SPEED}
              onChange={(event) =>
                editSpeech({ speed: toNumber(event.target.value, 1) })
              }
              step={0.05}
              type="number"
              value={draft.speech.speed}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.sampleRate")}</span>
            <input
              max={48000}
              min={8000}
              onChange={(event) =>
                editSpeech({ sampleRate: toNumber(event.target.value, 22050) })
              }
              step={100}
              type="number"
              value={draft.speech.sampleRate}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.volume")}</span>
            <input
              max={100}
              min={0}
              onChange={(event) =>
                editSpeech({ volume: toNumber(event.target.value, 50) })
              }
              type="number"
              value={draft.speech.volume}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.rate")}</span>
            <input
              max={2}
              min={0.5}
              onChange={(event) =>
                editSpeech({ rate: toNumber(event.target.value, 1) })
              }
              step={0.05}
              type="number"
              value={draft.speech.rate}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.pitch")}</span>
            <input
              max={2}
              min={0.5}
              onChange={(event) =>
                editSpeech({ pitch: toNumber(event.target.value, 1) })
              }
              step={0.05}
              type="number"
              value={draft.speech.pitch}
            />
          </label>
        </div>
        <label className="dialog-field">
          <span>{t("settings:generation.voiceInstructions")}</span>
          <input
            onChange={(event) =>
              editSpeech({ instructions: event.target.value })
            }
            placeholder={t("settings:generation.voiceInstructionsTip")}
            value={draft.speech.instructions}
          />
        </label>
      </section>

      <section
        aria-label={t("settings:generation.musicDefaults")}
        className="settings-section"
      >
        <h3 className="settings-heading">{t("settings:generation.music")}</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>{t("settings:generation.format")}</span>
            <input
              onChange={(event) => editMusic({ format: event.target.value })}
              placeholder="mp3"
              value={draft.music.format}
            />
          </label>
        </div>
        <label className="settings-check">
          <input
            checked={draft.music.watermark}
            onChange={(event) => editMusic({ watermark: event.target.checked })}
            type="checkbox"
          />
          <span>{t("settings:generation.watermark")}</span>
        </label>
      </section>

      <section
        aria-label={t("settings:generation.storyDefaults")}
        className="settings-section"
      >
        <h3 className="settings-heading">{t("settings:generation.story")}</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>{t("settings:generation.splitChars")}</span>
            <input
              max={STORY_CHARS_MAX}
              min={STORY_CHARS_MIN}
              onChange={(event) =>
                editStory({
                  splitChars: toNumber(
                    event.target.value,
                    draft.story.splitChars,
                  ),
                })
              }
              step={500}
              type="number"
              value={draft.story.splitChars}
            />
          </label>
          <label className="dialog-field">
            <span>{t("settings:generation.readChars")}</span>
            <input
              max={STORY_CHARS_MAX}
              min={STORY_CHARS_MIN}
              onChange={(event) =>
                editStory({
                  readChars: toNumber(
                    event.target.value,
                    draft.story.readChars,
                  ),
                })
              }
              step={500}
              type="number"
              value={draft.story.readChars}
            />
          </label>
        </div>
        <p className="settings-hint">
          {t("settings:generation.splitCharsTip")}
        </p>
        <p className="settings-hint">{t("settings:generation.readCharsTip")}</p>
      </section>

      <div className="dialog-actions">
        <button
          className="primary"
          disabled={saving || !changed}
          onClick={() => void useModelStore.getState().savePreferences(patch)}
          type="button"
        >
          {saving ? t("settings:saving") : t("settings:generation.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * Which picture tools the row over a node offers.
 *
 * Kept on this machine rather than in the document, so what somebody has tidied
 * stays tidied for them and travels in no package. Unticking a tool hides it from
 * the row and nothing else: it is not removed from the project, and whatever it
 * already made stays exactly where it was put.
 */
function NodeToolChoices() {
  const { t } = useTranslation();
  const shown = useToolPrefs((state) => state.shown);
  const toggleShown = useToolPrefs((state) => state.toggleShown);
  const listed = PICTURE_TOOLS.map((tool) => t(TOOL_LABELS[tool])).join(
    t("settings:join.list"),
  );
  const asked = ASKING_A_MODEL.map((tool) => t(TOOL_LABELS[tool])).join(
    t("settings:join.and"),
  );
  return (
    <section
      aria-label={t("settings:pictureTools.label")}
      className="settings-section"
    >
      <h3 className="settings-heading">{t("settings:pictureTools.heading")}</h3>
      <div className="settings-columns">
        {BAR_ENTRIES.map((tool) => (
          <label className="settings-check" key={tool}>
            <input
              checked={shown.includes(tool)}
              onChange={() => toggleShown(tool)}
              type="checkbox"
            />
            <span>{t(TOOL_LABELS[tool])}</span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        {t("settings:pictureTools.hint", { tools: listed, asks: asked })}
      </p>
      <p className="settings-hint">{t("settings:pictureTools.note")}</p>
    </section>
  );
}

export function PreferencesTab() {
  return (
    <div className="settings-section">
      <NodeToolChoices />
      <GenerationDefaults />
    </div>
  );
}
