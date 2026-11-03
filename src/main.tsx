import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { loadUiPrefs } from "./shared/prefs/uiPrefs";

/**
 * Reads the interface choices before the first module that wants one loads.
 *
 * The language, the palette, and every panel width are read where a store is
 * created, which happens as the app's modules evaluate. Waiting for the
 * preferences file first is what keeps the window from drawing the defaults
 * and then correcting itself.
 */
async function start() {
  await loadUiPrefs();
  const [{ default: App }, { applyStoredLocale }] = await Promise.all([
    import("./App"),
    import("./shared/i18n"),
  ]);
  applyStoredLocale();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
