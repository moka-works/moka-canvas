import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../shared/i18n";
import type { DirectorNodeData, DirectorRenderMode } from "../../shared/domain";
import {
  DIRECTOR_RENDER_MODES,
  activeShotOf,
  createDirectorScene,
  directorSceneOf,
} from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { useProjectStore } from "../editor/stores/projectStore";
import {
  canRender3d,
  lowTextureBudget,
  probeDirectorCapabilities,
} from "./capabilities";
import {
  StageViewport,
  type DirectorCaptureContext,
} from "./stage/StageViewport";
import type { DirectorSelection } from "./stage/StageWorld";
import {
  DIRECTOR_VIEWS,
  viewLabel,
  type DirectorView,
} from "./stage/viewModes";
import { closeDirector, useDirectorStore } from "./stores/directorStore";

/**
 * The director desk: a page of its own where a scene is staged.
 *
 * The scene comes from the document and every edit will go back through a
 * command; the page holds the reader's place — which view, which object is
 * selected — and nothing that would matter after a reload.
 */
export function DirectorPage() {
  const { t } = useTranslation(["director", "editor"]);
  const nodeId = useDirectorStore((state) => state.nodeId);
  const moka = useProjectStore((state) => state.moka);
  const [capabilities] = useState(probeDirectorCapabilities);
  const [view, setView] = useState<DirectorView>("free");
  const [renderMode, setRenderMode] = useState<DirectorRenderMode>("lit");
  const [selection, setSelection] = useState<DirectorSelection | null>(null);
  const [fallback, setFallback] = useState(false);
  const capture = useRef<DirectorCaptureContext | null>(null);

  const canvas = moka?.canvas.find((item) =>
    item.nodes.some((node) => node.id === nodeId),
  );
  const node = canvas?.nodes.find((item) => item.id === nodeId);
  const scene = moka && node ? directorSceneOf(moka, node) : undefined;
  const shot = scene ? activeShotOf(scene) : undefined;

  const onCaptureContext = useCallback(
    (context: DirectorCaptureContext | null) => {
      capture.current = context;
    },
    [],
  );
  const onCameraFallback = useCallback(() => {
    setFallback(true);
    setView("free");
  }, []);

  const recover = () => {
    if (!node || !canvas) return;
    const fresh = createDirectorScene(node.title);
    const data = node.data as DirectorNodeData;
    execute(i18n.t("editor:history.createDirector"), [
      { type: "addDirectorScene", scene: fresh },
      {
        type: "updateNode",
        canvasId: canvas.id,
        nodeId: node.id,
        patch: { data: { director: { ...data.director, sceneId: fresh.id } } },
      },
    ]);
  };

  return (
    <main
      aria-label={t("director:page.title")}
      className="director-page"
      data-testid="director-page"
    >
      <header className="director-topbar">
        <button type="button" className="button" onClick={closeDirector}>
          {t("director:page.back")}
        </button>
        <h1>{scene?.title ?? node?.title ?? t("director:page.title")}</h1>
        {shot && (
          <p className="director-shot-summary">
            {t("director:page.shotSummary", {
              name: shot.name,
              seconds: shot.duration,
              ratio: shot.aspectRatio,
            })}
          </p>
        )}
        <div className="director-view-tabs" role="tablist">
          {DIRECTOR_VIEWS.map((mode) => (
            <button
              aria-selected={view === mode}
              className="director-view-tab"
              key={mode}
              onClick={() => {
                setFallback(false);
                setView(mode);
              }}
              role="tab"
              type="button"
            >
              {viewLabel(mode)}
            </button>
          ))}
        </div>
        <label className="director-render-select">
          <span>{t("director:renderMode.label")}</span>
          <select
            onChange={(event) =>
              setRenderMode(event.target.value as DirectorRenderMode)
            }
            value={renderMode}
          >
            {DIRECTOR_RENDER_MODES.filter(
              (mode) => mode === "lit" || mode === "blockout",
            ).map((mode) => (
              <option key={mode} value={mode}>
                {t(`director:renderMode.${mode}`)}
              </option>
            ))}
          </select>
        </label>
      </header>
      {!node || !canvas ? (
        <section className="director-capability" role="alert">
          <h2>{t("director:page.nodeMissing.title")}</h2>
          <p>{t("director:page.nodeMissing.body")}</p>
          <button type="button" className="button" onClick={closeDirector}>
            {t("director:page.back")}
          </button>
        </section>
      ) : !scene ? (
        <SceneMissing title={node.title} onRecover={recover} />
      ) : canRender3d(capabilities) ? (
        <StageViewport
          onCameraFallback={onCameraFallback}
          onCaptureContext={onCaptureContext}
          onSelect={setSelection}
          renderMode={renderMode}
          scene={scene}
          selection={selection}
          view={view}
        />
      ) : (
        <section className="director-capability" role="alert">
          <h2>{t("director:capability.title")}</h2>
          <p>{t("director:capability.body")}</p>
          <pre>
            {t("director:capability.reason", {
              reason: capabilities.failure,
            })}
          </pre>
        </section>
      )}
      {lowTextureBudget(capabilities) && (
        <p className="director-capability-note" role="status">
          {t("director:capability.lowTexture", {
            size: capabilities.maxTextureSize,
          })}
        </p>
      )}
      {fallback && (
        <p className="director-viewport-fallback director-page-fallback">
          {t("director:view.fallback")}
        </p>
      )}
    </main>
  );
}

function SceneMissing({
  title,
  onRecover,
}: {
  title: string;
  onRecover: () => void;
}) {
  const { t } = useTranslation("director");
  return (
    <section className="director-capability" role="alert">
      <h2>{t("page.sceneMissing.title")}</h2>
      <p>{t("page.sceneMissing.body", { title })}</p>
      <button type="button" className="button" onClick={onRecover}>
        {t("page.sceneMissing.recover")}
      </button>
      <button type="button" className="button" onClick={closeDirector}>
        {t("page.back")}
      </button>
    </section>
  );
}
