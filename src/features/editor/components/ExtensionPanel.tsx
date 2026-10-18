import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../../../api/client";
import {
  findNode,
  type ExtensionDefinition,
  type ExtensionParameter,
  type ExtensionState,
  type NodeId,
  type WorkflowNode,
} from "../../../shared/domain";
import { ModelPicker } from "../../settings/ModelPicker";
import { worldToClient } from "../canvas/canvasControl";
import { useActiveCanvas } from "../stores/projectStore";
import {
  refreshExtensionNode,
  setExtensionBinding,
  setExtensionParameter,
} from "../interactions/actions";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useExtensionStore } from "../stores/extensionStore";
import {
  isActive,
  useLatestRunForNode,
  useNodeRunError,
  useNodeRunStatus,
  useRunStore,
} from "../stores/runStore";

/** The narrowest and widest the panel gets from the size of its node. */
const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 720;
/** How much wider than its node the panel comes up, so fields have room. */
const PANEL_WIDTH_FACTOR = 1.3;
/** How tall the panel comes up before the reader drags its corner. */
const PANEL_DEFAULT_HEIGHT = 380;
/** The shortest the panel may be dragged to and still be a panel. */
const PANEL_MIN_HEIGHT = 140;

function labelOf(
  labels: Record<string, string>,
  fallback: string,
  locale: string,
): string {
  const chosen = labels[locale];
  return chosen && chosen.trim() ? chosen : fallback;
}

function ParameterField({
  parameter,
  value,
  onChange,
}: {
  parameter: ExtensionParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language || "en").split("-")[0];
  const label = labelOf(parameter.labels, parameter.label, locale);
  const name = parameter.required ? `${label} *` : label;
  const wide = parameter.type === "string" && Boolean(parameter.multiline);
  const className = wide ? "dialog-field prompt-panel-wide" : "dialog-field";
  if (parameter.type === "boolean") {
    return (
      <label className={`${className} dialog-field-check`}>
        <input
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>{name}</span>
        {parameter.description && <small>{parameter.description}</small>}
      </label>
    );
  }
  if (parameter.type === "enum") {
    return (
      <label className={className}>
        <span>{name}</span>
        <select
          onChange={(event) => onChange(event.target.value)}
          value={typeof value === "string" ? value : ""}
        >
          <option disabled value="">
            {t("editor:extension.chooseOption")}
          </option>
          {parameter.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {parameter.description && <small>{parameter.description}</small>}
      </label>
    );
  }
  if (parameter.type === "number" || parameter.type === "integer") {
    return (
      <label className={className}>
        <span>{name}</span>
        <input
          max={parameter.max}
          min={parameter.min}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            )
          }
          step={parameter.step ?? (parameter.type === "integer" ? 1 : "any")}
          type="number"
          value={typeof value === "number" ? value : ""}
        />
        {parameter.description && <small>{parameter.description}</small>}
      </label>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <label className={className}>
      <span>{name}</span>
      {parameter.multiline ? (
        <textarea
          maxLength={parameter.maxLength}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          value={text}
        />
      ) : (
        <input
          maxLength={parameter.maxLength}
          onChange={(event) => onChange(event.target.value)}
          type="text"
          value={text}
        />
      )}
      {parameter.description && <small>{parameter.description}</small>}
    </label>
  );
}

/**
 * What an extension node is set up with, under the node that will run it.
 *
 * A DOM panel under the node rather than part of its card, for the reason the
 * generation panel is one: a card drawn on a canvas has no room for a form. It
 * is generated from the installed definition — slots become model pickers and
 * declared parameters become fields — and the run control sits in its head,
 * where the same control sits on a generation panel.
 *
 * The panel follows its node in world coordinates and reaches past it by the
 * same distance on both sides, so the card stands centred in the panel it is
 * configured from. It is deliberately not kept inside the view: a node dragged
 * to the edge of the canvas takes the panel with it.
 */
export function ExtensionPanel() {
  const { t, i18n } = useTranslation();
  const open = useEditorStore((state) => state.extensionPanel);
  const selected = useEditorStore((state) => state.selection.nodeIds);
  const camera = useEditorStore((state) => state.camera);
  const canvas = useActiveCanvas();
  const load = useExtensionStore((state) => state.load);
  const catalog = useExtensionStore((state) => state.catalog);
  const run = useLatestRunForNode(open?.nodeId ?? null);
  const stepStatus = useNodeRunStatus(open?.nodeId ?? null);
  const failure = useNodeRunError(open?.nodeId ?? null);
  const issues = useRunStore((state) => state.lastIssues);
  const areaRef = useRef<HTMLDivElement>(null);
  const shownFor = useRef<NodeId | null>(null);
  const [busy, setBusy] = useState(false);
  /** The size the reader dragged the panel to, or null for its node's own. */
  const [size, setSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  /** Sizes taken by hand, kept per node for as long as the editor is open. */
  const sizesFor = useRef(new Map<NodeId, { width: number; height: number }>());
  const panelRef = useRef<HTMLDivElement>(null);
  const sizedFor = useRef<NodeId | null>(null);

  const node = open && canvas ? findNode(canvas, open.nodeId) : null;
  if (node && sizedFor.current !== node.id) {
    sizedFor.current = node.id;
    setSize(sizesFor.current.get(node.id) ?? null);
  }

  const chosen =
    selected.length === 1 && canvas ? findNode(canvas, selected[0]) : undefined;
  const chosenId = chosen?.kind === "extension" ? chosen.id : null;

  useEffect(() => {
    if (shownFor.current === chosenId) return;
    shownFor.current = chosenId;
    const shown = useEditorStore.getState().extensionPanel;
    if (chosenId && shown?.nodeId !== chosenId) {
      useEditorStore.getState().openExtensionPanel(chosenId);
    }
  }, [chosenId]);

  useEffect(() => {
    const current = useEditorStore.getState().extensionPanel;
    if (current && !selected.includes(current.nodeId)) {
      useEditorStore.getState().closeExtensionPanel();
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = (node?.data as { extension?: ExtensionState } | undefined)
    ?.extension;
  const locale = (i18n.language || "en").split("-")[0];
  const definition = state
    ? catalog?.nodes.find((candidate) => candidate.id === state.extensionId)
    : undefined;
  const status = !state
    ? "missing"
    : !catalog
      ? "loading"
      : !definition
        ? "missing"
        : definition.apiVersion !== state.apiVersion
          ? "version"
          : definition.contractHash !== state.contractHash
            ? "changed"
            : "ready";

  // The keyboard is taken for an entry the user chose. Coming up because a
  // node was selected must not take it, or Delete would stop deleting the node.
  useEffect(() => {
    if (!open?.focus) return;
    requestAnimationFrame(() => {
      const first = areaRef.current?.querySelector<HTMLElement>(
        "select, input, textarea",
      );
      first?.focus();
    });
  }, [open, definition]);

  if (!node || !canvas || !state) return null;

  const name = definition
    ? labelOf(definition.labels, definition.displayName, locale)
    : state.extensionId;
  const going = stepStatus !== null && isActive(stepStatus);
  const stopping = run !== null && going && run.cancelRequested;
  const relevantIssues = issues.filter(
    (issue) => !issue.nodeId || issue.nodeId === node.id,
  );

  const ask = async () => {
    setBusy(true);
    try {
      await useRunStore.getState().start(canvas.id, [node.id]);
    } catch (problem) {
      const trouble = errorText(problem);
      useAppStore
        .getState()
        .pushToast("error", trouble.message, undefined, trouble.detail);
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    if (run) void useRunStore.getState().cancel(run.id);
  };

  const dismiss = () => useEditorStore.getState().closeExtensionPanel();

  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
    };
    const move = (moved: PointerEvent) => {
      const next = {
        width: Math.max(PANEL_MIN_WIDTH, start.width + moved.clientX - start.x),
        height: Math.max(
          PANEL_MIN_HEIGHT,
          start.height + moved.clientY - start.y,
        ),
      };
      setSize(next);
      sizesFor.current.set(node.id, next);
    };
    const letGo = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", letGo);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", letGo);
  };

  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  const nodeWidth = node.bounds.width * zoom;
  const naturalWidth = Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, Math.round(nodeWidth * PANEL_WIDTH_FACTOR)),
  );
  const overhang = Math.max(0, naturalWidth - Math.round(nodeWidth));
  const width = size?.width ?? naturalWidth + overhang;
  const origin = worldToClient({
    x: node.bounds.x,
    y: node.bounds.y + node.bounds.height,
  });
  const style: React.CSSProperties = {
    left: (origin?.x ?? 0) - overhang,
    top: origin?.y ?? 0,
    width,
    height: size?.height ?? PANEL_DEFAULT_HEIGHT,
  };

  const runButton = going ? (
    <button
      className="primary"
      disabled={stopping}
      onClick={stop}
      title={stopping ? t("editor:run.stoppingHint") : t("editor:run.stopHint")}
      type="button"
    >
      {stopping ? t("editor:run.stopping") : t("editor:action.stop")}
    </button>
  ) : (
    <button
      className="primary"
      disabled={busy || status !== "ready"}
      onClick={() => void ask()}
      title={status === "ready" ? undefined : t("editor:extension.notRunnable")}
      type="button"
    >
      {busy ? t("editor:promptPanel.starting") : t("editor:action.run")}
    </button>
  );

  const statusNote =
    status === "loading" ? (
      <p className="prompt-panel-note">{t("editor:extension.loading")}</p>
    ) : status === "missing" ? (
      <p className="prompt-panel-note">
        {t("editor:extension.missingNote", { id: state.extensionId })}
      </p>
    ) : status === "changed" || status === "version" ? (
      <div className="extension-panel-status">
        <p className="prompt-panel-note">{t("editor:extension.changedNote")}</p>
        {definition && (
          <button
            onClick={() => refreshExtensionNode(canvas.id, node.id, definition)}
            type="button"
          >
            {t("editor:extension.refresh")}
          </button>
        )}
      </div>
    ) : null;

  return (
    <div
      aria-label={t("editor:extension.panelAria", { name: node.title })}
      className="prompt-panel extension-panel"
      data-testid="extension-panel"
      ref={panelRef}
      role="group"
      style={style}
    >
      <div className="prompt-panel-head">
        <span className="extension-panel-title" title={name}>
          {name}
        </span>
        {statusNote === null && runButton}
        <button
          aria-label={t("editor:extension.closePanel")}
          className="prompt-panel-close"
          onClick={dismiss}
          type="button"
        >
          ✕
        </button>
      </div>

      <div className="prompt-panel-body extension-panel-body" ref={areaRef}>
        {statusNote}
        {status === "ready" && definition && (
          <ExtensionFields
            canvasId={canvas.id}
            definition={definition}
            node={node}
            state={state}
          />
        )}
        {relevantIssues.length > 0 && (
          <ul className="inspector-issues" role="alert">
            {relevantIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <strong>{issue.code}</strong> {issue.message}
              </li>
            ))}
          </ul>
        )}
        {failure && <p className="prompt-panel-warn">{failure}</p>}
        {going && (
          <p className="prompt-panel-note">{t("editor:extension.running")}</p>
        )}
      </div>

      <div
        aria-hidden="true"
        className="prompt-panel-grip"
        onPointerDown={resize}
        title={t("editor:promptPanel.grip")}
      />
    </div>
  );
}

function ExtensionFields({
  canvasId,
  definition,
  node,
  state,
}: {
  canvasId: string;
  definition: ExtensionDefinition;
  node: WorkflowNode;
  state: ExtensionState;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language || "en").split("-")[0];
  const parameters =
    (node.data as { parameters?: Record<string, unknown> }).parameters ?? {};
  return (
    <>
      {definition.models.length > 0 && (
        <section className="extension-panel-section">
          <h4>{t("editor:extension.models")}</h4>
          <div className="prompt-panel-models">
            {definition.models.map((slot) => (
              <ModelPicker
                capability={slot.capability}
                key={slot.id}
                label={labelOf(slot.labels, slot.label, locale)}
                noneLabel={
                  slot.required
                    ? t("editor:extension.bindRequired")
                    : t("editor:extension.unbound")
                }
                onChange={(model) =>
                  setExtensionBinding(canvasId, node.id, slot.id, model)
                }
                value={state.bindings[slot.id] ?? null}
              />
            ))}
          </div>
        </section>
      )}
      {definition.parameters.length > 0 && (
        <section className="extension-panel-section">
          <h4>{t("editor:extension.parameters")}</h4>
          <div className="prompt-panel-params">
            {definition.parameters.map((parameter) => (
              <ParameterField
                key={parameter.key}
                onChange={(value) =>
                  setExtensionParameter(canvasId, node.id, parameter.key, value)
                }
                parameter={parameter}
                value={parameters[parameter.key]}
              />
            ))}
          </div>
        </section>
      )}
      {definition.models.length === 0 && definition.parameters.length === 0 && (
        <p className="prompt-panel-note">
          {t("editor:extension.noConfiguration")}
        </p>
      )}
    </>
  );
}
