import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  VOICE_PITCH_MAX,
  VOICE_PITCH_MIN,
  VOICE_RATE_MAX,
  VOICE_RATE_MIN,
} from "../../../shared/domain/constants";
import { firstLineOf, lineCountFor, voiceNamed } from "../../../shared/domain";
import type {
  StoryDocument,
  StoryVoiceProfile,
} from "../../../shared/domain/types";
import { ModelPicker } from "../../settings/ModelPicker";
import { modelOptionsFor, useModelStore } from "../../settings/modelStore";
import { VoiceReferencePicker } from "./VoiceReferencePicker";
import { VoiceTryout } from "./VoiceTryout";
import { useField } from "./useField";

/** The empty voice a card starts from before its first field is written. */
const NO_VOICE: StoryVoiceProfile = { model: "", voice: "" };

/**
 * The voice one speaking part of the telling is read in: a model, a tone, a
 * recording to copy, a pace, a pitch, and the manner of the character
 * saying it.
 *
 * Every field left empty is handed to the next layer of the chain — the
 * story's narrator, this machine's own pick, the deployment's default — which
 * is what the picker's empty choice and the fields' placeholders say. A card
 * whose fields are all empty holds no voice at all rather than a voice with
 * nothing said about it, so clearing what was the last thing said of a
 * character takes the voice off the element.
 */
export function VoiceFields({
  story,
  voice,
  onWrite,
  testId,
  characterId,
  fallbackVoice,
}: {
  story: StoryDocument;
  voice: StoryVoiceProfile | undefined;
  /** Takes the whole voice, or null when nothing is left of it. */
  onWrite: (voice: StoryVoiceProfile | null) => void;
  testId: string;
  /** The character whose card this is; a narrator has none. */
  characterId?: string;
  /** The voice as the chain resolves it, which is what a try-out hears. */
  fallbackVoice: StoryVoiceProfile;
}) {
  const { t } = useTranslation();
  const speech = useModelStore((state) => state.view?.preferences.speech);
  const held = voice ?? NO_VOICE;
  const onMachine = modelOptionsFor(
    useModelStore.getState().view,
    "speech",
  ).some((option) => option.reference === held.model);
  const orphan = held.model !== "" && !onMachine;
  const tone = useField(held.voice, (value) =>
    write({ ...held, voice: value }),
  );
  const toneField = useRef<HTMLInputElement>(null);
  const referenceButton = useRef<HTMLButtonElement>(null);
  const manner = useField(held.instructions ?? "", (value) =>
    write(withManner(held, value)),
  );

  function write(next: StoryVoiceProfile) {
    onWrite(voiceNamed(next) ? next : null);
  }

  const lines =
    characterId === undefined ? undefined : lineCountFor(story, characterId);
  const line =
    characterId === undefined ? undefined : firstLineOf(story, characterId);
  return (
    <div className="story-voice" data-testid={testId}>
      <div className="story-voice-row">
        <div className="story-voice-model" data-testid={`${testId}-model`}>
          <ModelPicker
            capability="speech"
            label={t("story:elements.voiceModel")}
            noneLabel={t("story:elements.voiceModelNone")}
            onChange={(reference) => write({ ...held, model: reference ?? "" })}
            value={held.model === "" ? null : held.model}
          />
        </div>
        <label className="story-field-label story-voice-tone">
          <span>{t("story:elements.voiceTone")}</span>
          <input
            data-testid={`${testId}-tone`}
            onBlur={tone.commit}
            ref={toneField}
            onChange={(event) => tone.set(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              tone.commit();
            }}
            placeholder={speech?.voice ?? ""}
            value={tone.value}
          />
        </label>
      </div>
      <div className="story-voice-row">
        <VoiceReferencePicker
          buttonRef={referenceButton}
          fallbackVoice={fallbackVoice}
          onWrite={write}
          testId={`${testId}-reference`}
          voice={held}
        />
      </div>
      <div className="story-voice-row">
        <NumberField
          label={t("story:elements.voiceRate")}
          max={VOICE_RATE_MAX}
          min={VOICE_RATE_MIN}
          onCommit={(value) => write(withNumber(held, "rate", value))}
          placeholder={speech?.rate === undefined ? "" : String(speech.rate)}
          testId={`${testId}-rate`}
          value={held.rate}
        />
        <NumberField
          label={t("story:elements.voicePitch")}
          max={VOICE_PITCH_MAX}
          min={VOICE_PITCH_MIN}
          onCommit={(value) => write(withNumber(held, "pitch", value))}
          placeholder={speech?.pitch === undefined ? "" : String(speech.pitch)}
          testId={`${testId}-pitch`}
          value={held.pitch}
        />
        <label className="story-field-label story-voice-manner">
          <span>{t("story:elements.voiceManner")}</span>
          <input
            data-testid={`${testId}-manner`}
            onBlur={manner.commit}
            onChange={(event) => manner.set(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              manner.commit();
            }}
            placeholder={t("story:elements.voiceMannerTip")}
            value={manner.value}
          />
        </label>
      </div>
      <div className="story-voice-row">
        <span className="story-hint" data-testid={`${testId}-state`}>
          {orphan
            ? t("story:elements.voiceOrphan")
            : voiceNamed(voice)
              ? t("story:elements.voiceSet")
              : t("story:elements.voiceUnset")}
        </span>
        {lines !== undefined && (
          <span className="story-hint" data-testid={`${testId}-lines`}>
            {lines === 0
              ? t("story:elements.voiceNoLines")
              : t("story:elements.voiceLines", { count: lines })}
          </span>
        )}
        <VoiceTryout
          disabledReason={
            orphan ? t("story:elements.voiceOrphanNote") : undefined
          }
          // A try-out refused for want of a voice is answered where it was
          // raised: the field on this very card is the first link of the
          // chain the refusal is about, and so is the recording row.
          onVoiceMissing={() => toneField.current?.focus()}
          onReferenceMissing={() => referenceButton.current?.click()}
          sample={line?.text.trim() ?? t("story:voice.sample")}
          story={story}
          testId={`${testId}-try`}
          tone={line?.tone}
          voice={fallbackVoice}
        />
      </div>
    </div>
  );
}

/** A manner said or taken back: an empty line is no manner at all. */
function withManner(
  held: StoryVoiceProfile,
  manner: string,
): StoryVoiceProfile {
  const next = { ...held };
  const said = manner.trim();
  if (said === "") delete next.instructions;
  else next.instructions = said;
  return next;
}

/** A pace or pitch written, or taken off so the next layer's holds. */
function withNumber(
  held: StoryVoiceProfile,
  field: "rate" | "pitch",
  value: number | null,
): StoryVoiceProfile {
  const next = { ...held };
  if (value === null) delete next[field];
  else next[field] = value;
  return next;
}

/**
 * A number a reader types, kept to the bounds the command checks.
 *
 * The field holds letters while they are being typed and settles on what the
 * document says when it loses focus: a pace nobody could read at is brought
 * to the nearest one a provider would take rather than handed over to be
 * refused, and an emptied field takes the number off the voice.
 */
function NumberField({
  label,
  value,
  min,
  max,
  placeholder,
  testId,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  placeholder: string;
  testId: string;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    setText(value === undefined ? "" : String(value));
  }, [value]);

  const commit = () => {
    const typed = text.trim();
    if (typed === "") {
      onCommit(null);
      return;
    }
    const parsed = Number(typed);
    if (!Number.isFinite(parsed)) {
      setText(value === undefined ? "" : String(value));
      return;
    }
    const held = Math.min(max, Math.max(min, parsed));
    setText(String(held));
    onCommit(held);
  };

  return (
    <label className="story-field-label story-voice-number">
      <span>{label}</span>
      <input
        data-testid={testId}
        max={max}
        min={min}
        onBlur={commit}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
        placeholder={placeholder}
        step={0.05}
        type="number"
        value={text}
      />
    </label>
  );
}
