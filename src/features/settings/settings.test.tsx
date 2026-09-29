// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../../App";
import type { ModelDraft, ModelsView, ModelView } from "../../api";
import { i18n } from "../../shared/i18n";
import { protocolChoices, protocolLabel, useModelStore } from "./modelStore";

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png"],
  limits: {
    maxNodesPerCanvas: 500,
    maxEdgesPerCanvas: 800,
    maxCanvasesPerProject: 12,
    maxPackageBytes: 536870912,
    maxPackageEntries: 20000,
  },
  capabilities: { mode: "web", executors: ["noop"], assetCategories: [] },
};

const KEY = "sk-test-1234567890abcd";
const MASKED = "sk-…abcd";

/**
 * The converter registry as the server reports it: protocols grouped by the
 * capability they serve — one entry per converter directory, each carrying
 * what its own model.json declares about itself.
 */
const REGISTRY = {
  text: {
    openaiChat: {
      script: "text/openai-chat.lua",
      displayName: "OpenAI-compatible · Chat Completions",
      labels: { zh: "OpenAI 兼容 · Chat Completions" },
      urlExample: "https://api.openai.com/v1/chat/completions",
      order: 10,
    },
    openaiResponses: {
      script: "text/openai-responses.lua",
      displayName: "OpenAI-compatible · Responses API",
      urlExample: "https://api.openai.com/v1/responses",
      order: 20,
    },
    gemini: {
      script: "text/gemini.lua",
      displayName: "Google Gemini · generateContent",
      urlExample:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      order: 30,
    },
    bailianText: {
      script: "text/bailian-text.lua",
      displayName: "Alibaba Cloud · Bailian Text (Qwen)",
      labels: { zh: "阿里云百炼 · 文本生成（通义千问）" },
      urlExample:
        "https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
      order: 40,
    },
  },
  image: {
    openaiImages: {
      script: "image/openai-images.lua",
      displayName: "OpenAI-compatible · Images API",
      urlExample: "https://api.openai.com/v1/images/generations",
      order: 10,
      features: { mask: true },
    },
    bailianImage: {
      script: "image/bailian-image.lua",
      displayName: "Alibaba Cloud · Bailian Image (Wan)",
      labels: { zh: "阿里云百炼 · 图像生成与编辑（万相）" },
      urlExample:
        "https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      order: 20,
    },
  },
  speech: {
    openaiSpeech: {
      script: "speech/openaiSpeech/openai-speech.lua",
      displayName: "OpenAI-compatible · Speech API",
      urlExample: "https://api.openai.com/v1/audio/speech",
      order: 10,
      features: { needsVoice: true },
    },
    bailianSpeech: {
      script: "speech/bailianSpeech/bailian-speech.lua",
      displayName: "Alibaba Cloud · Bailian Speech (CosyVoice TTS)",
      urlExample: "https://ws.cn-beijing.maas.aliyuncs.com/tts",
      order: 20,
      features: { needsVoice: true },
    },
  },
  music: {
    bailianMusic: {
      script: "music/bailianMusic/bailian-music.lua",
      displayName: "Alibaba Cloud · Music Generation (fun-music)",
      urlExample: "https://ws.cn-beijing.maas.aliyuncs.com/music",
      order: 30,
    },
  },
  video: {
    openaiVideos: {
      script: "video/openai-videos.lua",
      displayName: "OpenAI-compatible · Videos API",
      urlExample: "https://api.openai.com/v1/videos",
      order: 10,
    },
    geminiVideo: {
      script: "video/gemini-video.lua",
      displayName: "Google Gemini · long-running (Veo)",
      urlExample:
        "https://generativelanguage.googleapis.com/v1beta/models/veo-3:predictLongRunning",
      order: 20,
    },
    bailianVideo: {
      script: "video/bailian-video.lua",
      displayName: "Alibaba Cloud · Bailian Video",
      urlExample: "https://ws.cn-beijing.maas.aliyuncs.com/video-synthesis",
      order: 30,
    },
  },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

let view: ModelsView;
let calls: Call[];
/** Lets a test make the next write fail the way the server would. */
let refuseNextWrite: { status: number; code: string; message: string } | null;

function model(
  id: string,
  category: ModelView["category"],
  protocol: ModelView["protocol"],
  displayName: string,
  keyed: boolean,
): ModelView {
  const urls: Record<string, string> = {
    openaiChat: "https://api.example.com/v1/chat/completions",
    openaiImages: "https://api.example.com/v1/images/generations",
  };
  return {
    id,
    category,
    protocol,
    url: urls[protocol] ?? "https://api.example.com/v1",
    model: `${id}-1`,
    displayName,
    enabled: true,
    apiKey: keyed
      ? { set: true, masked: MASKED, rotatedAt: "2025-01-02T03:04:05Z" }
      : { set: false, masked: null },
  };
}

function fixture(): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [
      model("writer", "text", "openaiChat", "Writer", true),
      model("scribe", "text", "openaiChat", "Scribe", false),
      model("painter", "image", "openaiImages", "Painter", true),
    ],
    defaults: {
      text: null,
      image: null,
      speech: null,
      music: null,
      video: null,
      asr: null,
    },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1:1", quality: "auto", background: "", count: 1 },
      video: {
        seconds: 6,
        resolution: "720",
        generateAudio: true,
        watermark: false,
        mode: "auto",
        ratio: "16:9",
      },
      speech: {
        voice: "alloy",
        format: "mp3",
        speed: 1,
        instructions: "",
        sampleRate: 22050,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
      music: { format: "mp3", watermark: false },
      story: { splitChars: 12_000, readChars: 8_000 },
    },
    secretStorage: "file",
    secretStorageOptions: ["file", "keyring"],
    secretStoragePref: "file",
  };
}

function upsert(draft: ModelDraft) {
  const stored = view.models.find((entry) => entry.id === draft.id);
  // A creation may name a configuration to take the credential from; an
  // edit keeps whatever is stored, the way the server does.
  const copied =
    stored === undefined && draft.copyKeyFrom
      ? view.models.find((entry) => entry.id === draft.copyKeyFrom)?.apiKey
      : undefined;
  const key = draft.apiKey?.trim()
    ? { set: true, masked: MASKED }
    : (stored?.apiKey ?? copied ?? { set: false, masked: null });
  const record: ModelView = {
    id: draft.id,
    category: draft.category,
    protocol: draft.protocol,
    url: draft.url,
    model: draft.model,
    displayName: draft.displayName,
    enabled: draft.enabled,
    apiKey: key,
    ...(draft.scenes ? { scenes: draft.scenes } : {}),
    ...(draft.subModels ? { subModels: draft.subModels } : {}),
  };
  view = {
    ...view,
    revision: view.revision + 1,
    models: stored
      ? view.models.map((entry) => (entry.id === draft.id ? record : entry))
      : [...view.models, record],
  };
}

function route(url: string, method: string, body: unknown): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const problem = (status: number, code: string, message: string) =>
    json({ code, message, status }, status);

  calls.push({ method, url, body });
  const path = url.split("?")[0];

  if (url === "/api/v1/config") return json(CONFIG);
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/recent-projects") return json([]);

  if (path === "/api/v1/models" && method === "GET") return json(view);

  if (path === "/api/v1/converter/protocols" && method === "GET") {
    return json({ protocols: REGISTRY });
  }

  if (path === "/api/v1/models" && method === "PUT") {
    if (refuseNextWrite) {
      const refusal = refuseNextWrite;
      refuseNextWrite = null;
      return problem(refusal.status, refusal.code, refusal.message);
    }
    upsert(body as ModelDraft);
    return json(view);
  }

  if (path === "/api/v1/models/defaults" && method === "PATCH") {
    const patch: Record<string, unknown> = {
      ...(body as Partial<ModelsView["defaults"]>),
    };
    delete patch.expectedRevision;
    view = {
      ...view,
      revision: view.revision + 1,
      defaults: {
        ...view.defaults,
        ...(patch as Partial<ModelsView["defaults"]>),
      },
    };
    return json(view);
  }

  if (path === "/api/v1/models/preferences" && method === "PATCH") {
    const patch = body as Partial<ModelsView["preferences"]>;
    view = {
      ...view,
      revision: view.revision + 1,
      preferences: { ...view.preferences, ...patch },
    };
    return json(view);
  }

  if (path === "/api/v1/system/secret-storage" && method === "PUT") {
    const { storage } = body as { storage: "file" | "keyring" };
    view = {
      ...view,
      revision: view.revision + 1,
      secretStorage: storage,
      secretStoragePref: storage,
    };
    return json(view);
  }

  const named = path.match(/^\/api\/v1\/models\/([^/]+)(\/.*)?$/);
  if (named) {
    const id = decodeURIComponent(named[1]);
    const suffix = named[2] ?? "";
    const index = view.models.findIndex((entry) => entry.id === id);
    if (index === -1) return problem(404, "NOT_FOUND", `no model ${id}`);

    if (suffix === "" && method === "DELETE") {
      view = {
        ...view,
        revision: view.revision + 1,
        models: view.models.filter((entry) => entry.id !== id),
      };
      return json(view);
    }
    if (suffix === "/key" && method === "POST") {
      const { apiKey } = body as { apiKey: string | null };
      view = {
        ...view,
        revision: view.revision + 1,
        models: view.models.map((entry, at) =>
          at === index
            ? {
                ...entry,
                apiKey: apiKey?.trim()
                  ? { set: true, masked: MASKED }
                  : { set: false, masked: null },
              }
            : entry,
        ),
      };
      return json(view);
    }
  }

  return problem(404, "NOT_FOUND", url);
}

function writesTo(path: string): Call[] {
  return calls.filter(
    (call) => call.method !== "GET" && call.url.split("?")[0] === path,
  );
}

function readsOf(path: string): number {
  return calls.filter((call) => call.method === "GET" && call.url === path)
    .length;
}

/** The card one model is listed in. */
function cardOf(displayName: string): HTMLElement {
  const card = screen.getByText(displayName).closest("li");
  if (!card) throw new Error(`no card for ${displayName}`);
  return card;
}

async function openSettings(tab?: string) {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await screen.findByText("Writer");
  if (tab) fireEvent.click(screen.getByRole("tab", { name: tab }));
  return dialog;
}

beforeEach(() => {
  view = fixture();
  calls = [];
  refuseNextWrite = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        route(
          String(input),
          init?.method ?? "GET",
          init?.body ? JSON.parse(String(init.body)) : undefined,
        ),
      ),
    ),
  );
  useModelStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("model settings", () => {
  it("lists each category's models on its own tab", async () => {
    await openSettings();

    // The text tab carries the text models and nothing else.
    expect(screen.getByText("Writer")).toBeTruthy();
    expect(screen.getByText("Scribe")).toBeTruthy();
    expect(screen.queryByText("Painter")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Image" }));
    expect(await screen.findByText("Painter")).toBeTruthy();
    expect(screen.queryByText("Writer")).toBeNull();
  });

  it("shows what may be disclosed about a credential and nothing more", async () => {
    await openSettings();
    await screen.findByText("Writer");

    expect(screen.getByText(`Key ${MASKED}`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("creates a model from the form", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Composer" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "composer-1" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: KEY },
    });
    // The URL starts from the protocol's own example, which is a complete
    // endpoint rather than a base to extend.
    const url = screen.getByLabelText("Endpoint URL") as HTMLInputElement;
    expect(url.value).toBe("https://api.openai.com/v1/chat/completions");

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Composer");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toEqual({
      id: expect.stringMatching(/^composer-[a-z0-9]{6}$/),
      category: "text",
      protocol: "openaiChat",
      url: "https://api.openai.com/v1/chat/completions",
      model: "composer-1",
      displayName: "Composer",
      enabled: true,
      apiKey: KEY,
      expectedRevision: 1,
    });
  });

  it("keeps a video model's own clip ceiling, and asks no other kind for one", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Video" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New video model" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Filmer" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "happyhorse-1.1-t2v" },
    });
    // The window the provider films in, which is what a telling longer than it
    // is filmed in pieces of.
    fireEvent.change(screen.getByLabelText("Longest clip (seconds)"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Filmer");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({
      id: expect.stringMatching(/^filmer-[a-z0-9]{6}$/),
      category: "video",
      model: "happyhorse-1.1-t2v",
      maxVideoSeconds: 15,
    });

    // A kind that films nothing is never asked for a clip window.
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );
    expect(screen.queryByLabelText("Longest clip (seconds)")).toBeNull();
  });

  it("routes a video model's scenarios through its groups", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Video" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New video model" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Routed" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "happy-1.1-t2v" },
    });

    // A new model's first group answers every scenario of its category, and
    // with none left over there is no group to add.
    const sceneAt = (at: number, scene: string) =>
      screen.getByTestId(
        `model-group-${at}-scene-${scene}`,
      ) as HTMLInputElement;
    for (const scene of [
      "textToVideo",
      "imageToVideo",
      "firstLastFrame",
      "referenceToVideo",
    ]) {
      expect(sceneAt(0, scene).checked).toBe(true);
    }
    expect(screen.queryByTestId("model-group-add")).toBeNull();

    // A scenario freed in the first group is what a second group is for: the
    // form offers one, and the checks move to the group that took them.
    fireEvent.click(sceneAt(0, "imageToVideo"));
    fireEvent.click(sceneAt(0, "firstLastFrame"));
    fireEvent.click(sceneAt(0, "referenceToVideo"));
    expect(screen.getByTestId("model-uncovered").textContent).toContain(
      "Image to video",
    );
    fireEvent.click(screen.getByTestId("model-group-add"));
    fireEvent.change(screen.getByTestId("model-group-1-model"), {
      target: { value: "happy-1.1-i2v" },
    });
    fireEvent.click(sceneAt(1, "imageToVideo"));
    fireEvent.click(sceneAt(1, "firstLastFrame"));

    // A scenario is answered by one group, so checking it somewhere takes it
    // from the group that held it — and giving it back takes it the other way.
    fireEvent.click(sceneAt(1, "textToVideo"));
    expect(sceneAt(0, "textToVideo").checked).toBe(false);
    fireEvent.click(sceneAt(0, "textToVideo"));
    expect(sceneAt(1, "textToVideo").checked).toBe(false);
    // What no group answers for is said before the save, not left to a failure.
    expect(screen.getByTestId("model-uncovered").textContent).toContain(
      "Reference pictures to video",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Routed");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({
      id: expect.stringMatching(/^routed-[a-z0-9]{6}$/),
      category: "video",
      model: "happy-1.1-t2v",
      scenes: ["textToVideo"],
      subModels: [
        {
          model: "happy-1.1-i2v",
          scenes: ["imageToVideo", "firstLastFrame"],
        },
      ],
    });

    // The groups come back when the configuration is opened again.
    fireEvent.click(
      within(cardOf("Routed")).getByRole("button", { name: "Edit" }),
    );
    const name = (await screen.findByTestId(
      "model-group-1-model",
    )) as HTMLInputElement;
    expect(name.value).toBe("happy-1.1-i2v");
    expect(sceneAt(1, "imageToVideo").checked).toBe(true);
    expect(sceneAt(0, "textToVideo").checked).toBe(true);
    expect(sceneAt(0, "referenceToVideo").checked).toBe(false);
  });

  it("refuses to save a group without a name or a scenario", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Video" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New video model" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Half" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "half-1" },
    });
    // A scenario has to be free before a second group is on offer at all.
    fireEvent.click(screen.getByTestId("model-group-0-scene-imageToVideo"));
    fireEvent.click(screen.getByTestId("model-group-add"));

    const save = () =>
      screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.getByText("A group needs a model name.")).toBeTruthy();

    fireEvent.change(screen.getByTestId("model-group-1-model"), {
      target: { value: "half-i2v" },
    });
    expect(screen.getByText("Check at least one scenario.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-group-1-scene-imageToVideo"));
    expect(save().disabled).toBe(false);

    // An address that is not one is refused where it is typed, the way the
    // first group's is.
    fireEvent.change(screen.getByTestId("model-group-1-url"), {
      target: { value: "api.example.com/video" },
    });
    expect(
      screen.getByText("A group URL has to start with http:// or https://."),
    ).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it("offers no scenario groups to a kind with one shape", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    // One fold, holding the fields, and no way to add or remove one.
    const group = screen.getByTestId("model-group-0") as HTMLDetailsElement;
    expect(group.tagName).toBe("DETAILS");
    expect(group.open).toBe(true);
    expect(group.querySelector("summary")?.textContent).toBe("Configuration");
    expect(screen.queryByTestId("model-group-add")).toBeNull();
    expect(screen.queryByTestId("model-group-1")).toBeNull();
    expect(screen.queryByTestId("model-group-0-remove")).toBeNull();

    // A fold folds: the fields are the browser's own details to put away.
    fireEvent.click(group.querySelector("summary") as HTMLElement);
    expect(group.open).toBe(false);
  });

  it("says a group's scenarios on its fold while they are put away", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Image" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New image model" }),
    );

    // A new image model's one group answers both of the category's scenarios,
    // and the fold says which while the fields are away.
    const group = screen.getByTestId("model-group-0") as HTMLElement;
    expect(group.querySelector("summary")?.textContent).toBe(
      "Text to image / Image edit",
    );
    // Unchecking both leaves a form with nothing to answer: it is said, and
    // the save is withheld rather than stored as a model that claims nothing.
    fireEvent.click(screen.getByTestId("model-group-0-scene-textToImage"));
    fireEvent.click(screen.getByTestId("model-group-0-scene-imageEdit"));
    expect(group.querySelector("summary")?.textContent).toBe("No scenario yet");
    expect(
      (screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByTestId("model-unclaimed")).toBeTruthy();
  });

  it("names a new model without asking for an identifier", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    // Nobody is asked for the reference a node stores: it is derived from the
    // display name, which is the part a person chose.
    expect(screen.queryByLabelText("Model identifier")).toBeNull();

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "GPT-4o mini (OpenAI)" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("GPT-4o mini (OpenAI)");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({
      id: expect.stringMatching(/^gpt-4o-mini-openai-[a-z0-9]{6}$/),
      category: "text",
      displayName: "GPT-4o mini (OpenAI)",
    });
  });

  it("keeps the stored identifier out of an edit", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );

    // The reference nodes hold is the saved model's own: a rename is a rename
    // of the display name, and the identifier is neither shown nor typed.
    expect(screen.queryByLabelText("Model identifier")).toBeNull();
    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Composer" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "composer-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Composer");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({ id: "writer" });
  });

  it("says the category by the tab and the heading, not by a field of its own", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    // The tab is already on Text and the heading says so again; a disabled
    // input repeating it a third time is a field nobody can act on.
    expect(
      screen.getByRole("heading", { name: "New text model" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );
    expect(screen.queryByLabelText("Category")).toBeNull();
    // An editor names the category in its heading instead, so the form still
    // says which kind of model is being changed.
    expect(
      screen.getByRole("heading", { name: "Edit “Writer” · text" }),
    ).toBeTruthy();
    // What the category decides is still visible: only text protocols.
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect(Array.from(protocol.options).map((option) => option.value)).toEqual([
      "openaiChat",
      "openaiResponses",
      "gemini",
      "bailianText",
    ]);
  });

  it("offers each category only the protocols that serve it", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Video" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New video model" }),
    );

    const protocol = (await screen.findByLabelText(
      "Protocol",
    )) as HTMLSelectElement;
    // Each video shape comes from the converter deployed under that
    // capability, placed where its own document asks to be.
    await screen.findByRole("option", { name: /Bailian Video/ });
    expect([...protocol.options].map((option) => option.value)).toEqual([
      "openaiVideos",
      "geminiVideo",
      "bailianVideo",
    ]);

    // Picking the other shape offers its own complete address.
    fireEvent.change(protocol, { target: { value: "geminiVideo" } });
    const url = screen.getByLabelText("Endpoint URL") as HTMLInputElement;
    expect(url.value).toContain(":predictLongRunning");
    fireEvent.change(protocol, { target: { value: "bailianVideo" } });
    expect(url.value).toContain("video-synthesis");
  });

  it("takes every shape from the registry, its own address included", async () => {
    await openSettings();
    // This program holds no table of protocols: what a category offers is
    // whatever its converter directories declare, so the form can name and
    // address a shape no build has ever heard of.
    fireEvent.click(await screen.findByRole("tab", { name: "Image" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New image model" }),
    );

    const protocol = (await screen.findByLabelText(
      "Protocol",
    )) as HTMLSelectElement;
    expect([...protocol.options].map((option) => option.value)).toEqual([
      "openaiImages",
      "bailianImage",
    ]);

    fireEvent.change(protocol, { target: { value: "bailianImage" } });
    const url = screen.getByLabelText("Endpoint URL") as HTMLInputElement;
    expect(url.value).toContain(
      "/api/v1/services/aigc/multimodal-generation/generation",
    );

    // The text shape keeps its own address, which the multimodal one is
    // derived from when a question carries a picture.
    fireEvent.click(await screen.findByRole("tab", { name: "Text" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );
    const textProtocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    await screen.findByRole("option", { name: /Bailian Text/ });
    fireEvent.change(textProtocol, { target: { value: "bailianText" } });
    expect(
      (screen.getByLabelText("Endpoint URL") as HTMLInputElement).value,
    ).toContain("/api/v1/services/aigc/text-generation/generation");
  });

  it("lists a script the registry holds under its own capability only", async () => {
    await openSettings();
    // A speech script is on offer where the registry deploys it, and nowhere
    // else: the other sound capability has a list of its own.
    fireEvent.click(await screen.findByRole("tab", { name: "Speech" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New speech model" }),
    );

    await screen.findByRole("option", { name: /Bailian Speech/ });
    const speech = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect([...speech.options].map((option) => option.value)).toEqual([
      "openaiSpeech",
      "bailianSpeech",
    ]);

    fireEvent.click(await screen.findByRole("tab", { name: "Music" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New music model" }),
    );

    await screen.findByRole("option", { name: /Music Generation/ });
    const music = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect([...music.options].map((option) => option.value)).toEqual([
      "bailianMusic",
    ]);
  });

  it("keeps a stored credential when an edit does not mention it", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Renamed" },
    });
    // The stored key is announced, and the field stays blank.
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.placeholder).toContain(MASKED);
    expect(key.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Renamed");

    const [write] = writesTo("/api/v1/models");
    const body = write.body as Record<string, unknown>;
    expect(body.displayName).toBe("Renamed");
    expect("apiKey" in body).toBe(false);
    expect(screen.getByText(`Key ${MASKED}`)).toBeTruthy();
  });

  it("clears a stored key only when asked to", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear the stored key" }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/writer/key")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/writer/key")[0].body).toEqual({
      apiKey: null,
    });
    // Scoped to the cleared model: another text model also stores no key.
    expect(within(cardOf("Writer")).getByText("No key stored")).toBeTruthy();
    confirm.mockRestore();
  });

  it("copies a model into a draft the save creates, key included", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Copy Writer" }),
    );

    // The editor opens on a draft of the copy: the fields worth repeating
    // are filled in, and nothing has been written yet.
    const display = (await screen.findByLabelText(
      "Display name",
    )) as HTMLInputElement;
    expect(display.value).toBe("Writer (copy)");
    expect(writesTo("/api/v1/models")).toHaveLength(0);

    // The credential comes along on the save: the field says so rather than
    // asking for a key nobody can read back.
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.placeholder).toContain("Writer");
    expect(key.value).toBe("");

    // Nobody is asked for the copy's identifier either: it is derived from the
    // name the copy opens with, the way a new model's is.
    expect(screen.queryByLabelText("Model identifier")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Writer (copy)");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({
      id: expect.stringMatching(/^writer-copy-[a-z0-9]{6}$/),
      displayName: "Writer (copy)",
      copyKeyFrom: "writer",
    });
    expect("apiKey" in (write.body as object)).toBe(false);
    // The credential came along with the copy.
    expect(
      within(cardOf("Writer (copy)")).getByText(`Key ${MASKED}`),
    ).toBeTruthy();
  });

  it("leaves the editor to its own Save and Cancel", async () => {
    await openSettings();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();

    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );
    // The form carries its own ways out; a Done beside them is a third door
    // that says nothing about the half-written form it leaves behind.
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("falls back to the first model as the default and records a hand-picked one", async () => {
    await openSettings();
    // Nothing was picked by hand, so the first model that can serve the
    // category is shown as the default a node falls back to.
    expect(screen.queryByTestId("text-gap")).toBeNull();
    expect(
      (
        screen.getByRole("radio", {
          name: "Use Writer as the default text model",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Use Scribe as the default text model",
      }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/defaults")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/defaults")[0].body).toEqual({
      text: "scribe",
      expectedRevision: 1,
    });
    // The hand-picked choice is the one shown as made.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("radio", {
            name: "Use Scribe as the default text model",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
  });

  it("keeps the score's own model on the music tab, apart from the voice's", async () => {
    view.models.push(
      model("speaker", "speech", "openaiSpeech", "Speaker", true),
      model("musician", "music", "bailianMusic", "Musician", true),
      model("composer", "music", "bailianMusic", "Composer", true),
    );
    await openSettings();

    // What reads the lines is on the speech tab, and what composes is not.
    fireEvent.click(await screen.findByRole("tab", { name: "Speech" }));
    expect(await screen.findByText("Speaker")).toBeTruthy();
    expect(screen.queryByText("Musician")).toBeNull();

    // The score is asked of a music model of its own: the first enabled one
    // is what a score falls back to, and the hand-picked one is recorded.
    fireEvent.click(screen.getByRole("tab", { name: "Music" }));
    expect(await screen.findByText("Musician")).toBeTruthy();
    expect(screen.queryByText("Speaker")).toBeNull();
    // Nothing here is asked for a voice, so an empty voice is no gap here.
    expect(screen.queryByTestId("speech-voice-gap")).toBeNull();
    expect(
      (
        screen.getByRole("radio", {
          name: "Use Musician as the default music model",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Use Composer as the default music model",
      }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/defaults")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/defaults")[0].body).toEqual({
      music: "composer",
      expectedRevision: 1,
    });
  });

  it("says when a speech model would read the lines without a voice", async () => {
    view.models.push(
      model("speaker", "speech", "openaiSpeech", "Speaker", true),
    );
    view.preferences.speech.voice = "";
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Speech" }));

    // The model the lines would be read by is asked for a voice, and this
    // machine has set none: the tab says what such an ask comes back as.
    expect(await screen.findByText("Speaker")).toBeTruthy();
    expect(screen.getByTestId("speech-voice-gap")).toBeTruthy();

    // The voice is filled in next door, and the gap closes.
    fireEvent.click(screen.getByRole("tab", { name: "Preferences" }));
    fireEvent.change(await screen.findByLabelText("Voice"), {
      target: { value: "longxiaochun" },
    });
    const save = screen.getByRole("button", { name: "Save preferences" });
    fireEvent.click(save);
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(true),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Speech" }));
    await waitFor(() =>
      expect(screen.queryByTestId("speech-voice-gap")).toBeNull(),
    );
  });

  it("shows the next model as the default when the stored one is gone", async () => {
    // The stored default points at a model the list no longer holds; the
    // first model that can serve is the default now, with no warning to act
    // on because there is nothing broken.
    view = {
      ...view,
      defaults: { ...view.defaults, text: "ghost" },
    };
    await openSettings();
    expect(screen.queryByTestId("text-gap")).toBeNull();
    expect(
      (
        screen.getByRole("radio", {
          name: "Use Writer as the default text model",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("deletes a model and its key when asked", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(
      within(cardOf("Scribe")).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE")).toBe(true),
    );
    expect(screen.queryByText("Scribe")).toBeNull();
    expect(screen.getByText("Writer")).toBeTruthy();
    confirm.mockRestore();
  });

  it("sends only the preference group that moved", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Preferences" }));

    fireEvent.change(await screen.findByLabelText("Images per run"), {
      target: { value: "3" },
    });
    const save = screen.getByRole("button", { name: "Save preferences" });
    fireEvent.click(save);
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(true),
    );

    const [write] = writesTo("/api/v1/models/preferences");
    expect(write.body).toEqual({
      image: { size: "1:1", quality: "auto", background: "", count: 3 },
      expectedRevision: 1,
    });
  });

  it("sends the story room's boundaries when they move", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Preferences" }));

    fireEvent.change(await screen.findByLabelText("Manuscript part length"), {
      target: { value: "6000" },
    });
    const save = screen.getByRole("button", { name: "Save preferences" });
    fireEvent.click(save);
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(true),
    );

    const [write] = writesTo("/api/v1/models/preferences");
    expect(write.body).toEqual({
      story: { splitChars: 6_000, readChars: 8_000 },
      expectedRevision: 1,
    });
  });

  it("reports a refused write and shows the state that refused it", async () => {
    refuseNextWrite = {
      status: 409,
      code: "METADATA_CONFLICT",
      message: "the configuration changed underneath this edit",
    };
    await openSettings();
    const readsBefore = readsOf("/api/v1/models");

    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    expect(
      await screen.findByText("the configuration changed underneath this edit"),
    ).toBeTruthy();
    // The view was re-read, so the form is not left holding a stale revision.
    expect(readsOf("/api/v1/models")).toBeGreaterThan(readsBefore);
  });

  it("says nothing about where the file tier keeps its key", async () => {
    await openSettings();
    await screen.findByText("Writer");

    // Where the file tier's master key sits is a deployment matter, so the
    // settings page leaves it to the docs.
    expect(screen.queryByTestId("secret-storage-note")).toBeNull();
  });

  it("moves the master key to another tier only when explicitly asked", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "System" }));

    const keyring = (await screen.findByRole("radio", {
      name: /Keyring/,
    })) as HTMLInputElement;
    expect(keyring.checked).toBe(false);
    fireEvent.click(keyring);

    await waitFor(() =>
      expect(writesTo("/api/v1/system/secret-storage")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/system/secret-storage")[0].body).toEqual({
      storage: "keyring",
    });
    await waitFor(() => expect(keyring.checked).toBe(true));
    confirm.mockRestore();
  });

  it("draws the interface in the language chosen on the system page", async () => {
    await openSettings("System");

    fireEvent.change(await screen.findByLabelText("Interface language"), {
      target: { value: "zh" },
    });

    // The dialog says its own name in the language that was chosen.
    expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
    expect(screen.getByLabelText("界面语言")).toBeTruthy();

    // And back, so the cases after this one start in English again.
    fireEvent.change(screen.getByLabelText("界面语言"), {
      target: { value: "en" },
    });
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
  });

  it("lists the stored keys masked, and deletes one on request", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "System" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage keys (2)" }),
    );

    // Both stored credentials are named, masked, and dated; the plaintext
    // a test typed elsewhere never appears.
    const writer = cardOf("Writer");
    expect(writer.textContent).toContain(MASKED);
    expect(writer.textContent).toContain("rotated 2025-01-02");
    expect(cardOf("Painter").textContent).toContain("image");
    expect(screen.queryByText(KEY)).toBeNull();

    fireEvent.click(within(writer).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(writesTo("/api/v1/models/writer/key")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/writer/key")[0].body).toEqual({
      apiKey: null,
    });
    // The list follows the store: the cleared key is gone, the other stays.
    await waitFor(() => expect(screen.queryByText("Writer")).toBeNull());
    expect(screen.getByText("Painter")).toBeTruthy();
    confirm.mockRestore();
  });

  it("explains a missing master key instead of only reporting it", async () => {
    refuseNextWrite = {
      status: 503,
      code: "CONFIG_METADATA_KEY_MISSING",
      message: "no master key protects stored credentials",
    };
    await openSettings();
    fireEvent.click(
      within(cardOf("Scribe")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: KEY },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    expect(
      await screen.findByText("no master key protects stored credentials"),
    ).toBeTruthy();
    const guidance = await screen.findByTestId("error-guidance");
    expect(guidance.textContent).toContain("--generate-key");
    expect(guidance.textContent).toContain("MOKA_METADATA_KEY");
  });

  it("closes on escape", async () => {
    await openSettings();
    await screen.findByText("Writer");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("says so when the registry holds no shape for a category", async () => {
    await openSettings();
    // Recognition's shapes come from converter scripts alone, and this
    // registry holds none: the form says so rather than naming a shape
    // nothing on this machine stands behind, and cannot be saved.
    fireEvent.click(
      await screen.findByRole("tab", { name: "Speech recognition" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "New speech recognition model",
      }),
    );

    await screen.findByText(/No protocol is available/);
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect(protocol.options).toHaveLength(0);
    expect(
      (screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("re-reads the converter registry each time it opens", async () => {
    await openSettings();
    await screen.findByText("Writer");
    expect(readsOf("/api/v1/converter/protocols")).toBe(1);

    // A converter added under the models tree while the app runs is on the
    // next open's list; leaving the list read once would hide it until a
    // restart nobody asked for.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(readsOf("/api/v1/converter/protocols")).toBe(2));
  });
});

describe("naming a protocol", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("uses the converter's own words for the language the interface is drawn in", async () => {
    await i18n.changeLanguage("zh");
    expect(protocolLabel(REGISTRY, "bailianImage")).toBe(
      "阿里云百炼 · 图像生成与编辑（万相）",
    );
    // A converter that speaks one language only is named in it, whatever the
    // interface is drawn in — a name beats a blank line.
    expect(protocolLabel(REGISTRY, "openaiImages")).toBe(
      "OpenAI-compatible · Images API",
    );
    // A shape no converter on this machine holds is named by its bare id, so a
    // stored model still shows what it speaks.
    expect(protocolLabel(REGISTRY, "wanImageDraft")).toBe("wanImageDraft");
  });

  it("places a shape where its own document asks to be", () => {
    // The order is the document's, not this program's: a converter added
    // later can ask to be first.
    expect(
      protocolChoices(REGISTRY, "image").map((choice) => choice.id),
    ).toEqual(["openaiImages", "bailianImage"]);
    expect(
      protocolChoices(
        {
          text: {
            late: {
              script: "text/late.lua",
              displayName: "Late",
              urlExample: "https://example.com/late",
              order: 5,
            },
          },
        },
        "text",
      ).map((choice) => choice.id),
    ).toEqual(["late"]);
  });
});
