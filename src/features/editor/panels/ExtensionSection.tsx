import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  AssetId,
  CanvasDocument,
  ExtensionCallRecord,
  ExtensionDefinition,
  ExtensionState,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import { refreshExtensionNode } from "../interactions/actions";
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
 * The installed definition a node was made from, and what it last answered.
 *
 * What the reader configures — model slots and declared parameters — lives in
 * the panel under the node, where the same kind of choice lives for every other
 * runnable node. This section keeps the node's other attributes: which
 * definition it was made from, whether that definition still matches, its last
 * outputs, and what its runs logged. When the definition is gone or its contract
 * has changed, the section says so and offers the repair rather than pretending
 * the node is ready to run.
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
