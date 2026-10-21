import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { create } from "zustand";
import enAgent from "./locales/en/agent.json" with { type: "json" };
import enApp from "./locales/en/app.json" with { type: "json" };
import enAssets from "./locales/en/assets.json" with { type: "json" };
import enAssistant from "./locales/en/assistant.json" with { type: "json" };
import enClip from "./locales/en/clip.json" with { type: "json" };
import enCommon from "./locales/en/common.json" with { type: "json" };
import enDirector from "./locales/en/director.json" with { type: "json" };
import enDomain from "./locales/en/domain.json" with { type: "json" };
import enEditor from "./locales/en/editor.json" with { type: "json" };
import enErrors from "./locales/en/errors.json" with { type: "json" };
import enProblems from "./locales/en/problems.json" with { type: "json" };
import enSettings from "./locales/en/settings.json" with { type: "json" };
import enStory from "./locales/en/story.json" with { type: "json" };
import zhAgent from "./locales/zh/agent.json" with { type: "json" };
import zhApp from "./locales/zh/app.json" with { type: "json" };
import zhAssets from "./locales/zh/assets.json" with { type: "json" };
import zhAssistant from "./locales/zh/assistant.json" with { type: "json" };
import zhClip from "./locales/zh/clip.json" with { type: "json" };
import zhCommon from "./locales/zh/common.json" with { type: "json" };
import zhDirector from "./locales/zh/director.json" with { type: "json" };
import zhDomain from "./locales/zh/domain.json" with { type: "json" };
import zhEditor from "./locales/zh/editor.json" with { type: "json" };
import zhErrors from "./locales/zh/errors.json" with { type: "json" };
import zhProblems from "./locales/zh/problems.json" with { type: "json" };
import zhSettings from "./locales/zh/settings.json" with { type: "json" };
import zhStory from "./locales/zh/story.json" with { type: "json" };

/**
 * Which language the interface is drawn in. "system" follows the machine's
 * own language and is the default; a language picked outright outranks it.
 */
export const LOCALE_MODES = ["system", "en", "zh"] as const;
export type LocaleMode = (typeof LOCALE_MODES)[number];
export type Locale = "en" | "zh";

/** The languages the interface carries words for. */
export const LOCALES: Locale[] = ["en", "zh"];

/** Kept on this machine, beside the other choices that are about the reader. */
const STORED_UNDER = "moka-canvas:locale";

/**
 * The host this module is running in, reached instead of named.
 *
 * The words are not only read by the browser: unit tests and the browser
 * suite's project compile this module too, and those have no DOM declared —
 * so the page, the store, and the machine's language are looked up rather
 * than spelled. Each is absent where it has no meaning, and the code below
 * says what it does without one.
 */
type Host = {
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  navigator?: { language?: string };
  document?: {
    title: string;
    documentElement: { lang: string };
  };
  window?: object;
};

function host(): Host {
  return globalThis as unknown as Host;
}

function readMode(): LocaleMode {
  // A host with no store to read wants the start.
  const store = host().localStorage;
  if (store === undefined) return "system";
  try {
    const kept = store.getItem(STORED_UNDER);
    return LOCALE_MODES.find((mode) => mode === kept) ?? "system";
  } catch {
    // A store this cannot read is one that has nothing in it.
    return "system";
  }
}

function keepMode(mode: LocaleMode) {
  const store = host().localStorage;
  if (store === undefined) return;
  try {
    store.setItem(STORED_UNDER, mode);
  } catch {
    // A store that will not take it costs the remembering, not the choice.
  }
}

/** Every Chinese dialect reads the same Chinese interface; others read English. */
export function systemLocale(language?: string): Locale {
  const tag = language ?? host().navigator?.language ?? "";
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLocale(mode: LocaleMode): Locale {
  return mode === "system" ? systemLocale() : mode;
}

const resources = {
  en: {
    agent: enAgent,
    app: enApp,
    assets: enAssets,
    assistant: enAssistant,
    clip: enClip,
    common: enCommon,
    director: enDirector,
    domain: enDomain,
    editor: enEditor,
    errors: enErrors,
    problems: enProblems,
    settings: enSettings,
    story: enStory,
  },
  zh: {
    agent: zhAgent,
    app: zhApp,
    assets: zhAssets,
    assistant: zhAssistant,
    clip: zhClip,
    common: zhCommon,
    director: zhDirector,
    domain: zhDomain,
    editor: zhEditor,
    errors: zhErrors,
    problems: zhProblems,
    settings: zhSettings,
    story: zhStory,
  },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLocale(readMode()),
  fallbackLng: "en",
  supportedLngs: LOCALES,
  defaultNS: "common",
  // React escapes the text it renders; the catalogues hold it as written.
  interpolation: { escapeValue: false },
  // The catalogues are bundled, so the first render already has its words.
  initAsync: false,
});

/**
 * The name on the window and the browser tab: the product's name in the
 * current language. The desktop shell's title is kept beside the page's so
 * the taskbar reads the same as the window.
 */
function syncNativeChrome() {
  const page = host().document;
  if (page === undefined) return;
  const name = i18n.t("app:name");
  page.title = name;
  page.documentElement.lang = i18n.resolvedLanguage ?? "en";
  void setDesktopTitle(name);
}

async function setDesktopTitle(title: string) {
  const shell = host().window;
  if (shell === undefined || !("__TAURI_INTERNALS__" in shell)) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    // A window that refuses the title still has the page's own.
  }
}

i18n.on("languageChanged", syncNativeChrome);
syncNativeChrome();

export interface LocaleState {
  mode: LocaleMode;
  setMode: (mode: LocaleMode) => void;
}

/** The language choice in the shape the settings screen edits it. */
export const useLocale = create<LocaleState>()((set) => ({
  mode: readMode(),
  setMode: (mode) => {
    keepMode(mode);
    set({ mode });
    void i18n.changeLanguage(resolveLocale(mode));
  },
}));

export { i18n };
