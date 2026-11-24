import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { authApi, safeNext } from "./api/auth";
import { loadUiPrefs } from "./shared/prefs/uiPrefs";

/**
 * Reads a signed-in session, then the interface choices, before the first
 * module that wants either is drawn.
 *
 * The session is asked about first because a deployment with an account
 * refuses every other question without a cookie: waiting for the preferences
 * would mean the login page is drawn only after a refusal, and its language
 * would be a default rather than the reader's. A server that cannot be reached
 * has no session to report; the app's own boot then says so, as it always did.
 *
 * The language, the palette, and every panel width are read where a store is
 * created, which happens as the app's modules evaluate. Waiting for the
 * preferences file first is what keeps the window from drawing the defaults
 * and then correcting itself.
 */
async function start() {
  const session = await authApi.session().catch(() => null);
  const onLoginPage = window.location.pathname === "/login";
  if (session?.required) {
    if (!session.authenticated && !onLoginPage) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (session.authenticated && onLoginPage) {
      window.location.replace(safeNext());
      return;
    }
  }
  // The sign-in page needs no preferences, and cannot read them: they live
  // behind the same door it is there to open.
  const signIn = session?.required === true && onLoginPage;
  if (!signIn) await loadUiPrefs();
  const [{ default: App }, { applyStoredLocale }, { LoginPage }] =
    await Promise.all([
      import("./App"),
      import("./shared/i18n"),
      import("./features/auth/LoginPage"),
    ]);
  applyStoredLocale();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>{signIn ? <LoginPage /> : <App />}</StrictMode>,
  );
}

void start();
