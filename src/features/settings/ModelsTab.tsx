import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ModelView } from "../../api";
import { CAPABILITY_LABELS, type Capability } from "../../shared/domain";
import { ModelEditor } from "./ModelEditor";
import {
  effectiveDefaultId,
  protocolFeatures,
  protocolLabel,
  useModelStore,
} from "./modelStore";
import { SecretStorageNote } from "./SecretStorageNote";

/** What a card needs to take part in arranging its category's list. */
interface CardDrag {
  dragging: boolean;
  over: "before" | "after" | null;
  onStart: (event: DragEvent<HTMLSpanElement>) => void;
  onOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  onEnd: () => void;
}

function ModelCard({
  model,
  category,
  isDefault,
  drag,
}: {
  model: ModelView;
  category: Capability;
  isDefault: boolean;
  drag?: CardDrag;
}) {
  const { t } = useTranslation();
  const saving = useModelStore((state) => state.saving);
  const protocols = useModelStore((state) => state.protocols);
  const lower = t(CAPABILITY_LABELS[category]).toLowerCase();

  const remove = () => {
    if (
      !window.confirm(
        t("settings:card.deleteConfirm", { name: model.displayName }),
      )
    ) {
      return;
    }
    void useModelStore.getState().removeModel(model.id);
  };

  const side = drag?.over ?? "";
  return (
    <li
      className={`model-card${model.enabled ? "" : " is-off"}${drag?.dragging ? " is-dragging" : ""}${side === "" ? "" : ` is-over-${side}`}`}
      onDragEnd={drag?.onEnd}
      onDragOver={drag?.onOver}
      onDrop={drag?.onDrop}
    >
      <div className="model-card-head">
        {drag && (
          <span
            aria-hidden="true"
            className="model-card-handle"
            draggable
            onDragStart={drag.onStart}
            title={t("settings:card.reorderHandle")}
          >
            ⠿
          </span>
        )}
        <strong>{model.displayName}</strong>
        <span className="model-card-tag">
          {protocolLabel(protocols, model.protocol)}
        </span>
        {!model.enabled && (
          <span className="model-card-tag">{t("settings:card.off")}</span>
        )}
        <label className="settings-check">
          <input
            aria-label={t("settings:card.useAsDefault", {
              name: model.displayName,
              category: lower,
            })}
            checked={isDefault}
            disabled={saving}
            onChange={(event) =>
              void useModelStore
                .getState()
                .setDefault(category, event.target.checked ? model.id : null)
            }
            type="radio"
            name={`default-${category}`}
          />
          <span>{t("settings:card.default")}</span>
        </label>
      </div>
      <p className="model-card-detail">
        {model.model} · <code>{model.url}</code>
      </p>
      <p className="model-card-detail">
        {model.apiKey.set
          ? t("settings:card.key", {
              masked: model.apiKey.masked ?? t("settings:card.stored"),
            })
          : t("settings:card.noKey")}
      </p>
      <div className="settings-row">
        <button
          disabled={saving}
          onClick={() => useModelStore.getState().editModel(model.id)}
          type="button"
        >
          {t("settings:edit")}
        </button>
        <button
          aria-label={t("settings:card.copy", { name: model.displayName })}
          disabled={saving}
          onClick={() => useModelStore.getState().duplicateModel(model.id)}
          title={t("settings:card.copyTip")}
          type="button"
        >
          {t("settings:duplicate")}
        </button>
        <button
          className="danger"
          disabled={saving}
          onClick={remove}
          type="button"
        >
          {t("settings:delete")}
        </button>
      </div>
    </li>
  );
}

/**
 * A category's models in the order they are offered.
 *
 * The stored order is the order every picker shows, so arranging the list
 * here is arranging it everywhere. A card is a form and a form is not a thing
 * to drag, which is why only the handle starts a move.
 */
function ModelOrderList({
  models,
  category,
  defaultId,
}: {
  models: ModelView[];
  category: Capability;
  defaultId: string | null;
}) {
  const { t } = useTranslation();
  const saving = useModelStore((state) => state.saving);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const finish = () => {
    setDragging(null);
    setOver(null);
  };

  /** Whether the pointer is past the middle of the card it is over. */
  const dropsAfter = (event: DragEvent<HTMLLIElement>): boolean => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };

  const move = (id: string, targetId: string, after: boolean) => {
    const ids = models.map((model) => model.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    if (to < 0) return;
    ids.splice(after ? to + 1 : to, 0, id);
    void useModelStore.getState().reorderModels(category, ids);
  };

  return (
    <ul aria-label={t("settings:card.reorderList")} className="model-card-list">
      {models.map((model) => (
        <ModelCard
          category={category}
          drag={{
            dragging: dragging === model.id,
            over:
              over?.id === model.id ? (over.after ? "after" : "before") : null,
            onStart: (event) => {
              if (saving) {
                event.preventDefault();
                return;
              }
              setDragging(model.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", model.id);
            },
            onOver: (event) => {
              if (dragging === null || dragging === model.id) return;
              event.preventDefault();
              setOver({ id: model.id, after: dropsAfter(event) });
            },
            onDrop: (event) => {
              event.preventDefault();
              if (!saving && dragging !== null && dragging !== model.id) {
                move(dragging, model.id, dropsAfter(event));
              }
              finish();
            },
            onEnd: finish,
          }}
          isDefault={model.id === defaultId}
          key={model.id}
          model={model}
        />
      ))}
    </ul>
  );
}

/**
 * One category's models: what serves this kind of node, which of them is the
 * default, and the way to add, copy, or remove one.
 *
 * The default lives here rather than on a page of its own: it is a property of
 * the list beside it, and a picker far from the models it picks is how a
 * default ends up pointing at something nobody remembers choosing.
 */
export function ModelsTab({ category }: { category: Capability }) {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const editing = useModelStore((state) => state.editing);
  const copyOf = useModelStore((state) => state.copyOf);
  const protocols = useModelStore((state) => state.protocols);
  const lower = t(CAPABILITY_LABELS[category]).toLowerCase();

  if (editing !== null) {
    const model =
      editing === "new"
        ? null
        : (view?.models.find((entry) => entry.id === editing) ?? null);
    // A model deleted since the editor opened is not one to keep a form on.
    if (editing === "new" || model !== null) {
      const copySource =
        editing === "new" && copyOf !== null
          ? (view?.models.find((entry) => entry.id === copyOf) ?? null)
          : null;
      return (
        <ModelEditor
          category={model?.category ?? category}
          model={model}
          copySource={copySource}
          onDone={() => useModelStore.getState().closeEditor()}
        />
      );
    }
  }

  const models = (view?.models ?? []).filter(
    (model) => model.category === category,
  );
  // The default nobody had to pick: the stored choice when it still serves,
  // and the first enabled model otherwise — the same fallback the server
  // resolves a generation through.
  const defaultId = effectiveDefaultId(view, category);
  // The model an ask falls back to, and the one gap only it can have: a speech
  // model is asked for a voice, so a machine that has set none is a machine
  // whose read-aloud asks come back refused. Which converters need one is the
  // converter's own declaration, not a list this program keeps.
  const fallback = models.find((model) => model.id === defaultId);
  const voiceGap =
    category === "speech" &&
    fallback !== undefined &&
    protocolFeatures(protocols, fallback.protocol).needsVoice === true &&
    (view?.preferences.speech.voice ?? "").trim() === "";

  return (
    <div className="settings-section">
      <div className="settings-row">
        <button
          className="primary"
          disabled={saving}
          onClick={() => useModelStore.getState().newModel(category)}
          type="button"
        >
          {t("settings:models.new", { category: lower })}
        </button>
      </div>

      {models.length === 0 ? (
        <p className="settings-hint" data-testid={`${category}-empty`}>
          {t("settings:models.empty", { category: lower })}
        </p>
      ) : (
        <>
          <ModelOrderList
            category={category}
            defaultId={defaultId}
            models={models}
          />
          {defaultId === null && (
            <p className="settings-hint" data-testid={`${category}-gap`}>
              {t("settings:models.gap", { category: lower })}
            </p>
          )}
          {voiceGap && (
            <p className="settings-hint" data-testid="speech-voice-gap">
              {t("settings:models.voiceGap")}
            </p>
          )}
        </>
      )}

      {view && <SecretStorageNote tier={view.secretStorage} />}
    </div>
  );
}
