import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { assetsApi } from "../../../api";
import type { StoryVoiceProfile } from "../../../shared/domain/types";
import { formatDuration } from "../../editor/canvas/mediaCards";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";

/**
 * The recording a voice is copied from, as a row of the card's own.
 *
 * A voice has two ways of being said — a name the provider knows and a piece
 * of sound to imitate — and this row holds the second: a recording of the
 * project's own, uploaded here or picked from the ones already filed. The row
 * shows the card's own choice; a card that names none but stands over a
 * narrator that does says what it follows rather than pretending to hold
 * nothing, and a recording whose file has left the project is said to be
 * missing rather than quietly cleared: what the document names is the
 * reader's to fix, not the row's to forget.
 */
export function VoiceReferencePicker({
  voice,
  fallbackVoice,
  onWrite,
  testId,
  buttonRef,
}: {
  /** The card's own voice, the empty one included. */
  voice: StoryVoiceProfile;
  /** The voice the chain resolves, which says what an empty row follows. */
  fallbackVoice: StoryVoiceProfile;
  /** Takes the whole voice, the recording picked into it or taken off. */
  onWrite: (voice: StoryVoiceProfile) => void;
  testId: string;
  /** The button a recording-less refusal opens the picker by. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const held = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (held.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Every sound the project holds, the recorded takes and the music alike:
  // a voice can be copied from either.
  const audios = [
    ...(moka?.resources.voice ?? []),
    ...(moka?.resources.music ?? []),
  ];
  const ownId = voice.referenceAssetId;
  const own =
    ownId === undefined
      ? undefined
      : audios.find((entry) => entry.id === ownId);
  const followed =
    fallbackVoice.referenceAssetId === undefined
      ? undefined
      : audios.find((entry) => entry.id === fallbackVoice.referenceAssetId);

  const write = (next: StoryVoiceProfile) => {
    onWrite(next);
    setOpen(false);
  };

  const clear = () => {
    const next = { ...voice };
    delete next.referenceAssetId;
    write(next);
  };

  const take = async (file: File) => {
    setUploading(true);
    try {
      // Filing a sound writes to the document on the server, so anything
      // still on its way there goes first.
      await useProjectStore.getState().flush();
      if (useProjectStore.getState().pending.length > 0) {
        const blocked = saveTrouble();
        useAppStore
          .getState()
          .pushToast("error", blocked.message, undefined, blocked.detail);
        return;
      }
      const filed = await assetsApi.upload(file, { categoryHint: "voice" });
      useProjectStore.getState().integrateAssetEntry(filed.entry, {
        revision: filed.revision,
        updatedAt: filed.updatedAt,
      });
      write({ ...voice, referenceAssetId: filed.entry.id });
    } catch (problem) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          problem instanceof Error ? problem.message : String(problem),
        );
    } finally {
      setUploading(false);
    }
  };

  const clearButton = () => (
    <button
      aria-label={t("story:elements.voiceReferenceClear")}
      className="story-ref-off"
      data-testid={`${testId}-clear`}
      onClick={clear}
      type="button"
    >
      ✕
    </button>
  );

  return (
    <div className="story-refs" data-testid={testId} ref={held}>
      <span
        className="story-refs-label"
        title={t("story:elements.voiceReferenceHint")}
      >
        {t("story:elements.voiceReference")}
      </span>
      {ownId === undefined ? (
        followed === undefined ? (
          <span className="story-hint" data-testid={`${testId}-none`}>
            {t("story:elements.voiceReferenceNone")}
          </span>
        ) : (
          <span
            className="story-ref is-followed"
            data-testid={`${testId}-followed`}
          >
            {t("story:elements.voiceReferenceFromNarrator", {
              name: followed.name,
            })}
          </span>
        )
      ) : own !== undefined ? (
        <span className="story-ref is-on">
          {own.name}
          {clearButton()}
        </span>
      ) : (
        <span className="story-ref is-gone" data-testid={`${testId}-missing`}>
          {t("story:elements.voiceReferenceMissing")}
          {clearButton()}
        </span>
      )}
      <button
        aria-label={t("story:elements.voiceReferencePick")}
        className="story-ref-add"
        data-testid={`${testId}-open`}
        onClick={() => setOpen(!open)}
        ref={buttonRef}
        title={t("story:elements.voiceReferencePick")}
        type="button"
      >
        +
      </button>
      {open && (
        <div
          aria-label={t("story:elements.voiceReference")}
          className="story-ref-menu"
          data-testid={`${testId}-menu`}
          role="menu"
        >
          <button
            className="story-ref-choice"
            data-testid={`${testId}-upload`}
            disabled={uploading}
            onClick={() => picker.current?.click()}
            role="menuitem"
            type="button"
          >
            {uploading
              ? t("story:elements.voiceReferenceUploading")
              : t("story:elements.voiceReferenceUpload")}
          </button>
          {audios.length === 0 && (
            <span className="story-hint">
              {t("story:elements.voiceReferenceEmpty")}
            </span>
          )}
          {audios.map((entry) => {
            const length = formatDuration(entry.probe?.durationMs);
            return (
              <button
                aria-checked={entry.id === ownId}
                className={`story-ref-choice${entry.id === ownId ? " is-on" : ""}`}
                data-testid={`${testId}-choice-${entry.name}`}
                key={entry.id}
                onClick={() => write({ ...voice, referenceAssetId: entry.id })}
                role="menuitemcheckbox"
                type="button"
              >
                {entry.name}
                {length !== "" && <span className="story-hint">{length}</span>}
              </button>
            );
          })}
        </div>
      )}
      <input
        accept="audio/*"
        className="story-file"
        data-testid={`${testId}-file`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void take(file);
          event.target.value = "";
        }}
        ref={picker}
        type="file"
      />
    </div>
  );
}
