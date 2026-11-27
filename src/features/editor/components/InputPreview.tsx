import { useTranslation } from "react-i18next";
import type { GenerationPreview, InputRole, PreviewInput } from "../../../api";
import { formatBytes, formatDuration } from "../canvas/mediaCards";

/** What a reference is asked to do, in the words the rest of the panel uses. */
const ROLE_LABELS: Record<InputRole, string> = {
  reference: "editor:inputPreview.roleReference",
  firstFrame: "editor:inputPreview.roleFirstFrame",
  lastFrame: "editor:inputPreview.roleLastFrame",
  referenceAudio: "editor:inputPreview.roleReferenceAudio",
  mask: "editor:inputPreview.roleMask",
  controlVideo: "editor:inputPreview.roleControlVideo",
  controlAudio: "editor:inputPreview.roleControlAudio",
};

/** What the project measured about an asset, on one line. */
function described(input: PreviewInput): string {
  const said: string[] = [];
  if (input.mime) said.push(input.mime);
  if (input.width !== null && input.height !== null) {
    said.push(`${input.width}×${input.height}`);
  }
  const length = formatDuration(input.durationMs ?? undefined);
  if (length) said.push(length);
  const size = formatBytes(input.bytes ?? undefined);
  if (size) said.push(size);
  return said.join(" · ");
}

/**
 * What a node will actually send, read off the server's own resolution of the
 * graph rather than worked out here a second time.
 *
 * The point of it is the disagreement it prevents: a panel that shows three
 * references while the model is handed two is the kind of wrong nobody can find
 * from the answer. So the words and the list come from the same pass a run
 * takes, and anything that will not travel — a mention naming a node that is not
 * there, a picture whose file has gone, text cut to fit the limit — is said
 * outright instead of being left out quietly.
 */
export function InputPreview({
  preview,
  reading,
  error,
  titleOf,
}: {
  /** Null until the first answer arrives. */
  preview: GenerationPreview | null;
  reading: boolean;
  error: string | null;
  /** How a source node is named on the canvas. */
  titleOf: (nodeId: string) => string;
}) {
  const { t } = useTranslation();
  const gone = (preview?.inputs ?? []).filter((input) => input.missing);
  const sent = (preview?.inputs ?? []).filter((input) => !input.missing);
  const unresolved = preview?.unresolved ?? [];
  const cut = preview?.truncatedChars ?? 0;
  return (
    <div
      aria-label={t("editor:inputPreview.aria")}
      className="prompt-panel-preview"
      data-testid="input-preview"
      role="group"
    >
      {error && (
        <p className="prompt-panel-warn" role="alert">
          {error}
        </p>
      )}
      {reading && !preview && (
        <p className="prompt-panel-note">{t("editor:inputPreview.reading")}</p>
      )}
      {preview && (
        <>
          {unresolved.length > 0 && (
            <p className="prompt-panel-warn" role="alert">
              {unresolved.length === 1
                ? t("editor:inputPreview.unresolvedOne")
                : t("editor:inputPreview.unresolvedMany", {
                    count: unresolved.length,
                  })}
            </p>
          )}
          {gone.length > 0 && (
            <p className="prompt-panel-warn" role="alert">
              {gone.length === 1
                ? t("editor:inputPreview.goneOne", {
                    name: gone[0].name ?? gone[0].assetId,
                  })
                : t("editor:inputPreview.goneMany", {
                    names: gone
                      .map((input) => input.name ?? input.assetId)
                      .join(", "),
                  })}
            </p>
          )}
          {cut > 0 && (
            <p className="prompt-panel-warn" role="alert">
              {t("editor:inputPreview.cut", {
                count: cut.toLocaleString(),
              })}
            </p>
          )}

          <p className="prompt-panel-preview-label">
            {t("editor:inputPreview.wordsLabel")}
          </p>
          {preview.prompt.trim() === "" ? (
            <p className="prompt-panel-note">
              {t("editor:inputPreview.noWords")}
            </p>
          ) : (
            <pre className="prompt-panel-preview-text">{preview.prompt}</pre>
          )}

          <p className="prompt-panel-preview-label">
            {sent.length === 0
              ? t("editor:inputPreview.noReferences")
              : sent.length === 1
                ? t("editor:inputPreview.sentOne")
                : t("editor:inputPreview.sentMany", { count: sent.length })}
          </p>
          {sent.length > 0 && (
            <ul className="prompt-panel-preview-list">
              {sent.map((input) => (
                <li key={`${input.nodeId}:${input.assetId}:${input.role}`}>
                  <span className="prompt-panel-preview-role">
                    {t(ROLE_LABELS[input.role])}
                  </span>
                  <span className="prompt-panel-preview-name">
                    {input.name ?? input.assetId}
                  </span>
                  <span className="prompt-panel-preview-detail">
                    {described(input)}
                  </span>
                  <span className="prompt-panel-preview-from">
                    {t("editor:inputPreview.from", {
                      name: titleOf(input.nodeId),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
