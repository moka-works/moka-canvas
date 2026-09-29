import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isApiError } from "../../../api/client";
import { generateApi } from "../../../api/generate";
import type {
  StoryDocument,
  StoryVoiceProfile,
} from "../../../shared/domain/types";
import { useAppStore } from "../../editor/stores/appStore";
import { voiceParamsFor } from "../jobs/plan";

/**
 * The bytes of a made sound as something a player can hold.
 *
 * A try-out writes nothing into the project, so its sound lives only as long
 * as the card does and is let go when the card lets it go: the URL is the
 * reader's session, not the shelf's.
 */
function bytesToObjectUrl(data: string, mime: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/**
 * A voice heard before it is kept.
 *
 * The words are the character's own first line where the telling gives one,
 * read with the same voice and the same direction an ask would carry, so
 * what is heard here and what is filmed later are the same thing. Nothing
 * is filed: the sound is played from the answer and dropped with the card.
 */
export function VoiceTryout({
  story,
  voice,
  sample,
  tone,
  testId,
  disabledReason,
}: {
  story: StoryDocument;
  /** The voice as the chain resolves it, not as the card alone holds it. */
  voice: StoryVoiceProfile;
  /** The words heard: a real line where there is one, a sample otherwise. */
  sample: string;
  tone?: string;
  testId: string;
  /** Why the button cannot be pressed, when it cannot. */
  disabledReason?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (url === null) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const tryIt = async () => {
    if (busy || disabledReason !== undefined) return;
    setBusy(true);
    try {
      const answer = await generateApi.speech({
        capability: "speech",
        ...(voice.model !== "" ? { model: voice.model } : {}),
        prompt: sample,
        params: voiceParamsFor(
          story,
          voice,
          tone === undefined ? {} : { tone },
        ),
      });
      const made =
        answer.outputs.find((output) => output.kind === "speech") ??
        answer.outputs[0];
      if (made === undefined) {
        useAppStore
          .getState()
          .pushToast("error", t("story:elements.voiceTryFailed"));
        return;
      }
      setUrl(bytesToObjectUrl(made.data, made.mime));
    } catch (error) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          t("story:elements.voiceTryFailed"),
          undefined,
          isApiError(error) ? error.message : undefined,
        );
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="story-voice-tryout">
      <button
        className="link"
        data-testid={testId}
        disabled={busy || disabledReason !== undefined}
        onClick={() => void tryIt()}
        title={disabledReason}
        type="button"
      >
        {busy && <span className="story-spin" />}
        {busy ? t("story:elements.voiceTryBusy") : t("story:elements.voiceTry")}
      </button>
      {url !== null && (
        // A sound the reader asked to hear, heard once it arrives.
        <audio autoPlay controls data-testid={`${testId}-player`} src={url} />
      )}
    </span>
  );
}
