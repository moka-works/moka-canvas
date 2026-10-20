import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canRender3d,
  lowTextureBudget,
  probeDirectorCapabilities,
} from "./capabilities";
import { StageViewport } from "./stage/StageViewport";

/**
 * The director desk: a place in the project where a scene is staged.
 *
 * It is loaded only by the room it belongs to, so the 3D stack is fetched
 * when a reader opens a director card and never with the first page.
 */
export function DirectorPage() {
  const { t } = useTranslation("director");
  // Asked once on entry: a host that has no WebGL will not grow one while
  // the page is open, and asking again is a fresh context each time.
  const [capabilities, setCapabilities] = useState(probeDirectorCapabilities);

  return (
    <main className="director-page" aria-label={t("page.title")}>
      <header className="director-topbar">
        <h1>{t("page.title")}</h1>
      </header>
      {canRender3d(capabilities) ? (
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
