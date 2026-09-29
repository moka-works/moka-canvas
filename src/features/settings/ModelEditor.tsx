import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ModelDraft,
  ModelView,
  ProtocolGroups,
  SubModel,
} from "../../api";
import {
  CAPABILITY_LABELS,
  MAX_MODEL_NAME_LENGTH,
  MAX_VIDEO_SECONDS,
  MODEL_SCENE_LABELS,
  SCENES_OF_CATEGORY,
  type Capability,
  type ModelScene,
} from "../../shared/domain";
import {
  protocolChoices,
  protocolLabel,
  protocolUrlExample,
  useModelStore,
} from "./modelStore";
import { uniqueModelId } from "./modelId";

interface Props {
  /** The stored configuration being edited, or null for a new one. */
  model: ModelView | null;
  /** The configuration a new one is a copy of, or null for a plain new one. */
  copySource?: ModelView | null;
  /** The category a new configuration starts on. */
  category: Capability;
  onDone: () => void;
}

/**
 * One scenario group as the form holds it: the address as text so a blank
 * field can mean "wherever the first group asks", and whether the group's
 * fields are showing.
 */
interface GroupDraft {
  model: string;
  url: string;
  scenes: ModelScene[];
  /** Whether the group's fields show; a form opens with them showing. */
  open: boolean;
}

interface FormState {
  /** The id of a converter directory, which is the protocol's wire name. */
  protocol: string;
  url: string;
  model: string;
  displayName: string;
  /** The longest one clip may be, as text so a blank field can mean none. */
  maxVideoSeconds: string;
  /** The scenarios the first group's own model answers. */
  scenes: ModelScene[];
  /** Whether the first group's fields show. */
  open: boolean;
  /** The groups after the first; empty for a category with no scenarios. */
  groups: GroupDraft[];
  enabled: boolean;
  apiKey: string;
}

/**
 * The form with one scenario's check moved to the group that just took it.
 *
 * A scenario is answered by one group, so checking it somewhere takes it from
 * wherever it was: two groups both claiming one scenario would be a
 * configuration the server refuses, and a form that can build one is a form
 * that fails at save. Group 0 is the first group, which holds the
 * model-level fields.
 */
function toggleScene(
  form: FormState,
  at: number,
  scene: ModelScene,
  checked: boolean,
): FormState {
  const withCheck = (scenes: ModelScene[]) =>
    checked
      ? scenes.includes(scene)
        ? scenes
        : [...scenes, scene]
      : scenes.filter((held) => held !== scene);
  const withoutScene = (scenes: ModelScene[]) =>
    checked ? scenes.filter((held) => held !== scene) : scenes;
  return {
    ...form,
    scenes: at === 0 ? withCheck(form.scenes) : withoutScene(form.scenes),
    groups: form.groups.map((group, index) => ({
      ...group,
      scenes:
        index === at - 1 ? withCheck(group.scenes) : withoutScene(group.scenes),
    })),
  };
}

/** The scenarios no group answers for, in the category's own order. */
function uncoveredScenes(category: Capability, form: FormState): ModelScene[] {
  const claimed = new Set([
    ...form.scenes,
    ...form.groups.flatMap((group) => group.scenes),
  ]);
  return SCENES_OF_CATEGORY[category].filter((scene) => !claimed.has(scene));
}

/**
 * The scenarios a form opens on: what the configuration says its own model
 * answers, or — where nothing was said and nothing routes — every scenario of
 * the category, because that is what a configuration claiming nothing answers.
 */
function initialScenes(
  category: Capability,
  source: ModelView | null,
): ModelScene[] {
  const scenes = SCENES_OF_CATEGORY[category];
  if (source === null) return [...scenes];
  const said = source.scenes ?? [];
  if (said.length > 0) return [...said];
  return (source.subModels ?? []).length > 0 ? [] : [...scenes];
}

/** What one group after the first is missing, as a message key, or null. */
function groupProblem(group: GroupDraft): string | null {
  if (group.model.trim() === "") return "settings:editor.groupNeedsModel";
  if (group.url.trim() !== "" && !/^https?:\/\/\S+$/.test(group.url.trim())) {
    return "settings:editor.groupUrlBad";
  }
  if (group.scenes.length === 0) return "settings:editor.groupNeedsScene";
  return null;
}

/** The stored groups as the form holds them. */
function draftGroups(subModels: SubModel[] | undefined): GroupDraft[] {
  return (subModels ?? []).map((sub) => ({
    model: sub.model,
    url: sub.url ?? "",
    scenes: [...sub.scenes],
    open: true,
  }));
}

function initialForm(
  model: ModelView | null,
  copySource: ModelView | null,
  category: Capability,
  protocols: ProtocolGroups | null,
): FormState {
  if (model === null && copySource !== null) {
    // A copy starts from the source's fields, including the protocol it may
    // alone speak.
    return {
      protocol: copySource.protocol,
      url: copySource.url,
      model: copySource.model,
      displayName: `${copySource.displayName} (copy)`.slice(
        0,
        MAX_MODEL_NAME_LENGTH,
      ),
      maxVideoSeconds: ceilingText(copySource.maxVideoSeconds),
      scenes: initialScenes(category, copySource),
      open: true,
      groups: draftGroups(copySource.subModels),
      enabled: copySource.enabled,
      apiKey: "",
    };
  }
  if (model === null) {
    // A category whose shapes all come from the converter registry has
    // nothing to offer until that has been read — recognition is one — so the
    // form may start with no protocol at all and adopt one when it arrives.
    const choice = protocolChoices(protocols, category)[0] ?? null;
    return {
      protocol: choice?.id ?? "",
      url: choice?.urlExample ?? "",
      model: "",
      displayName: "",
      maxVideoSeconds: "",
      scenes: initialScenes(category, null),
      open: true,
      groups: [],
      enabled: true,
      apiKey: "",
    };
  }
  return {
    protocol: model.protocol,
    url: model.url,
    model: model.model,
    displayName: model.displayName,
    maxVideoSeconds: ceilingText(model.maxVideoSeconds),
    scenes: initialScenes(category, model),
    open: true,
    groups: draftGroups(model.subModels),
    enabled: model.enabled,
    apiKey: "",
  };
}

/** A stored clip ceiling as the field shows it: a number, or nothing. */
function ceilingText(seconds: number | null | undefined): string {
  return seconds == null ? "" : String(seconds);
}

/**
 * One model configuration, written out in full.
 *
 * There is no provider to inherit from: the address is the complete endpoint,
 * the protocol says what shape arrives there, and the key belongs to this
 * model alone. A copy of another configuration is a starting point rather
 * than a relationship — duplicating carries the fields and the key, and the
 * two can then diverge without touching each other.
 *
 * Everything below the display name is kept in folds: a category that splits
 * its work by scenario — drawing from editing, a shot from its framing — gets
 * one group per set of scenarios, and a category with one shape gets a single
 * group holding its fields. A scenario is checked in at most one group, and a
 * scenario no group checks is refused at generation time, which the form says
 * before the save rather than after.
 *
 * The identifier is the one thing nobody has to think about: it is derived
 * from the display name and never shown, because what it does — stay the
 * reference a node holds — matters more than what it reads as. It is settled
 * at the save against the models that exist then: an identifier a stored
 * configuration holds names that configuration, and a write under it would
 * replace it, so a name already taken is answered by drawing another.
 */
export function ModelEditor({
  model,
  copySource = null,
  category,
  onDone,
}: Props) {
  const { t } = useTranslation();
  const saving = useModelStore((state) => state.saving);
  const view = useModelStore((state) => state.view);
  const protocols = useModelStore((state) => state.protocols);
  const [form, setForm] = useState<FormState>(() =>
    initialForm(model, copySource, category, protocols),
  );
  /**
   * Whether the last save was refused because every identifier the name
   * suggests is taken. Nothing is saved over anybody; a rename draws afresh.
   */
  const [clash, setClash] = useState(false);

  const edit = (patch: Partial<FormState>) =>
    setForm((state) => ({ ...state, ...patch }));

  const sceneChoices = SCENES_OF_CATEGORY[category];
  // A category that splits its work by scenario offers a group per set of
  // them; a category with one shape has nothing to split and says nothing.
  const routed = sceneChoices.length > 0;

  /**
   * What the protocol picker offers. A stored configuration whose script
   * has since left the registry still gets a line, so the form names what
   * is saved instead of silently falling back to another shape.
   */
  const choices = useMemo(() => {
    const offered = protocolChoices(protocols, category);
    const storedMissing =
      form.protocol !== "" &&
      !offered.some((choice) => choice.id === form.protocol);
    return storedMissing
      ? [
          {
            id: form.protocol,
            label: protocolLabel(protocols, form.protocol),
            urlExample: protocolUrlExample(protocols, form.protocol),
          },
          ...offered,
        ]
      : offered;
  }, [protocols, category, form.protocol]);

  const chooseProtocol = (protocol: string) => {
    // A form still carrying the example of the previous shape adopts the
    // new one; an address somebody typed is theirs to keep.
    const previousExample = protocolUrlExample(protocols, form.protocol);
    const nextExample = protocolUrlExample(protocols, protocol);
    const url =
      form.url.trim() === "" || form.url.trim() === previousExample
        ? nextExample
        : form.url;
    edit({ protocol, url });
  };

  // The registry may land after the form was opened, which is the only case a
  // form begins with no shape chosen. Adopted here rather than left to the
  // picker's default, because a picker with nothing in it cannot be saved.
  useEffect(() => {
    if (form.protocol !== "" || choices.length === 0) return;
    setForm((state) => ({
      ...state,
      protocol: choices[0].id,
      url: choices[0].urlExample,
    }));
  }, [choices, form.protocol]);

  /** Whether a stored configuration already answers to an identifier. */
  const isTaken = useCallback(
    (candidate: string) =>
      (view?.models ?? []).some(
        (entry) => entry.id.toLowerCase() === candidate.toLowerCase(),
      ),
    [view],
  );

  const urlShaped = /^https?:\/\/\S+$/.test(form.url.trim());
  // A clip ceiling is a video model's alone, and a number outside what one
  // clip may be is nothing to plan with: the field says so before the save.
  const ceilingText = form.maxVideoSeconds.trim();
  const ceilingNumber = ceilingText === "" ? null : Number(ceilingText);
  const ceilingOk =
    ceilingText === "" ||
    (ceilingNumber !== null &&
      Number.isInteger(ceilingNumber) &&
      ceilingNumber >= 1 &&
      ceilingNumber <= MAX_VIDEO_SECONDS);
  // The scenarios a routed category has that no group answers for, and whether
  // any group answers for one at all. A configuration claiming nothing would
  // answer everything by the server's oldest rule, which is not what an
  // emptied form says, so such a form is not one to save.
  const uncovered = routed ? uncoveredScenes(category, form) : [];
  const claimedEmpty =
    routed &&
    form.scenes.length === 0 &&
    form.groups.every((group) => group.scenes.length === 0);
  const canSave =
    !saving &&
    form.protocol !== "" &&
    form.displayName.trim() !== "" &&
    form.model.trim() !== "" &&
    ceilingOk &&
    urlShaped &&
    !claimedEmpty &&
    form.groups.every((group) => groupProblem(group) === null);

  const setGroup = (at: number, patch: Partial<GroupDraft>) =>
    edit({
      groups: form.groups.map((group, index) =>
        index === at ? { ...group, ...patch } : group,
      ),
    });

  const save = async () => {
    // The identifier is settled here, against the models the store holds now,
    // rather than while the form is typed: it is never shown, so nothing else
    // would notice a name taken since — and the server replaces the
    // configuration an identifier names, so a second model sharing one would
    // be one write over the other. An existing configuration keeps the
    // identifier its nodes already store; a new one draws until free.
    const id =
      model !== null ? model.id : uniqueModelId(form.displayName, isTaken);
    if (id === null) {
      setClash(true);
      return;
    }
    setClash(false);
    const draft: ModelDraft = {
      id,
      category,
      protocol: form.protocol,
      url: form.url.trim(),
      model: form.model.trim(),
      displayName: form.displayName.trim(),
      enabled: form.enabled,
    };
    // Only a video model keeps a ceiling: the other categories have no such
    // window, and a form that never showed the field leaves it out entirely.
    if (category === "video" && ceilingNumber !== null) {
      draft.maxVideoSeconds = ceilingNumber;
    }
    // Scenario claims belong to video and image models, and they travel only
    // where there is something to say — or something stored to clear.
    if (routed) {
      if (form.scenes.length > 0 || (model?.scenes ?? []).length > 0) {
        draft.scenes = [...form.scenes];
      }
      if (form.groups.length > 0 || (model?.subModels ?? []).length > 0) {
        draft.subModels = form.groups.map((group) => ({
          model: group.model.trim(),
          ...(group.url.trim() === "" ? {} : { url: group.url.trim() }),
          scenes: [...group.scenes],
        }));
      }
    }
    // A blank key field keeps whatever is stored; typing one replaces it.
    // Clearing is its own button, so saving an unrelated edit cannot cost a
    // working key. A copy names its source instead: the client never sees
    // the key, so the server takes it from the configuration being copied.
    if (form.apiKey.trim() !== "") {
      draft.apiKey = form.apiKey.trim();
    } else if (model === null && copySource !== null) {
      draft.copyKeyFrom = copySource.id;
    }
    const saved = await useModelStore.getState().saveModel(draft);
    if (saved) onDone();
  };

  const clearKey = async () => {
    if (model === null) return;
    if (
      !window.confirm(
        t("settings:editor.clearKeyConfirm", { name: model.displayName }),
      )
    ) {
      return;
    }
    await useModelStore.getState().setKey(model.id, null);
    onDone();
  };

  /** What a group's fold says while its fields are put away. */
  const groupTitle = (scenes: ModelScene[]): string =>
    scenes.length === 0
      ? t("settings:editor.groupNoScenes")
      : scenes.map((scene) => t(MODEL_SCENE_LABELS[scene])).join(" / ");

  /** The scenarios one group answers, checked at the top of its fields. */
  const sceneRow = (at: number, scenes: ModelScene[]) => (
    <div className="settings-row" data-testid={`model-group-${at}-scenes`}>
      {sceneChoices.map((scene) => (
        <label className="settings-check" key={scene}>
          <input
            aria-label={`${t("settings:editor.groupScenes")} ${at + 1} ${t(MODEL_SCENE_LABELS[scene])}`}
            checked={scenes.includes(scene)}
            data-testid={`model-group-${at}-scene-${scene}`}
            onChange={(event) =>
              setForm((state) =>
                toggleScene(state, at, scene, event.target.checked),
              )
            }
            type="checkbox"
          />
          <span>{t(MODEL_SCENE_LABELS[scene])}</span>
        </label>
      ))}
    </div>
  );

  /** The fields every group's first one has: how this model is reached. */
  const protocolField = (
    <>
      <label className="dialog-field">
        <span>{t("settings:editor.protocol")}</span>
        <select
          aria-label={t("settings:editor.protocol")}
          onChange={(event) => chooseProtocol(event.target.value)}
          value={form.protocol}
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {choices.length === 0 && (
        <p className="settings-hint" role="alert">
          {t("settings:editor.noProtocols")}
        </p>
      )}
    </>
  );

  const modelField = (at: number | null) => {
    const suffix = at === null ? "" : ` ${at + 1}`;
    return (
      <label className="dialog-field">
        <span>{t("settings:editor.modelName")}</span>
        <input
          aria-label={`${t("settings:editor.modelName")}${suffix}`}
          data-testid={at === null ? "model-name" : `model-group-${at}-model`}
          maxLength={MAX_MODEL_NAME_LENGTH}
          onChange={(event) =>
            at === null
              ? edit({ model: event.target.value })
              : setGroup(at - 1, { model: event.target.value })
          }
          placeholder={t("settings:editor.modelNameTip")}
          value={at === null ? form.model : form.groups[at - 1].model}
        />
      </label>
    );
  };

  const keyField = (
    <>
      <label className="dialog-field">
        <span>{t("settings:editor.apiKey")}</span>
        <input
          aria-label={t("settings:editor.apiKey")}
          onChange={(event) => edit({ apiKey: event.target.value })}
          placeholder={
            model?.apiKey.set
              ? t("settings:editor.keyStoredTip", {
                  masked: model.apiKey.masked ?? t("settings:keyFallback"),
                })
              : copySource?.apiKey.set
                ? t("settings:editor.keyCopiedTip", {
                    name: copySource.displayName,
                  })
                : "sk-…"
          }
          type="password"
          value={form.apiKey}
        />
      </label>
      {model !== null && model.apiKey.set && (
        <div className="settings-row">
          <button disabled={saving} onClick={clearKey} type="button">
            {t("settings:editor.clearKey")}
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="settings-section">
      <h3 className="settings-heading">
        {model !== null
          ? // The category went out of the form as a field of its own; the
            // heading is where an editor says which kind of model this is,
            // because the protocol choices below follow from it.
            t("settings:editor.headingEdit", {
              name: model.displayName,
              category: t(CAPABILITY_LABELS[category]).toLowerCase(),
            })
          : copySource !== null
            ? t("settings:editor.headingCopy", {
                name: copySource.displayName,
                category: t(CAPABILITY_LABELS[category]).toLowerCase(),
              })
            : t("settings:editor.headingNew", {
                category: t(CAPABILITY_LABELS[category]).toLowerCase(),
              })}
      </h3>

      <label className="dialog-field">
        <span>{t("settings:editor.displayName")}</span>
        <input
          aria-label={t("settings:editor.displayName")}
          autoFocus
          maxLength={MAX_MODEL_NAME_LENGTH}
          onChange={(event) => edit({ displayName: event.target.value })}
          placeholder={t("settings:editor.displayNameTip")}
          value={form.displayName}
        />
      </label>

      <details
        className="settings-group"
        data-testid="model-group-0"
        onToggle={(event) => edit({ open: event.currentTarget.open })}
        open={form.open}
      >
        <summary>
          {routed ? groupTitle(form.scenes) : t("settings:editor.groupConfig")}
        </summary>
        <div className="settings-group-body">
          {routed && sceneRow(0, form.scenes)}

          {protocolField}

          <label className="dialog-field">
            <span>{t("settings:editor.url")}</span>
            <input
              aria-label={t("settings:editor.urlAria")}
              onChange={(event) => edit({ url: event.target.value })}
              placeholder={protocolUrlExample(protocols, form.protocol)}
              value={form.url}
            />
          </label>
          <p className="settings-hint">
            {urlShaped
              ? t("settings:editor.urlHint")
              : `${t("settings:editor.urlHint")} ${t("settings:editor.urlHintScheme")}`}
          </p>

          {modelField(null)}

          {category === "video" && (
            <>
              <label className="dialog-field">
                <span>{t("settings:editor.maxVideoSeconds")}</span>
                <input
                  aria-label={t("settings:editor.maxVideoSeconds")}
                  max={MAX_VIDEO_SECONDS}
                  min={1}
                  onChange={(event) =>
                    edit({ maxVideoSeconds: event.target.value })
                  }
                  placeholder="—"
                  step={1}
                  type="number"
                  value={form.maxVideoSeconds}
                />
              </label>
              <p className="settings-hint">
                {ceilingOk
                  ? t("settings:editor.maxVideoSecondsHint")
                  : t("settings:editor.maxVideoSecondsRange", {
                      max: MAX_VIDEO_SECONDS,
                    })}
              </p>
            </>
          )}

          {keyField}
        </div>
      </details>

      {form.groups.map((group, at) => {
        const ordinal = at + 1;
        const problem = groupProblem(group);
        return (
          <details
            className="settings-group"
            data-testid={`model-group-${ordinal}`}
            key={ordinal}
            onToggle={(event) =>
              setGroup(at, { open: event.currentTarget.open })
            }
            open={group.open}
          >
            <summary>{groupTitle(group.scenes)}</summary>
            <div className="settings-group-body">
              {sceneRow(ordinal, group.scenes)}
              {modelField(ordinal)}
              <label className="dialog-field">
                <span>{t("settings:editor.url")}</span>
                <input
                  aria-label={`${t("settings:editor.urlAria")} ${ordinal + 1}`}
                  data-testid={`model-group-${ordinal}-url`}
                  onChange={(event) =>
                    setGroup(at, { url: event.target.value })
                  }
                  placeholder={
                    form.url.trim() === ""
                      ? t("settings:editor.groupUrlTip")
                      : form.url.trim()
                  }
                  value={group.url}
                />
              </label>
              <p className="settings-hint">
                {t("settings:editor.groupInherits")}
              </p>
              {problem !== null && (
                <p className="settings-hint" role="alert">
                  {t(problem)}
                </p>
              )}
              <div className="settings-row">
                <button
                  aria-label={`${t("settings:editor.groupRemove")} ${ordinal + 1}`}
                  data-testid={`model-group-${ordinal}-remove`}
                  onClick={() =>
                    edit({
                      groups: form.groups.filter(
                        (_group, index) => index !== at,
                      ),
                    })
                  }
                  type="button"
                >
                  {t("settings:editor.groupRemove")}
                </button>
              </div>
            </div>
          </details>
        );
      })}

      {routed && uncovered.length > 0 && (
        <div className="settings-row">
          <button
            data-testid="model-group-add"
            onClick={() =>
              edit({
                groups: [
                  ...form.groups,
                  { model: "", url: "", scenes: [], open: true },
                ],
              })
            }
            type="button"
          >
            {t("settings:editor.groupAdd")}
          </button>
        </div>
      )}
      {routed && uncovered.length > 0 && (
        <p
          className="settings-hint"
          role="status"
          data-testid="model-uncovered"
        >
          {t("settings:editor.groupUncovered")}{" "}
          {uncovered.map((scene) => t(MODEL_SCENE_LABELS[scene])).join(" / ")}
        </p>
      )}
      {claimedEmpty && (
        <p className="settings-hint" role="alert" data-testid="model-unclaimed">
          {t("settings:editor.groupNeedsOne")}
        </p>
      )}

      <label className="settings-check">
        <input
          aria-label={t("settings:editor.enabled")}
          checked={form.enabled}
          onChange={(event) => edit({ enabled: event.target.checked })}
          type="checkbox"
        />
        <span>{t("settings:editor.enabled")}</span>
      </label>

      {clash && (
        <p className="settings-hint" role="alert" data-testid="model-id-clash">
          {t("settings:editor.identifierClash")}
        </p>
      )}

      <div className="dialog-actions">
        <button
          className="primary"
          disabled={!canSave}
          onClick={() => void save()}
          type="button"
        >
          {saving ? t("settings:saving") : t("settings:editor.save")}
        </button>
        <button disabled={saving} onClick={onDone} type="button">
          {t("settings:cancel")}
        </button>
      </div>
    </div>
  );
}
