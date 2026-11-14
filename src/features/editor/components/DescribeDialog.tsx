import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { assetUrl } from "../../../api";
import { CAPABILITY_LABELS } from "../../../shared/domain";
import { useModelStore } from "../../settings/modelStore";
import { buildResourceIndex } from "../canvas/mediaCards";
import {
  generationUnavailable,
  useGenerationAvailable,
} from "../stores/appStore";
import {
  describeKey,
  START_QUESTION,
  useDescribeSessions,
} from "../stores/describeSessions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { TOOL_LABELS } from "../stores/toolPrefs";

/**
 * Asks a model to read a picture back as the words that would make it.
 *
 * The other half of a generation: a picture arrived from somewhere and what made
 * it is not written down, so the words are read out of it instead. They are asked
 * for here rather than filed silently, because an ask costs what an ask costs and
 * the question, the picture and the model that will answer are all things a
 * reader should see before spending.
 *
 * What comes back is filed as a text node wired into the picture's prompt, which
 * makes the picture askable again from the words it was read back as. The answer
 * is shown as it arrives so that a model answering about nothing — one that
 * cannot see — is caught here rather than after a second generation spent on its
 * guess.
 *
 * The answer belongs to the picture rather than to this dialog: closing the
 * dialog puts it aside, and opening the dialog again on the same picture shows
 * the same answer — still arriving, or whole and already filed.
 */
export function DescribeDialog() {
  const { t } = useTranslation();
  const asked = useEditorStore((state) => state.pictureTool);
  const moka = useProjectStore((state) => state.moka);
  const view = useModelStore((state) => state.view);
  const reachable = useGenerationAvailable();
  const [unread, setUnread] = useState(false);

  const reading = asked?.tool === "describe" ? asked : null;
  const key =
    reading === null ? null : describeKey(reading.nodeId, reading.assetId);
  const session = useDescribeSessions((state) =>
    key === null ? undefined : state.sessions[key],
  );
  const patch = useDescribeSessions((state) => state.patch);
  const ask = useDescribeSessions((state) => state.ask);

  // The picture this dialog came up for has its own words; one opened on it
  // again reads them rather than starting them over.
  useEffect(() => {
    if (reading !== null) {
      useDescribeSessions.getState().open(reading.nodeId, reading.assetId);
    }
    // Whether this picture could be drawn is about the picture the dialog is
    // on now, not the one before it.
    setUnread(false);
    // The key is the picture: what was asked belongs to it, not to the one
    // before it, and closing the dialog takes nothing back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Escape lets go of an answer still arriving and closes the dialog otherwise:
  // one key, and the nearer thing first. Letting go is not closing, because the
  // words that got that far are worth reading.
  useEffect(() => {
    if (key === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const sessions = useDescribeSessions.getState();
      if (sessions.sessions[key]?.busy === true) {
        sessions.abort(key);
        return;
      }
      useEditorStore.getState().closePictureTool();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key]);

  if (reading === null || key === null) return null;
  const entry = moka
    ? buildResourceIndex(moka).get(reading.assetId)
    : undefined;
  if (!entry) return null;

  const close = () => useEditorStore.getState().closePictureTool();
  const reference = view?.defaults.text ?? null;
  const chosen =
    (reference !== null
      ? view?.models.find((one) => one.id === reference)
      : null) ?? null;
  const question = session?.question ?? START_QUESTION;
  const said = session?.said ?? "";
  const failed = session?.failed ?? null;
  const busy = session?.busy === true;
  const refusal = !reachable
    ? generationUnavailable()
    : reference === null
      ? t("editor:promptPanel.noModel", {
          kind: t(CAPABILITY_LABELS.text).toLowerCase(),
        })
      : question.trim() === ""
        ? t("editor:describe.sayWhatToAsk")
        : null;

  const submit = () => {
    if (busy || refusal !== null || reference === null) return;
    ask(key, {
      nodeId: reading.nodeId,
      assetId: reading.assetId,
      sourceName: entry.name,
      model: reference,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <form
        aria-labelledby="describe-title"
        aria-modal="true"
        className="dialog tool-dialog"
        data-testid="describe-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        role="dialog"
      >
        <h2 id="describe-title">
          {t(TOOL_LABELS.describe)} — {entry.name}
        </h2>
        <p className="dialog-note">{t("editor:describe.note")}</p>

        <div className="tool-stage">
          <div className="tool-frame">
            <img
              alt={entry.name}
              onError={() => setUnread(true)}
              src={assetUrl(reading.assetId)}
            />
          </div>
        </div>

        <div className="tool-params">
          <label className="dialog-field">
            <span>{t("editor:describe.whatToAsk")}</span>
            <textarea
              onChange={(event) => patch(key, { question: event.target.value })}
              rows={3}
              value={question}
            />
          </label>
        </div>

        <p
          className={
            chosen === null || reference === null
              ? "dialog-error"
              : "dialog-note"
          }
        >
          {reference === null
            ? t("editor:describe.noModelChosen")
            : chosen === null
              ? t("editor:describe.modelGone")
              : t("editor:describe.askedThrough", {
                  display: chosen.displayName,
                  model: chosen.model,
                })}
        </p>

        {unread && (
          <p className="dialog-note">{t("editor:describe.cannotShow")}</p>
        )}

        {busy && (
          <p aria-live="polite" className="dialog-note">
            {t("editor:describe.reading")}
          </p>
        )}
        {said.trim() !== "" && (
          <div className="dialog-answer" data-testid="describe-answer">
            {said}
          </div>
        )}

        {failed !== null && <p className="dialog-error">{failed}</p>}
        {refusal !== null && <p className="dialog-error">{refusal}</p>}

        <div className="dialog-actions">
          <button onClick={close} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy || refusal !== null}
            title={refusal ?? undefined}
            type="submit"
          >
            {busy ? t("editor:describe.readingBusy") : t("editor:describe.ask")}
          </button>
        </div>
      </form>
    </div>
  );
}
