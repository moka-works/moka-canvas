import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../shared/i18n";
import type { DirectorNodeData } from "../../shared/domain";
import {
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
import { StageViewport } from "./stage/StageViewport";
import { closeDirector, useDirectorStore } from "./stores/directorStore";

/**
 * The director desk: a place in the project where a scene is staged.
 *
 * It is a page of its own beside the cutting room and the story room, opened
 * from one card and closed back onto the board that card sits on. The scene it
 * shows is read from the document; the page holds no copy of its own yet.
 */
export function DirectorPage() {
  const { t } = useTranslation("director");
  const nodeId = useDirectorStore((state) => state.nodeId);
  const moka = useProjectStore((state) => state.moka);
  // Asked once on entry: a host that has no WebGL will not grow one while
  // the page is open, and asking again is a fresh context each time.
  const [capabilities, setCapabilities] = useState(probeDirectorCapabilities);

  const canvas = moka?.canvas.find((item) =>
    item.nodes.some((node) => node.id === nodeId),
  );
  const node = canvas?.nodes.find((item) => item.id === nodeId);
  const scene = moka && node ? directorSceneOf(moka, node) : undefined;
  const shot = scene ? activeShotOf(scene) : undefined;

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
    <main className="director-page" aria-label={t("page.title")}>
      <header className="director-topbar">
        <button type="button" className="button" onClick={closeDirector}>
          {t("page.back")}
        </button>
        <h1>{scene?.title ?? node?.title ?? t("page.title")}</h1>
        {shot && (
          <p className="director-shot-summary">
            {t("page.shotSummary", {
              name: shot.name,
              seconds: shot.duration,
              ratio: shot.aspectRatio,
            })}
          </p>
        )}
      </header>
      {!node || !canvas ? (
        <section className="director-capability" role="alert">
          <h2>{t("page.nodeMissing.title")}</h2>
          <p>{t("page.nodeMissing.body")}</p>
          <button type="button" className="button" onClick={closeDirector}>
            {t("page.back")}
          </button>
        </section>
      ) : !scene ? (
        <SceneMissing title={node.title} onRecover={recover} />
      ) : canRender3d(capabilities) ? (
        <StageViewport />
      ) : (
        <section className="director-capability" role="alert">
          <h2>{t("capability.title")}</h2>
          <p>{t("capability.body")}</p>
          <pre>{t("capability.reason", { reason: capabilities.failure })}</pre>
          <button
            type="button"
            className="button"
            onClick={() => setCapabilities(probeDirectorCapabilities())}
          >
            {t("capability.retry")}
          </button>
        </section>
      )}
      {lowTextureBudget(capabilities) && (
        <p className="director-capability-note" role="status">
          {t("capability.lowTexture", { size: capabilities.maxTextureSize })}
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
