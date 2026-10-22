import { create } from "zustand";
import {
  isApiError,
  modelsApi,
  type DefaultsPatch,
  type ModelDraft,
  type ModelsView,
  type PreferencesPatch,
  type ProtocolGroups,
  type SecretStorageChoice,
} from "../../api";
import type { Capability } from "../../shared/domain";
import { i18n } from "../../shared/i18n";

/** The settings tabs: one per model capability, plus the global preferences. */
export type SettingsTab = Capability | "preferences";

/** The three top-level settings sections: the open project, models, the system. */
export type SettingsTopTab = "project" | "model" | "system";

export interface ModelOption {
  /** The model configuration's own id, which is what a node stores. */
  reference: string;
  label: string;
}

/**
 * The models a category can be pointed at: the enabled configurations of
 * that category, labelled by the display name somebody chose.
 */
export function modelOptionsFor(
  view: ModelsView | null,
  capability: Capability,
): ModelOption[] {
  if (!view || !Array.isArray(view.models)) return [];
  return view.models
    .filter((model) => model.enabled && model.category === capability)
    .map((model) => ({ reference: model.id, label: model.displayName }));
}

/**
 * The default a category actually generates with: the stored choice while it
 * still names an enabled model of the category, and the first enabled model
 * otherwise. This mirrors the server's own fallback, so what the list shows
 * as the default is what a node naming no model of its own gets.
 */
export function effectiveDefaultId(
  view: ModelsView | null,
  capability: Capability,
): string | null {
  if (!view || !Array.isArray(view.models)) return null;
  const serving = view.models.filter(
    (model) => model.enabled && model.category === capability,
  );
  const stored = view.defaults[capability];
  if (stored !== null && serving.some((model) => model.id === stored)) {
    return stored;
  }
  return serving[0]?.id ?? null;
}

/** One protocol the form may offer for a category. */
export interface ProtocolChoice {
  id: string;
  label: string;
  urlExample: string;
}

/** Where a converter sits among its capability's protocols when it does not say. */
const DEFAULT_ORDER = 1000;

/**
 * The protocols a category offers, read from the converter registry.
 *
 * This program holds no list of protocols: a shape is on offer because a
 * converter directory declares it, under the capability that directory sits
 * in. Each one is placed where its own document asks to be, and the name a
 * reader sees breaks a tie — so a deployment that ships converters of its own
 * decides both what is offered and in what order.
 *
 * The registry is read through the server, so before it arrives — or after a
 * read that failed — a category offers nothing, and the form says so rather
 * than naming a shape nothing on this machine stands behind.
 */
export function protocolChoices(
  protocols: ProtocolGroups | null,
  capability: Capability,
): ProtocolChoice[] {
  const group = protocols?.[capability];
  if (!group) return [];
  return Object.entries(group)
    .map(([id, entry]) => ({
      id,
      label: protocolLabel(protocols, id),
      urlExample: entry.urlExample ?? "",
      order: entry.order ?? DEFAULT_ORDER,
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ id, label, urlExample }) => ({ id, label, urlExample }));
}

/**
 * What a protocol is called, in the language the interface is drawn in.
 *
 * A converter's own words for that language come first, then its English
 * ones, then the name it gives itself in whichever language it chose. A
 * protocol the registry does not hold is named by its bare id, so a stored
 * configuration whose converter has left the tree still shows what it speaks.
 */
export function protocolLabel(
  protocols: ProtocolGroups | null,
  id: string,
): string {
  const entry = findProtocol(protocols, id);
  if (!entry) return id;
  const labels = entry.labels ?? {};
  const language = (i18n.resolvedLanguage ?? "en").split("-")[0];
  return labels[language] || labels.en || entry.displayName || id;
}

/**
 * The example address a protocol speaks at, empty when the registry does not
 * hold it: an address is a property of the converter, not of this program.
 */
export function protocolUrlExample(
  protocols: ProtocolGroups | null,
  id: string,
): string {
  return findProtocol(protocols, id)?.urlExample ?? "";
}

/**
 * What a protocol declares about itself beyond speaking its wire shape. An
 * unknown protocol declares nothing, which is the safe reading: a feature is
 * a promise the converter makes, not one this program can assume.
 */
export function protocolFeatures(
  protocols: ProtocolGroups | null,
  id: string,
): Record<string, boolean> {
  return findProtocol(protocols, id)?.features ?? {};
}

function findProtocol(protocols: ProtocolGroups | null, id: string) {
  if (!protocols) return undefined;
  for (const group of Object.values(protocols)) {
    if (group[id]) return group[id];
  }
  return undefined;
}

/**
 * Codes whose fix is not in this dialog. The server's message says what is
 * wrong; this says what to do about it, because the remedy is a shell command
 * and a restart that no control here can perform.
 */
const GUIDANCE: Record<string, string> = {
  CONFIG_METADATA_KEY_MISSING: "settings:guidance.configMetadataKeyMissing",
};

/** How to act on a failure whose code is known, if there is anything to add. */
export function guidanceFor(code: string | null): string | null {
  if (code === null) return null;
  const key = GUIDANCE[code];
  return key ? i18n.t(key) : null;
}

/** The two fields every failure sets on the store. */
interface Failure {
  error: string;
  errorCode: string | null;
}

function describe(error: unknown, fallback: string): Failure {
  return {
    error: error instanceof Error ? error.message : fallback,
    errorCode: isApiError(error) ? error.code : null,
  };
}

/**
 * Model settings: the stored configuration, and the dialog that edits it.
 *
 * Every write answers with the whole view, so state never has to be patched
 * field by field — and the revision it carries is what the next write is
 * checked against.
 */
interface ModelState {
  open: boolean;
  /** Which top-level section the dialog shows. */
  topTab: SettingsTopTab;
  tab: SettingsTab;
  /** Which model the editor is open on: an id, "new", or null for the list. */
  editing: string | "new" | null;
  /** The category a "new" editor starts on. */
  newCategory: Capability;
  /**
   * The configuration a "new" editor is a copy of. The copy is a draft like
   * any other: nothing is stored until the form saves, and the identifier is
   * a suggestion the form is free to overwrite until then.
   */
  copyOf: string | null;
  view: ModelsView | null;
  /**
   * The converter registry's protocols, grouped by capability. Null until the
   * read lands — or forever, if it failed, and a category then offers nothing.
   * Re-read whenever settings opens: a converter is added by dropping a
   * directory into the models tree, and that happens while the app runs.
   */
  protocols: ProtocolGroups | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** The problem code behind `error`, so the dialog can explain the fix. */
  errorCode: string | null;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setTopTab: (topTab: SettingsTopTab) => void;
  setTab: (tab: SettingsTab) => void;
  editModel: (id: string) => void;
  newModel: (category: Capability) => void;
  closeEditor: () => void;
  /**
   * Opens settings on the category that matters for a node: the tab of the
   * model it named if that still exists, otherwise the category's own tab,
   * ready to add one.
   */
  openModelForCapability: (
    capability: Capability,
    reference?: string | null,
  ) => void;
  load: () => Promise<void>;
  /** Reads the registry's protocols. `force` re-reads one already held. */
  loadProtocols: (force?: boolean) => Promise<void>;
  saveModel: (draft: ModelDraft) => Promise<boolean>;
  removeModel: (id: string) => Promise<boolean>;
  /** Opens a new-model editor pre-filled as a copy of one configuration. */
  duplicateModel: (id: string) => void;
  setKey: (id: string, apiKey: string | null) => Promise<boolean>;
  /** Moves the master key protecting every stored credential to another tier. */
  setSecretStorage: (storage: SecretStorageChoice) => Promise<boolean>;
  /** Makes one model the default of a capability, or clears that capability. */
  setDefault: (capability: Capability, id: string | null) => Promise<boolean>;
  savePreferences: (patch: PreferencesPatch) => Promise<boolean>;
  reset: () => void;
}

export const useModelStore = create<ModelState>()((set, get) => {
  /**
   * Runs a write, adopting the view it returns.
   *
   * The revision is filled in here rather than at the call sites: it is a
   * property of the state this store holds, and a form that had to remember to
   * send it would eventually forget. A refused write refreshes the view first
   * and reports second, so the message describes state the user can now see.
   */
  const write = async (
    fallback: string,
    send: (revision: number | null) => Promise<ModelsView>,
  ): Promise<boolean> => {
    set({ saving: true, error: null, errorCode: null });
    try {
      set({ view: await send(get().view?.revision ?? null), saving: false });
      return true;
    } catch (error) {
      set({ saving: false });
      if (isApiError(error, "METADATA_CONFLICT")) await get().load();
      set(describe(error, fallback));
      return false;
    }
  };

  return {
    open: false,
    topTab: "model",
    tab: "text",
    editing: null,
    newCategory: "text",
    copyOf: null,
    view: null,
    protocols: null,
    loading: false,
    saving: false,
    error: null,
    errorCode: null,

    openSettings(tab = "text") {
      // The registry read rides along, so a converter directory added since
      // the last open is on offer by the time a tab is picked.
      void get().loadProtocols(true);
      set({ open: true, topTab: "model", tab });
    },

    closeSettings() {
      // Back to the list on the next open: an editor left open on a model is
      // a surprise to whoever opens settings for something else.
      set({ open: false, editing: null, copyOf: null });
    },

    setTopTab(topTab) {
      // The model editor belongs to the Model section; leaving it behind
      // closes it, the same way switching a category tab does.
      set({ topTab, editing: null, copyOf: null });
    },

    setTab(tab) {
      set({ tab, editing: null, copyOf: null });
    },

    editModel(id) {
      const view = get().view;
      const category =
        view?.models.find((model) => model.id === id)?.category ?? get().tab;
      set({
        open: true,
        topTab: "model",
        tab: category === "preferences" ? "text" : category,
        editing: id,
        copyOf: null,
      });
    },

    newModel(category) {
      set({
        open: true,
        topTab: "model",
        tab: category,
        newCategory: category,
        editing: "new",
        copyOf: null,
      });
    },

    closeEditor() {
      set({ editing: null, copyOf: null });
    },

    openModelForCapability(capability, reference = null) {
      const view = get().view;
      const models = view?.models ?? [];
      const known =
        reference !== null && models.some((model) => model.id === reference);
      // Straight to the model a node named when it still exists, so the thing
      // that would serve the node is the thing the editor opens on.
      set({
        open: true,
        topTab: "model",
        tab: capability,
        editing: known ? reference : null,
        copyOf: null,
      });
    },

    async load() {
      if (get().loading) return;
      set({ loading: true });
      try {
        const view = await modelsApi.list();
        // A response with no model list is not a configuration; keeping it
        // would make every reader of `view` treat an answer that is not one
        // as the settings it asked for.
        if (
          !view ||
          !Array.isArray(view.models) ||
          typeof view.preferences !== "object" ||
          view.preferences === null ||
          typeof view.defaults !== "object" ||
          view.defaults === null
        ) {
          throw new Error("the models answer is not a configuration");
        }
        set({
          view,
          loading: false,
          error: null,
          errorCode: null,
        });
      } catch (error) {
        set({
          loading: false,
          ...describe(error, i18n.t("settings:errors.load")),
        });
      }
    },

    async loadProtocols(force = false) {
      if (!force && get().protocols !== null) return;
      try {
        const response = await modelsApi.fetchProtocols();
        set({ protocols: response.protocols });
      } catch {
        // Quiet on purpose: a category with no registry read offers nothing,
        // and the dialog says so where a reader would look for a shape.
      }
    },

    saveModel(draft) {
      return write(i18n.t("settings:errors.saveModel"), (revision) =>
        modelsApi.upsert({ ...draft, expectedRevision: revision }),
      );
    },

    removeModel(id) {
      return write(i18n.t("settings:errors.removeModel"), (revision) =>
        modelsApi.remove(id, revision ?? undefined),
      );
    },

    duplicateModel(id) {
      const source = (get().view?.models ?? []).find(
        (model) => model.id === id,
      );
      if (!source) return;
      // The copy is a draft, not a write: the point of duplicating is to
      // change something before it exists — the identifier above all — so
      // nothing is stored until the form saves, and an abandoned copy leaves
      // nothing behind.
      set({
        open: true,
        topTab: "model",
        tab: source.category,
        newCategory: source.category,
        editing: "new",
        copyOf: id,
      });
    },

    setKey(id, apiKey) {
      return write(i18n.t("settings:errors.updateKey"), () =>
        modelsApi.setKey(id, apiKey),
      );
    },

    setSecretStorage(storage) {
      return write(i18n.t("settings:errors.switchStorage"), () =>
        modelsApi.setSecretStorage(storage),
      );
    },

    setDefault(capability, id) {
      const patch: DefaultsPatch = { [capability]: id };
      return write(i18n.t("settings:errors.saveDefault"), (revision) =>
        modelsApi.setDefaults({ ...patch, expectedRevision: revision }),
      );
    },

    savePreferences(patch) {
      return write(i18n.t("settings:errors.savePreferences"), (revision) =>
        modelsApi.setPreferences({ ...patch, expectedRevision: revision }),
      );
    },

    reset() {
      set({
        open: false,
        topTab: "model",
        tab: "text",
        editing: null,
        newCategory: "text",
        copyOf: null,
        view: null,
        loading: false,
        saving: false,
        error: null,
        errorCode: null,
      });
    },
  };
});
