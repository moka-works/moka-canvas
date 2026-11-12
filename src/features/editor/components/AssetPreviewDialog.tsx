import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { assetThumbUrl, assetUrl } from "../../../api";
import { buildResourceIndex, formatBytes } from "../canvas/mediaCards";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/** Full-size preview dialog for image/video/audio assets. */
export function AssetPreviewDialog() {
  const { t } = useTranslation();
  const assetId = useEditorStore((state) => state.previewAssetId);
  const moka = useProjectStore((state) => state.moka);

  useEffect(() => {
    if (!assetId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useEditorStore.getState().closePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assetId]);

  if (!assetId) return null;
  const entry = moka ? buildResourceIndex(moka).get(assetId) : undefined;
  if (!entry) return null;
  const mime = entry.mime ?? entry.probe?.mime ?? "";
  const url = assetUrl(assetId);
  const close = () => useEditorStore.getState().closePreview();

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        aria-label={entry.name}
        aria-modal="true"
        className="dialog preview-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="preview-dialog-head">
          <h2>{entry.name}</h2>
          <button
            aria-label={t("editor:dialogs.preview.close")}
            onClick={close}
            type="button"
          >
            ✕
          </button>
        </header>
        {mime.startsWith("image/") && (
          <img alt={entry.name} className="preview-media" src={url} />
        )}
        {mime.startsWith("video/") && (
          <video
            autoPlay
            className="preview-media"
            controls
            poster={assetThumbUrl(entry.id, 1024)}
            src={url}
          />
        )}
        {mime.startsWith("audio/") && <audio autoPlay controls src={url} />}
        {!/^(image|video|audio)\//.test(mime) && (
          <p>
            {formatBytes(entry.bytes)} —{" "}
            <a download={entry.name} href={url}>
              {t("editor:action.download")}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
