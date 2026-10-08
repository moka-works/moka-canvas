import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  currentProject,
  errorText,
  http,
  isApiError,
  isConfigurationTrouble,
  nameProject,
  projectHeaders,
  readProblem,
  withProject,
} from "./client";
import { i18n } from "../shared/i18n";

const problem = (body: unknown, status = 422): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const thrown = (code: string): ApiError =>
  new ApiError({ code, message: "it broke", status: 422 });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  nameProject(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readProblem", () => {
  it("reads a problem body into the error every route reports", async () => {
    const error = await readProblem(
      problem({
        code: "PROVIDER_KEY_MISSING",
        message: "model gpt-4o-mini has no stored API key",
        details: { model: "gpt-4o-mini" },
        status: 422,
      }),
    );

    expect(error?.code).toBe("PROVIDER_KEY_MISSING");
    expect(error?.rawMessage).toBe("model gpt-4o-mini has no stored API key");
    expect(error?.details).toEqual({ model: "gpt-4o-mini" });
  });

  it("says nothing for a response that names no problem", async () => {
    expect(
      await readProblem(new Response("not json", { status: 500 })),
    ).toBeNull();
    expect(await readProblem(problem({ oops: true }))).toBeNull();
  });
});

describe("errorText", () => {
  it("keeps the server's sentence when the catalogue said something else", async () => {
    await i18n.changeLanguage("zh");
    const error = new ApiError({
      code: "PROVIDER_KEY_MISSING",
      message: "model gpt-4o-mini has no stored API key",
      status: 422,
      details: { model: "gpt-4o-mini" },
    });

    expect(errorText(error)).toEqual({
      message: "模型 gpt-4o-mini 还没有保存 API 密钥，请到设置里填写",
      detail: "model gpt-4o-mini has no stored API key",
    });
  });

  it("leaves an English interface with the one sentence", () => {
    const error = new ApiError({
      code: "PROVIDER_KEY_MISSING",
      message: "model gpt-4o-mini has no stored API key",
      status: 422,
      details: { model: "gpt-4o-mini" },
    });

    expect(errorText(error)).toEqual({
      message: "model gpt-4o-mini has no stored API key",
    });
  });

  it("takes whatever was thrown", () => {
    expect(errorText(new Error("no executor took it"))).toEqual({
      message: "no executor took it",
    });
    expect(errorText("just a string")).toEqual({ message: "just a string" });
  });
});

describe("what a reader repairs in settings", () => {
  it("knows the troubles another ask repeats", () => {
    expect(isConfigurationTrouble(thrown("PROVIDER_KEY_MISSING"))).toBe(true);
    expect(isConfigurationTrouble(thrown("PROVIDER_NOT_CONFIGURED"))).toBe(
      true,
    );
    expect(isConfigurationTrouble(thrown("PROVIDER_AUTH"))).toBe(true);
    expect(isConfigurationTrouble(thrown("MODEL_CAPABILITY_MISMATCH"))).toBe(
      true,
    );
    expect(isConfigurationTrouble(thrown("MODEL_SCENE_UNCONFIGURED"))).toBe(
      true,
    );
    expect(isConfigurationTrouble(thrown("MODEL_VOICE_REQUIRED"))).toBe(true);
  });

  it("leaves a trouble that time or a second ask might fix alone", () => {
    expect(isConfigurationTrouble(thrown("PROVIDER_RATE_LIMIT"))).toBe(false);
    expect(isConfigurationTrouble(thrown("PROVIDER_TIMEOUT"))).toBe(false);
    // A recording is picked on the card that asks for it, not in Settings:
    // the repair is beside the ask rather than in a configuration page.
    expect(
      isConfigurationTrouble(thrown("MODEL_REFERENCE_AUDIO_REQUIRED")),
    ).toBe(false);
    expect(isConfigurationTrouble(new Error("nope"))).toBe(false);
    expect(isConfigurationTrouble(undefined)).toBe(false);
  });
});

describe("isApiError", () => {
  it("still tells a problem apart from anything else thrown", () => {
    expect(isApiError(thrown("CONFLICT"), "CONFLICT")).toBe(true);
    expect(isApiError(thrown("CONFLICT"), "NOT_FOUND")).toBe(false);
    expect(
      isApiError(
        thrown("MODEL_REFERENCE_AUDIO_REQUIRED"),
        "MODEL_REFERENCE_AUDIO_REQUIRED",
      ),
    ).toBe(true);
    expect(isApiError(new Error("conflict"))).toBe(false);
  });
});

describe("the project a window speaks for", () => {
  it("names the project on requests once the window has one", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await http.request("/api/v1/projects/current/commands", {
      method: "POST",
      body: {},
    });
    expect(new Headers(seen[0]?.headers).get("x-moka-project")).toBeNull();

    nameProject("0192b7d4-0000-7000-8000-0000000000aa");
    await http.request("/api/v1/projects/current/commands", {
      method: "POST",
      body: {},
    });
    expect(new Headers(seen[1]?.headers).get("x-moka-project")).toBe(
      "0192b7d4-0000-7000-8000-0000000000aa",
    );
    // The content type the JSON body always had is still there beside it.
    expect(new Headers(seen[1]?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("carries the project in the address where no header can ride", () => {
    expect(withProject("/api/v1/projects/current/assets/a-1")).toBe(
      "/api/v1/projects/current/assets/a-1",
    );
    expect(projectHeaders()).toEqual({});

    nameProject("p-1");
    expect(withProject("/api/v1/projects/current/assets/a-1")).toBe(
      "/api/v1/projects/current/assets/a-1?project=p-1",
    );
    expect(withProject("/api/v1/projects/current/assets/a-1?w=64")).toBe(
      "/api/v1/projects/current/assets/a-1?w=64&project=p-1",
    );
    expect(currentProject()).toBe("p-1");

    nameProject(null);
    expect(currentProject()).toBeNull();
    expect(projectHeaders()).toEqual({});
  });

  it("remembers the project a window had across a reload of it", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
    vi.resetModules();

    const window1 = await import("./client");
    expect(window1.currentProject()).toBeNull();
    window1.nameProject("0192b7d4-0000-7000-8000-0000000000aa");

    // A reload is the module starting over on the same window's storage.
    vi.resetModules();
    const reloaded = await import("./client");
    expect(reloaded.currentProject()).toBe(
      "0192b7d4-0000-7000-8000-0000000000aa",
    );

    // A window that puts its project down remembers nothing.
    reloaded.nameProject(null);
    vi.resetModules();
    const fresh = await import("./client");
    expect(fresh.currentProject()).toBeNull();
  });
});
