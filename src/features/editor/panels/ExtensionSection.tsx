import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  AssetId,
  CanvasDocument,
  ExtensionCallRecord,
  ExtensionDefinition,
  ExtensionParameter,
  ExtensionState,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import { ModelPicker } from "../../settings/ModelPicker";
import {
  refreshExtensionNode,
  setExtensionBinding,
  setExtensionParameter,
} from "../interactions/actions";
import { useExtensionStore } from "../stores/extensionStore";
import { useProjectStore } from "../stores/projectStore";
import { useLatestRunForNode, useNodeExtensionLogs } from "../stores/runStore";
import { Row } from "./AssetFacts";

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
  if (parameter.type === "boolean") {
    return (
      <label className="dialog-field dialog-field-check">
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
      <label className="dialog-field">
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
      <label className="dialog-field">
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
    <label className="dialog-field">
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

function Outputs({
  definition,
  state,
  resources,
}: {
  definition: ExtensionDefinition;
  state: ExtensionState;
  resources: ReadonlyMap<AssetId, ResourceEntry>;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language || "en").split("-")[0];
  return (
    <>
      <h3>{t("editor:extension.outputs")}</h3>
      {definition.outputs.map((port) => {
        const values = state.outputs?.[port.id] ?? [];
        const name = labelOf(port.labels, port.label, locale);
        return (
          <div className="extension-output" key={port.id}>
            <span className="extension-output-name">
              {name}
              {port.primary ? " ★" : ""}
            </span>
            {values.length === 0 ? (
              <span className="inspector-empty">
                {t("editor:extension.noValues")}
              </span>
            ) : (
              <ul>
                {values.map((value, index) => (
                  <li key={index}>
                    {value.type === "text"
                      ? value.text?.slice(0, 280) ||
                        t("editor:extension.emptyText")
                      : (resources.get(value.assetId ?? "")?.name ??
                        value.assetId ??
                        t("editor:extension.missingAsset"))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The installed definition a node was made from, and everything the reader
 * configures on that node.
 *
 * The panel is generated from the definition rather than from a form written
 * per extension: slots become model pickers, declared parameters become fields,
 * and outputs are read from the node's last successful answer. When the
 * definition is gone or its contract has changed, the panel says so and offers
 * the repair rather than pretending the node is ready to run.
 */
export function ExtensionSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t, i18n } = useTranslation();
  const load = useExtensionStore((state) => state.load);
  const catalog = useExtensionStore((state) => state.catalog);
  const state = (node.data as { extension?: ExtensionState }).extension;
  const moka = useProjectStore((store) => store.moka);
  const resources = useMemo(() => {
    const index = new Map<AssetId, ResourceEntry>();
    for (const entry of Object.values(moka?.resources ?? {}).flat()) {
      index.set(entry.id, entry);
    }
    return index;
  }, [moka]);
  const logs = useNodeExtensionLogs(node.id);
  const run = useLatestRunForNode(node.id);
  const step = run?.steps.find((entry) => entry.nodeId === node.id);
  const calls = step?.extensionCalls ?? NO_CALLS;

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;
  const locale = (i18n.language || "en").split("-")[0];
  const definition = catalog?.nodes.find(
    (candidate) => candidate.id === state.extensionId,
  );
  const status = !catalog
    ? "loading"
    : !definition
      ? "missing"
      : definition.apiVersion !== state.apiVersion
        ? "version"
        : definition.contractHash !== state.contractHash
          ? "changed"
          : "ready";
  const title = definition
    ? labelOf(definition.labels, definition.displayName, locale)
    : state.extensionId;

  return (
    <section className="inspector-section">
      <h3>{t("editor:extension.title")}</h3>
      <Row label={t("editor:extension.definition")} value={title} />
      <Row
        label={t("editor:extension.statusLabel")}
        value={t(`editor:extension.state.${status}`)}
      />
      {status === "loading" && (
        <p className="inspector-empty">{t("editor:extension.loading")}</p>
      )}
      {status === "missing" && (
        <p className="inspector-note">
          {t("editor:extension.missingNote", { id: state.extensionId })}
        </p>
      )}
      {(status === "changed" || status === "version") && (
        <>
          <p className="inspector-note">{t("editor:extension.changedNote")}</p>
          {definition && (
            <div className="inspector-actions">
              <button
                onClick={() =>
                  refreshExtensionNode(canvas.id, node.id, definition)
                }
                type="button"
              >
                {t("editor:extension.refresh")}
              </button>
            </div>
          )}
        </>
      )}

      {definition && (
        <>
          <h3>{t("editor:extension.models")}</h3>
          {definition.models.length === 0 && (
            <p className="inspector-empty">{t("editor:extension.noModels")}</p>
          )}
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
                setExtensionBinding(canvas.id, node.id, slot.id, model)
              }
              value={state.bindings[slot.id] ?? null}
            />
          ))}
          {definition.parameters.length > 0 && (
            <>
              <h3>{t("editor:extension.parameters")}</h3>
              {definition.parameters.map((parameter) => (
                <ParameterField
                  key={parameter.key}
                  onChange={(value) =>
                    setExtensionParameter(
                      canvas.id,
                      node.id,
                      parameter.key,
                      value,
                    )
                  }
                  parameter={parameter}
                  value={
                    (node.data as { parameters?: Record<string, unknown> })
                      .parameters?.[parameter.key]
                  }
                />
              ))}
            </>
          )}
          <Outputs
            definition={definition}
            resources={resources}
            state={state}
          />
          {logs.length > 0 && (
            <details className="inspector-section" open>
              <summary>{t("editor:extension.logs")}</summary>
              <pre className="inspector-json extension-logs">
                {logs
                  .map((line) => `[${line.level}] ${line.message}`)
                  .join("\n")}
              </pre>
            </details>
          )}
          {calls.length > 0 && (
            <details className="inspector-section">
              <summary>{t("editor:extension.calls")}</summary>
              <ul className="extension-calls">
                {calls.map((call, index) => (
                  <li key={index}>
                    <strong>{call.slot}</strong> · {call.model} ·{" "}
                    {Math.round(call.durationMs)} ms ·{" "}
                    {call.failed
                      ? t("editor:extension.callFailed", {
                          error: call.error ?? "",
                        })
                      : t("editor:extension.callProduced", {
                          count: call.produced,
                        })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

const NO_CALLS: ExtensionCallRecord[] = [];
