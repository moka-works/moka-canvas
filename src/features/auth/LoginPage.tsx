import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { authApi, safeNext } from "../../api/auth";
import { errorText } from "../../api/client";

/**
 * The door in front of a web deployment that names an account.
 *
 * Drawn instead of the application, never inside it: nothing behind it may be
 * asked for until the cookie this form earns exists. A sign-in that fails says
 * what the server said, in full, rather than only that it failed.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof errorText> | null>(
    null,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await authApi.login(username.trim(), password);
      window.location.replace(safeNext());
    } catch (error) {
      setFailure(errorText(error));
      setBusy(false);
    }
  }

  const ready = !busy && username.trim() !== "" && password !== "";

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <img
          alt=""
          aria-hidden="true"
          className="brand-mark"
          src="/favicon.png"
        />
        <h1>{t("app:login.title", { name: t("app:name") })}</h1>
        <p>{t("app:login.subtitle")}</p>
        <label className="login-field">
          <span>{t("app:login.username")}</span>
          <input
            autoComplete="username"
            autoFocus
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
        </label>
        <label className="login-field">
          <span>{t("app:login.password")}</span>
          <input
            autoComplete="current-password"
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {failure !== null && (
          <div className="login-failure" role="alert">
            <span>{failure.message}</span>
            {failure.detail !== undefined && (
              <details>
                <summary>{t("app:showDetail")}</summary>
                <p>{failure.detail}</p>
              </details>
            )}
          </div>
        )}
        <button className="primary" disabled={!ready} type="submit">
          {busy ? t("app:login.signingIn") : t("app:login.submit")}
        </button>
      </form>
    </div>
  );
}
