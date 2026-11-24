import { http } from "./client";

/** What the server says about this browser before anything is drawn. */
export interface AuthSession {
  /** Whether the deployment asks for an account at all. */
  required: boolean;
  authenticated: boolean;
  username?: string;
}

export const authApi = {
  session(signal?: AbortSignal): Promise<AuthSession> {
    return http.request<AuthSession>("/api/auth/session", { signal });
  },

  /** Signs in and leaves the session cookie the rest of the app travels on. */
  login(username: string, password: string): Promise<void> {
    return http.request<void>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
  },

  logout(): Promise<void> {
    return http.request<void>("/api/auth/logout", { method: "POST" });
  },
};

/**
 * Where a sign-in returns to.
 *
 * The server puts the page that sent a reader here in the address, and only a
 * path on this same origin is followed: an address that named another host
 * would turn the login page into a way out of the application.
 */
export function safeNext(search?: string): string {
  const query =
    search ?? (typeof window === "undefined" ? "" : window.location.search);
  const next = new URLSearchParams(query).get("next");
  if (next === null) return "/";
  // Resolved against this origin rather than read as a string: `//host`,
  // `/\host`, and a scheme of their own all leave the application, and a URL
  // parser is what knows every spelling of that.
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const resolved = new URL(next, origin);
  if (resolved.origin !== origin) return "/";
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
