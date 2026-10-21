import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AssetCategory,
  AssetId,
  BackgroundMode,
  CanvasDocument,
  DataType,
  ExtensionState,
  GenerationSpec,
  MokaFile,
  NodeKind,
  PortDefinition,
  ResourceEntry,
  ResultSlot,
  WorkflowEdge,
  WorkflowNode,
} from "../../../shared/domain";
import {
  BACKGROUND_MODES,
  CAPABILITY_LABELS,
  PROVIDER_EXECUTOR_KEY,
  activeShotOf,
  assetHolders,
  createDirectorScene,
  directorSceneOf,
  executorKeyForNode,
  generationSpecFromSnapshot,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { i18n } from "../../../shared/i18n";
import { execute } from "../commands/execute";
import { openDirector } from "../../director/stores/directorStore";
import { errorText } from "../../../api/client";
import {
  generationUnavailable,
  useAppStore,
  useGenerationAvailable,
} from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useExtensionStore } from "../stores/extensionStore";
import { useActiveCanvas, useProjectStore } from "../stores/projectStore";
import {
  RUN_STATUS_LABEL,
  isActive,
  retryRun,
  useLatestRunForNode,
  useNodeGenerationAssets,
  useNodeRunError,
  useNodeRunProgress,
  useNodeRuns,
  useNodeStreamText,
  useRunStore,
} from "../stores/runStore";
import {
  buildIssueIndex,
  buildResourceIndex,
  mediaInfoForNode,
} from "../canvas/mediaCards";
import { CANVAS_THEME_LABELS, CANVAS_THEME_NAMES } from "../canvas/theme";
import { useAppearance } from "../stores/appearance";
import {
  chooseResult,
  choosableResults,
  deleteSelection,
  disconnectEdge,
  fileNodeAsAsset,
  filingPossible,
  focusAssetUses,
  linkAsset,
  markAssetKeeper,
  renameNode,
  requestDeleteAsset,
  revealAsset,
  setCanvasViewSettings,
  setNodeGeneration,
} from "../interactions/actions";
import { canvasNodesUsing } from "./canvasAssets";
import { ExtensionSection } from "./ExtensionSection";
import {
  AssetFileSection,
  AssetNoteSection,
  AssetPreviewSection,
  AssetProvenanceSection,
  AssetRows,
  ProvenanceRows,
  Row,
} from "./AssetFacts";

function TitleField({ node }: { node: WorkflowNode }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(node.title);
  useEffect(() => setValue(node.title), [node.id, node.title]);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== node.title) {
      renameNode(node.id, trimmed);
    } else {
      setValue(node.title);
    }
  };
  return (
    <input
      aria-label={t("editor:inspector.nodeTitle")}
      className="inspector-title-input"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") setValue(node.title);
      }}
      value={value}
    />
  );
}

/** Where the assets a node of each kind holds are filed in a project. */
const FILED_UNDER: Partial<Record<NodeKind, readonly AssetCategory[]>> = {
  image: ["images"],
  audio: ["music", "voice"],
  video: ["videos"],
};

/**
 * The project's own assets that could fill this node.
 *
 * Linking one is the other way to fill a node that is waiting: nothing is asked
 * for, so nothing is spent on a provider to get it.
 */
function linkable(moka: MokaFile | null, kind: NodeKind): ResourceEntry[] {
  const filed = FILED_UNDER[kind];
  if (!moka || !filed) return [];
  return filed.flatMap((category) => moka.resources[category] ?? []);
}

/** Preview + metadata + provenance + file actions for a media node's asset. */
function MediaAssetSection({ node }: { node: WorkflowNode }) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const openPreview = useEditorStore((state) => state.openPreview);
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map<AssetId, ResourceEntry>()),
    [moka],
  );
  const media = useMemo(() => {
    if (!moka) return null;
    return mediaInfoForNode(node, resources, buildIssueIndex(selfCheck));
  }, [moka, resources, selfCheck, node]);

  if (node.kind !== "image" && node.kind !== "audio" && node.kind !== "video") {
    return null;
  }
  const data = node.data as { assetId?: AssetId };
  if (!data.assetId) {
    const offers = linkable(moka, node.kind);
    return (
      <section className="inspector-section">
        <h3>{t("editor:inspector.asset")}</h3>
        <p className="inspector-empty">{t("editor:inspector.noAssetLinked")}</p>
        {offers.length > 0 && (
          <select
            aria-label={t("editor:inspector.linkAssetTo", { name: node.title })}
            onChange={(event) => {
              if (event.target.value) linkAsset(node.id, event.target.value);
            }}
            value=""
          >
            <option value="">{t("editor:inspector.linkAsset")}</option>
            {offers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
      </section>
    );
  }
  const entry = media?.entry;
  const broken = media && media.state !== "ready";

  return (
    <section className="inspector-section">
      <h3>{t("editor:inspector.asset")}</h3>
      {broken && (
        <p className="inspector-media-broken" role="alert">
          {t("editor:inspector.assetBroken", {
            state: t(
              media.state === "missing"
                ? "editor:inspector.mediaStateMissing"
                : media.state === "changed"
                  ? "editor:inspector.mediaStateChanged"
                  : "editor:inspector.mediaStateEmpty",
            ),
          })}
          {media.state === "changed"
            ? t("editor:inspector.contentsChangedOnDisk")
            : ""}
        </p>
      )}
      {media?.state === "ready" && entry && (
        <>
          {node.kind === "image" && media.url && (
            <button
              aria-label={t("editor:inspector.openFullPreview")}
              className="inspector-preview"
              onClick={() => openPreview(entry.id)}
              type="button"
            >
              <img alt={entry.name} src={media.url} />
            </button>
          )}
          {node.kind === "audio" && media.url && (
            <audio controls preload="metadata" src={media.url} />
          )}
          {node.kind === "video" && media.playable && (
            <video controls preload="metadata" src={media.playable} />
          )}
        </>
      )}
      {entry && <AssetRows entry={entry} />}
      {entry?.provenance && (
        <ProvenanceRows entry={entry} resources={resources} />
      )}
      {media?.state === "ready" && entry && (
        <div className="inspector-actions">
          <button onClick={() => void revealAsset(entry.id)} type="button">
            {t("editor:action.reveal")}
          </button>
          <a download={entry.name} href={assetUrl(entry.id)}>
            {t("editor:action.download")}
          </a>
          <button
            className="danger"
            onClick={() => void requestDeleteAsset(entry.id)}
            type="button"
          >
            {t("editor:action.remove")}
          </button>
        </div>
      )}
    </section>
  );
}

const DATA_TYPE_LABELS: Record<DataType, string> = {
  text: "editor:inspector.dataType.text",
  image: "editor:inspector.dataType.image",
  audio: "editor:inspector.dataType.audio",
  video: "editor:inspector.dataType.video",
  timeline: "editor:inspector.dataType.timeline",
  artifact: "editor:inspector.dataType.artifact",
};

/**
 * What a port is for. Keyed by the port id, which means the same thing on
 * every kind that offers it, with the few kinds whose ids serve a different
 * purpose stated separately below.
 */
const PORT_ROLE_KEYS: Record<string, string> = {
  prompt: "editor:inspector.portRole.prompt",
  images: "editor:inspector.portRole.images",
  mask: "editor:inspector.portRole.mask",
  audio: "editor:inspector.portRole.audio",
  video: "editor:inspector.portRole.video",
  videos: "editor:inspector.portRole.videos",
  audios: "editor:inspector.portRole.audios",
  firstFrame: "editor:inspector.portRole.firstFrame",
  lastFrame: "editor:inspector.portRole.lastFrame",
  text: "editor:inspector.portRole.text",
  out: "editor:inspector.portRole.out",
  plates: "editor:inspector.portRole.plates",
  frame: "editor:inspector.portRole.frame",
  blocking: "editor:inspector.portRole.blocking",
  direction: "editor:inspector.portRole.direction",
};

const KIND_PORT_ROLE_KEYS: Partial<Record<NodeKind, Record<string, string>>> = {
  export: {
    video: "editor:inspector.portRole.exportVideo",
    audio: "editor:inspector.portRole.exportAudio",
    out: "editor:inspector.portRole.exportOut",
  },
};

/**
 * The role of every port on the node, ready to read.
 *
 * An extension brings descriptions with its definition, and they win over
 * whatever its port ids happen to share with the built-in table: only the
 * definition knows what its own ports are for.
 */
function usePortRoles(node: WorkflowNode): ReadonlyMap<string, string> {
  const { t, i18n } = useTranslation();
  const catalog = useExtensionStore((state) => state.catalog);
  return useMemo(() => {
    const roles = new Map<string, string>();
    for (const [id, key] of Object.entries(PORT_ROLE_KEYS)) {
      roles.set(id, t(key));
    }
    for (const [id, key] of Object.entries(
      KIND_PORT_ROLE_KEYS[node.kind] ?? {},
    )) {
      roles.set(id, t(key));
    }
    if (node.kind === "extension") {
      const state = (node.data as { extension?: ExtensionState }).extension;
      const definition = state
        ? catalog?.nodes.find((entry) => entry.id === state.extensionId)
        : undefined;
      if (definition) {
        const locale = (i18n.language || "en").split("-")[0];
        for (const port of [...definition.inputs, ...definition.outputs]) {
          const described =
            port.descriptionLabels[locale]?.trim() || port.description?.trim();
          if (described) roles.set(port.id, described);
        }
      }
    }
    return roles;
  }, [catalog, i18n.language, node, t]);
}

function PortTypes({ port }: { port: PortDefinition }) {
  const { t } = useTranslation();
  return (
    <span className="inspector-port-types">
      {port.dataTypes.map((type) => (
        <span className="inspector-port-type" key={type}>
          {t(DATA_TYPE_LABELS[type])}
        </span>
      ))}
      {port.cardinality === "many" && (
        <span className="inspector-port-type is-many">
          {t("editor:inspector.portMany")}
        </span>
      )}
    </span>
  );
}

function InputPort({
  canvas,
  node,
  port,
  role,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
  port: PortDefinition;
  role?: string;
}) {
  const { t } = useTranslation();
  const inputPick = useEditorStore((state) => state.inputPick);
  const incoming = canvas.edges.filter(
    (edge) => edge.target.nodeId === node.id && edge.target.portId === port.id,
  );
  const picking =
    inputPick?.nodeId === node.id && inputPick?.portId === port.id;
  return (
    <div className="inspector-port">
      <div className="inspector-port-head">
        <span className="inspector-port-name">
          {port.label}
          {port.required && (
            <span
              className="inspector-port-required"
              title={t("editor:inspector.portRequired")}
            >
              *
            </span>
          )}
        </span>
        <PortTypes port={port} />
        <button
          aria-pressed={picking}
          className={picking ? "is-active" : ""}
          onClick={() => {
            const store = useEditorStore.getState();
            if (picking) store.stopInputPick();
            else store.startInputPick({ nodeId: node.id, portId: port.id });
          }}
          type="button"
        >
          {picking ? t("editor:action.cancelPick") : t("editor:action.replace")}
        </button>
      </div>
      {role && <p className="inspector-port-role">{role}</p>}
      {picking && (
        <p className="inspector-pick-hint">
          {t("editor:inspector.clickCompatible")}
        </p>
      )}
      {incoming.length === 0 ? (
        <p className="inspector-empty">{t("editor:inspector.notConnected")}</p>
      ) : (
        <ul className="inspector-chip-list">
          {incoming.map((edge) => (
            <InputChip canvas={canvas} edge={edge} key={edge.id} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OutputPort({ port, role }: { port: PortDefinition; role?: string }) {
  return (
    <div className="inspector-port">
      <div className="inspector-port-head">
        <span className="inspector-port-name">{port.label}</span>
        <PortTypes port={port} />
      </div>
      {role && <p className="inspector-port-role">{role}</p>}
    </div>
  );
}

/** Every port on the node: what it takes, what it gives, and what each is for. */
function PortsSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t } = useTranslation();
  const roles = usePortRoles(node);
  const inputs = node.ports.filter((port) => port.direction === "input");
  const outputs = node.ports.filter((port) => port.direction === "output");
  if (inputs.length === 0 && outputs.length === 0) return null;
  return (
    <section className="inspector-section inspector-ports">
      <h3>{t("editor:inspector.portsSection")}</h3>
      {inputs.length > 0 && (
        <div className="inspector-port-group">
          <h4>{t("editor:inspector.inputsSection")}</h4>
          {inputs.map((port) => (
            <InputPort
              canvas={canvas}
              key={port.id}
              node={node}
              port={port}
              role={roles.get(port.id)}
            />
          ))}
        </div>
      )}
      {outputs.length > 0 && (
        <div className="inspector-port-group">
          <h4>{t("editor:inspector.outputsSection")}</h4>
          {outputs.map((port) => (
            <OutputPort key={port.id} port={port} role={roles.get(port.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function InputChip({
  canvas,
  edge,
}: {
  canvas: CanvasDocument;
  edge: WorkflowEdge;
}) {
  const { t } = useTranslation();
  const source = canvas.nodes.find((node) => node.id === edge.source.nodeId);
  const portLabel = source?.ports.find(
    (port) => port.id === edge.source.portId,
  )?.label;
  const excerpt =
    source?.kind === "text"
      ? ((source.data as { content?: string }).content ?? "").slice(0, 24)
      : "";
  return (
    <li className="inspector-chip">
      <span className="inspector-chip-label">
        <strong>{source?.title ?? t("editor:inspector.unknown")}</strong>
        {portLabel ? ` · ${portLabel}` : ""}
        {excerpt ? <em> “{excerpt}”</em> : null}
      </span>
      <button
        aria-label={t("editor:inspector.disconnect")}
        onClick={() => disconnectEdge(edge.id)}
        type="button"
      >
        ✕
      </button>
    </li>
  );
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

/** What a node asks a provider to make, as it stands now. */
function GenerationSection({ node }: { node: WorkflowNode }) {
  const { t } = useTranslation();
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  if (!spec) return null;
  return (
    <section className="inspector-section">
      <h3>{t("editor:inspector.generation")}</h3>
      <Row
        label={t("editor:field.capability")}
        value={t(CAPABILITY_LABELS[spec.capability])}
      />
      <Row label={t("editor:field.mode")} value={spec.mode} />
      <Row
        label={t("editor:field.model")}
        value={spec.model || t("editor:inspector.providerDefault")}
      />
      <Row label={t("editor:field.inputsFrom")} value={spec.inputMode} />
      <h3>{t("editor:inspector.prompt")}</h3>
      <p className="inspector-text-excerpt">
        {spec.prompt.trim() ? spec.prompt : t("editor:inspector.empty")}
      </p>
      {Object.keys(spec.params).length > 0 && (
        <pre className="inspector-json">
          {JSON.stringify(spec.params, null, 2)}
        </pre>
      )}
    </section>
  );
}

/**
 * What the last answer this node produced was asked for, and the way to ask for
 * it again.
 *
 * Taken from the assets rather than from a run record: an exported package
 * carries its assets and their provenance but no runs, so a control that needed
 * the run it came from would be dead in every document that arrived from
 * somewhere else. Asking again is therefore a new run under the snapshot's own
 * spec, and never a retry of a run that may not exist here to retry.
 */
function LastGeneration({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const made = useNodeGenerationAssets(node.id);
  const starting = useRunStore((state) => state.starting);
  const generationOn = useGenerationAvailable();
  const [busy, setBusy] = useState(false);
  const recorded = made
    .map((entry) => entry.provenance)
    .find((provenance) => provenance?.parameterSnapshot);
  const spec = generationSpecFromSnapshot(
    recorded?.parameterSnapshot,
    node.kind,
  );
  const inputs = useMemo(() => {
    const wanted = recorded?.inputAssetIds;
    if (!moka || !wanted) return "";
    const resources = buildResourceIndex(moka);
    return wanted.map((id) => resources.get(id)?.name ?? id).join(", ");
  }, [moka, recorded]);

  if (!recorded || !spec) return null;

  const askAgain = async () => {
    setBusy(true);
    try {
      // A run is served from the document on disk, so a spec this control has
      // to put back is saved before the run is asked for.
      setNodeGeneration(canvas.id, node.id, spec);
      await useProjectStore.getState().flush();
      await useRunStore.getState().start(canvas.id, [node.id]);
    } catch (error) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          error instanceof Error
            ? error.message
            : t("editor:runHistory.runFailedToStart"),
        );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>{t("editor:inspector.lastGeneration")}</h3>
      {!recorded.runId && (
        <p className="inspector-note">
          {t("editor:inspector.lastGenerationNote")}
        </p>
      )}
      <Row label={t("editor:field.inputs")} value={inputs} />
      <pre className="inspector-json">
        {JSON.stringify(recorded.parameterSnapshot, null, 2)}
      </pre>
      <div className="inspector-actions">
        <button
          aria-label={t("editor:inspector.runAgainWithLast")}
          disabled={busy || starting || !generationOn}
          onClick={() => void askAgain()}
          title={generationOn ? undefined : generationUnavailable()}
          type="button"
        >
          {busy ? t("editor:inspector.starting") : t("editor:action.runAgain")}
        </button>
      </div>
    </>
  );
}

/** Run controls, latest run state, and result slots for the selected node. */
function RunSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t } = useTranslation();
  const run = useLatestRunForNode(node.id);
  const asked = useNodeRuns(node.id);
  const choices = choosableResults(canvas, node);
  const starting = useRunStore((state) => state.starting);
  const issues = useRunStore((state) => state.lastIssues);
  const generationOn = useGenerationAvailable();
  const progress = useNodeRunProgress(node.id);
  const failure = useNodeRunError(node.id);
  const said = useNodeStreamText(node.id);
  const step = run?.steps.find((entry) => entry.nodeId === node.id);
  /**
   * Whether this node's own part of the run is still going.
   *
   * Read from the step rather than from the run: a run that drove several nodes
   * stays going after one of them has landed, and a node that has finished has
   * no business offering to stop work it is no longer part of. What it offers
   * instead is another run of its own.
   */
  const active = step !== undefined && isActive(step.status);
  const slots = (node.data as { resultSlots?: ResultSlot[] }).resultSlots ?? [];
  const relevantIssues = issues.filter(
    (issue) => !issue.nodeId || issue.nodeId === node.id,
  );
  // Which executor a step would go to, rather than which kind of node this is:
  // a generation node is as runnable as an operation one, and a node neither
  // executor would take has no business offering a control at all.
  const executor = executorKeyForNode(node);
  const offline = executor === PROVIDER_EXECUTOR_KEY && !generationOn;
  const retryable = run?.status === "failed" || run?.status === "cancelled";

  const start = async () => {
    try {
      await useRunStore.getState().start(canvas.id, [node.id]);
    } catch (problem) {
      // Issues surface below via lastIssues; anything else — a provider with
      // nothing behind it, a process that is not there — is said out loud,
      // since nothing else would.
      const trouble = errorText(problem);
      useAppStore
        .getState()
        .pushToast("error", trouble.message, undefined, trouble.detail);
    }
  };

  return (
    <section className="inspector-section">
      <h3>{t("editor:inspector.runSection")}</h3>
      {executor !== null && (
        <div className="inspector-actions">
          <button
            disabled={starting || offline}
            onClick={() => void start()}
            title={offline ? generationUnavailable() : undefined}
            type="button"
          >
            {starting
              ? t("editor:inspector.starting")
              : t("editor:action.runThisNode")}
          </button>
          {active && run && (
            <button
              className="danger"
              onClick={() => void useRunStore.getState().cancel(run.id)}
              type="button"
            >
              {t("editor:action.cancel")}
            </button>
          )}
          {retryable && run && (
            <button onClick={() => void retryRun(run.id)} type="button">
              {t("editor:action.retry")}
            </button>
          )}
        </div>
      )}
      {offline && <p className="inspector-empty">{generationUnavailable()}</p>}
      {relevantIssues.length > 0 && (
        <ul className="inspector-issues" role="alert">
          {relevantIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <strong>{issue.code}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}
      {run && step && (
        <>
          <div className="inspector-row">
            <span>{t("editor:field.status")}</span>
            <span className={`run-chip run-chip-${step.status}`}>
              {t(RUN_STATUS_LABEL[step.status])}
              {run.cancelRequested && active
                ? t("editor:inspector.cancelling")
                : ""}
            </span>
          </div>
          {active && progress !== null && (
            <progress
              aria-label={t("editor:inspector.progress")}
              className="inspector-progress"
              max={1}
              value={progress}
            />
          )}
          <Row
            label={t("editor:field.started")}
            value={formatTime(step.startedAt ?? run.createdAt)}
          />
          <Row
            label={t("editor:field.finished")}
            value={formatTime(step.finishedAt)}
          />
          {failure && <p className="inspector-run-error">{failure}</p>}
          {!failure && run.error && !active && (
            <p className="inspector-run-error">{run.error}</p>
          )}
          {said ? (
            <p className="inspector-run-output">{said}</p>
          ) : (
            step.outputText && (
              <p className="inspector-run-output">{step.outputText}</p>
            )
          )}
        </>
      )}
      {asked.length > 1 && (
        <>
          <div className="inspector-row">
            <span>{t("editor:inspector.askedIn")}</span>
            <span className="inspector-run-list">
              {asked.map((entry) => (
                <span
                  className={`run-chip run-chip-${entry.step.status}`}
                  key={entry.run.id}
                >
                  {formatTime(entry.run.createdAt)} ·{" "}
                  {t(RUN_STATUS_LABEL[entry.step.status])}
                </span>
              ))}
            </span>
          </div>
          <p className="inspector-empty">
            {t("editor:inspector.eachAskWentAhead")}
          </p>
        </>
      )}
      <LastGeneration canvas={canvas} node={node} />
      {slots.length > 0 && (
        <>
          <h3>{t("editor:field.results")}</h3>
          {slots.map((slot, index) => (
            <div className="inspector-row" key={slot.id}>
              <span>
                {slot.isPrimary
                  ? t("editor:inspector.shown")
                  : t("editor:inspector.resultNumber", { index: index + 1 })}
              </span>
              <span className={`run-chip run-chip-${slot.status}`}>
                {slot.status}
              </span>
            </div>
          ))}
          {choices.length > 0 && (
            <div className="inspector-actions">
              {choices.map((choice) => (
                <button
                  key={choice.slotId}
                  onClick={() => chooseResult(node.id, choice.slotId)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {slots.find((slot) => slot.status === "failed")?.error && (
            <p className="inspector-run-error">
              {slots.find((slot) => slot.status === "failed")?.error}
            </p>
          )}
        </>
      )}
      {!run && executor !== null && relevantIssues.length === 0 && (
        <p className="inspector-empty">{t("editor:inspector.noRunsYet")}</p>
      )}
    </section>
  );
}

/**
 * The way a node's work is kept to hand.
 *
 * A node that already holds a file is only marked as kept, and one whose words
 * are its own gets them written out; either way the shelf comes away with an
 * entry rather than a second copy of anything.
 */
function ShelfSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (!filingPossible(node)) return null;
  const save = async () => {
    setBusy(true);
    try {
      await fileNodeAsAsset(canvas.id, node.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="inspector-section">
      <h3>{t("editor:field.shelf")}</h3>
      <div className="inspector-actions">
        <button disabled={busy} onClick={() => void save()} type="button">
          {busy ? t("editor:action.saving") : t("editor:menu.saveAsMaterial")}
        </button>
      </div>
    </section>
  );
}

/**
 * The node as the document holds it, for reading rather than editing.
 *
 * Everything above this is one reading of that object, and when a reading looks
 * wrong the plain copy is what settles it — including the parts that have no
 * row of their own. Folded away because it is for comparing against, not for
 * looking at.
 */
function JsonSection({ node }: { node: WorkflowNode }) {
  const { t } = useTranslation();
  const json = JSON.stringify(node, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      useEditorStore.getState().announce(t("editor:inspector.nodeJsonCopied"));
    } catch (problem) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          t("editor:inspector.clipboardUnavailable"),
          undefined,
          errorText(problem).message,
        );
    }
  };
  return (
    <details className="inspector-section inspector-json-section">
      <summary>{t("editor:inspector.json")}</summary>
      <pre className="inspector-json" data-testid="node-json">
        {json}
      </pre>
      <div className="inspector-actions">
        <button onClick={() => void copy()} type="button">
          {t("editor:inspector.copyJson")}
        </button>
      </div>
    </details>
  );
}

function NodeInspector({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <TitleField node={node} />
      <div className="inspector-row">
        <span>{t("editor:field.kind")}</span>
        <span>{node.kind}</span>
      </div>
      <div className="inspector-row">
        <span>{t("editor:inspector.position")}</span>
        <span>
          {Math.round(node.bounds.x)}, {Math.round(node.bounds.y)} ·{" "}
          {Math.round(node.bounds.width)}×{Math.round(node.bounds.height)}
        </span>
      </div>
      <PortsSection canvas={canvas} node={node} />
      {node.kind === "text" && <TextSection node={node} />}
      {node.kind === "operation" && <OperationSection node={node} />}
      {node.kind === "export" && (
        <div className="inspector-row">
          <span>{t("editor:field.format")}</span>
          <span>{(node.data as { format?: string }).format ?? ""}</span>
        </div>
      )}
      {node.kind === "extension" && (
        <ExtensionSection canvas={canvas} node={node} />
      )}
      {node.kind === "director" && (
        <DirectorSection canvas={canvas} node={node} />
      )}
      <GenerationSection node={node} />
      <MediaAssetSection node={node} />
      <ShelfSection canvas={canvas} node={node} />
      <RunSection canvas={canvas} node={node} />
      <JsonSection node={node} />
    </>
  );
}

function DirectorSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const scene = moka ? directorSceneOf(moka, node) : undefined;
  const state = (
    node.data as {
      director?: {
        sceneId?: string;
        frameAssetId?: string;
        blockingAssetId?: string;
        frameShotId?: string;
        directionText?: string;
      };
    }
  ).director;
  const shot = scene ? activeShotOf(scene) : undefined;

  const recover = () => {
    if (!moka) return;
    const fresh = createDirectorScene(node.title);
    execute(i18n.t("editor:history.createDirector"), [
      { type: "addDirectorScene", scene: fresh },
      {
        type: "updateNode",
        canvasId: canvas.id,
        nodeId: node.id,
        patch: {
          data: {
            director: { ...state, sceneId: fresh.id },
          },
        },
      },
    ]);
  };

  return (
    <section className="inspector-section">
      <h3>{t("editor:inspector.director.title")}</h3>
      {scene ? (
        <>
          <div className="inspector-row">
            <span>{t("editor:inspector.director.scene")}</span>
            <span>{scene.title}</span>
          </div>
          <div className="inspector-row">
            <span>{t("editor:inspector.director.shot")}</span>
            <span>
              {shot
                ? `${shot.name} · ${shot.duration}s · ${shot.aspectRatio} · ${shot.fps}fps`
                : t("editor:inspector.director.noShot")}
            </span>
          </div>
          <div className="inspector-row">
            <span>{t("editor:inspector.director.counts")}</span>
            <span>
              {scene.objects.length} / {scene.cameras.length} /{" "}
              {scene.lights.length}
            </span>
          </div>
          {state?.frameAssetId ? (
            <button
              className="inspector-director-frame"
              onClick={() =>
                useEditorStore.getState().openPreview(state.frameAssetId!)
              }
              type="button"
            >
              <img alt="" src={assetUrl(state.frameAssetId)} />
              <span>
                {t("editor:inspector.director.frame")}
                {state.frameShotId && scene.activeShotId !== state.frameShotId
                  ? ` · ${t("editor:inspector.director.staleShot")}`
                  : ""}
              </span>
            </button>
          ) : (
            <p className="inspector-text-excerpt">
              {t("editor:inspector.director.notDelivered")}
            </p>
          )}
          {state?.blockingAssetId && (
            <video
              className="inspector-director-blocking"
              controls
              preload="metadata"
              src={assetUrl(state.blockingAssetId)}
            />
          )}
          {state?.directionText && (
            <div className="inspector-actions">
              <button
                onClick={() =>
                  void navigator.clipboard?.writeText(state.directionText ?? "")
                }
                type="button"
              >
                {t("editor:inspector.director.copyPrompt")}
              </button>
            </div>
          )}
          <div className="inspector-actions">
            <button onClick={() => openDirector(node.id)} type="button">
              {t("editor:inspector.director.open")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="inspector-error">
            {t("editor:inspector.director.sceneMissing")}
          </p>
          <div className="inspector-actions">
            <button onClick={recover} type="button">
              {t("editor:inspector.director.recover")}
            </button>
            <button onClick={() => openDirector(node.id)} type="button">
              {t("editor:inspector.director.open")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function TextSection({ node }: { node: WorkflowNode }) {
  const { t } = useTranslation();
  const content = (node.data as { content?: string }).content ?? "";
  return (
    <section className="inspector-section">
      <h3>{t("editor:field.content")}</h3>
      <p className="inspector-text-excerpt">
        {content.trim() ? content.slice(0, 280) : t("editor:inspector.empty")}
      </p>
      <div className="inspector-actions">
        <button
          onClick={() => useEditorStore.getState().startEditingText(node.id)}
          type="button"
        >
          {t("editor:inspector.editText")}
        </button>
      </div>
    </section>
  );
}

function OperationSection({ node }: { node: WorkflowNode }) {
  const { t } = useTranslation();
  const data = node.data as {
    operationType?: string;
    parameters?: Record<string, unknown>;
  };
  const params = Object.entries(data.parameters ?? {});
  return (
    <section className="inspector-section">
      <h3>{t("editor:inspector.operation")}</h3>
      <Row label={t("editor:field.type")} value={data.operationType ?? ""} />
      {params.map(([key, value]) => (
        <Row key={key} label={key} value={String(value)} />
      ))}
    </section>
  );
}

function EdgeInspector({
  canvas,
  edge,
}: {
  canvas: CanvasDocument;
  edge: WorkflowEdge;
}) {
  const { t } = useTranslation();
  const endpoint = (nodeId: string, portId: string) => {
    const node = canvas.nodes.find((entry) => entry.id === nodeId);
    const port = node?.ports.find((entry) => entry.id === portId);
    return node
      ? `${node.title}${port ? ` · ${port.label}` : ""}`
      : t("editor:inspector.unknown");
  };
  return (
    <>
      <h2 className="inspector-heading">{t("editor:inspector.edge")}</h2>
      <Row
        label={t("editor:field.from")}
        value={endpoint(edge.source.nodeId, edge.source.portId)}
      />
      <Row
        label={t("editor:field.to")}
        value={endpoint(edge.target.nodeId, edge.target.portId)}
      />
      <div className="inspector-actions">
        <button
          className="danger"
          onClick={() => deleteSelection()}
          type="button"
        >
          {t("editor:inspector.deleteEdge")}
        </button>
      </div>
    </>
  );
}

const BACKGROUND_LABELS: Record<BackgroundMode, string> = {
  dots: "editor:inspector.backgroundModeDots",
  lines: "editor:inspector.backgroundModeLines",
  blank: "editor:inspector.backgroundModeBlank",
};

/**
 * The canvas's own settings, shown when nothing on it is selected.
 *
 * With no node to describe, the panel says what the surface behind the nodes
 * is drawn with, and what colors the whole board is painted in. The
 * background is the document's own, so it is written into the document and
 * undoes like any other edit; the palette is this machine's, kept beside the
 * project rather than inside it, and offered here because where the canvas is
 * looked at is where a way of looking at it belongs.
 */
function CanvasViewSection({ canvas }: { canvas: CanvasDocument }) {
  const { t } = useTranslation();
  const { background, showMinimap } = canvas.settings;
  const theme = useAppearance((state) => state.theme);
  return (
    <section className="inspector-section">
      <h3>{t("editor:inspector.canvasView")}</h3>
      <div className="inspector-row">
        <span>{t("editor:field.background")}</span>
        <div
          aria-label={t("editor:inspector.canvasBackground")}
          className="tool-group"
          role="group"
        >
          {BACKGROUND_MODES.map((mode) => (
            <button
              aria-pressed={background === mode}
              className={background === mode ? "is-active" : ""}
              key={mode}
              onClick={() => setCanvasViewSettings({ background: mode })}
              type="button"
            >
              {t(BACKGROUND_LABELS[mode])}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-row">
        <span>{t("editor:field.palette")}</span>
        <div
          aria-label={t("editor:inspector.theme")}
          className="tool-group"
          role="group"
        >
          {CANVAS_THEME_NAMES.map((name) => (
            <button
              aria-pressed={theme === name}
              className={theme === name ? "is-active" : ""}
              key={name}
              onClick={() => useAppearance.getState().setTheme(name)}
              title={t("editor:inspector.themeHint")}
              type="button"
            >
              {t(CANVAS_THEME_LABELS[name])}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-row">
        <span>{t("editor:field.minimap")}</span>
        <button
          aria-pressed={showMinimap}
          className={showMinimap ? "is-active" : ""}
          onClick={() => setCanvasViewSettings({ showMinimap: !showMinimap })}
          type="button"
        >
          {t("editor:inspector.showMinimap")}
        </button>
      </div>
    </section>
  );
}

/**
 * A file the project holds, read on its own.
 *
 * What the column beside the canvas says when a reader clicked a file on the
 * shelf rather than a card on the board: what the file is, what it holds, where
 * it came from, and what in this project is made of it. The same file a card
 * holds, described without the card — since a file nobody has put on a board
 * yet is still a file worth reading, and one that forty cards hold is worth
 * reading once.
 */
function AssetInspector({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeCanvas = useActiveCanvas();
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map<AssetId, ResourceEntry>()),
    [moka],
  );
  const keeper = entry.favorite === true;
  const url = assetUrl(entry.id);
  // Counted here rather than taken from the row that was clicked, since the
  // column reads the file as it stands and not as it stood a click ago. What
  // the project holds it by is every kind of hold and not only the cards —
  // a file a story keeps as a drawing is used by the project as much as one a
  // card shows, and "0" over a file the server refuses to delete is a lie.
  const usesHere = activeCanvas ? canvasNodesUsing(activeCanvas, entry.id) : [];
  const held = moka === null ? 0 : assetHolders(moka, entry.id).length;
  const cards = (count: number) =>
    count === 1
      ? t("editor:inspector.cardsOne", { count })
      : t("editor:inspector.cardsMany", { count });
  const uses = (count: number) =>
    count === 1
      ? t("editor:inspector.usesOne", { count })
      : t("editor:inspector.usesMany", { count });

  return (
    <div className="inspector-asset" data-testid="asset-inspector">
      <h3 className="inspector-asset-name" title={entry.name}>
        {entry.name}
      </h3>
      <AssetPreviewSection entry={entry} />
      <AssetFileSection entry={entry} />
      <AssetNoteSection entry={entry} />
      <AssetProvenanceSection entry={entry} resources={resources} />
      <section className="inspector-section">
        <h3>{t("editor:field.usedBy")}</h3>
        <Row
          label={t("editor:field.onThisCanvas")}
          value={cards(usesHere.length)}
        />
        <Row label={t("editor:field.inThisProject")} value={uses(held)} />
      </section>
      {/* What can be done about the file rather than about a card: where it is
          on this machine, the cards made of it, whether it is kept to hand, and
          whether it stays in the project at all. */}
      <div className="inspector-actions">
        <button
          disabled={usesHere.length === 0}
          onClick={() => focusAssetUses(usesHere)}
          title={
            usesHere.length === 0
              ? t("editor:shelf.noCardUsesIt")
              : usesHere.length === 1
                ? t("editor:inspector.selectCardsOne")
                : t("editor:inspector.selectCardsMany", {
                    count: usesHere.length,
                  })
          }
          type="button"
        >
          {t("editor:inspector.focusCards")}
        </button>
        <button onClick={() => void revealAsset(entry.id)} type="button">
          {t("editor:action.reveal")}
        </button>
        <a download={entry.name} href={url}>
          {t("editor:action.download")}
        </a>
        <button
          aria-pressed={keeper}
          onClick={() => void markAssetKeeper(entry, !keeper)}
          type="button"
        >
          {keeper
            ? t("editor:action.stopKeeping")
            : t("editor:action.keepToHand")}
        </button>
        <button
          className="danger"
          onClick={() => void requestDeleteAsset(entry.id)}
          type="button"
        >
          {t("editor:action.remove")}
        </button>
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const { t } = useTranslation();
  const selection = useEditorStore((state) => state.selection);
  const inspectedAssetId = useEditorStore((state) => state.inspectedAssetId);
  const activeCanvas = useActiveCanvas();
  const moka = useProjectStore((state) => state.moka);
  // Read out of the project rather than held from the click that asked: a file
  // deleted or replaced while the column was reading it is read as it stands.
  const inspected = useMemo(
    () =>
      moka && inspectedAssetId
        ? buildResourceIndex(moka).get(inspectedAssetId)
        : undefined,
    [moka, inspectedAssetId],
  );

  const selectedNodes = activeCanvas
    ? activeCanvas.nodes.filter((node) => selection.nodeIds.includes(node.id))
    : [];
  const selectedEdges = activeCanvas
    ? activeCanvas.edges.filter((edge) => selection.edgeIds.includes(edge.id))
    : [];

  let body;
  // A file asked about on the shelf is read first, and stays read until
  // something on the canvas is chosen instead: the shelf's import puts a card
  // on the board and chooses it, so a reader who then clicked the file the card
  // was made of would otherwise be answered about the card they never asked
  // about. Choosing on the canvas puts the file down, so the column always
  // reads the last thing asked of it.
  if (inspected) {
    body = <AssetInspector entry={inspected} />;
  } else if (
    activeCanvas &&
    selectedNodes.length === 1 &&
    selectedEdges.length === 0
  ) {
    body = <NodeInspector canvas={activeCanvas} node={selectedNodes[0]} />;
  } else if (
    activeCanvas &&
    selectedEdges.length === 1 &&
    selectedNodes.length === 0
  ) {
    body = <EdgeInspector canvas={activeCanvas} edge={selectedEdges[0]} />;
  } else if (selectedNodes.length === 0 && selectedEdges.length === 0) {
    body = (
      <>
        <p className="inspector-empty">
          {t("editor:inspector.nothingSelected")}
        </p>
        {activeCanvas && <CanvasViewSection canvas={activeCanvas} />}
      </>
    );
  } else {
    body = (
      <ul className="inspector-list">
        {selectedNodes.map((node) => (
          <li key={node.id}>
            <strong>{node.title}</strong>
            <span>{node.kind}</span>
          </li>
        ))}
        {selectedEdges.map((edge) => (
          <li key={edge.id}>
            <strong>{t("editor:inspector.edge")}</strong>
            <span>
              {edge.source.nodeId} → {edge.target.nodeId}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <aside
      aria-label={t("editor:inspector.title")}
      className="editor-inspector"
    >
      <h2>{t("editor:inspector.title")}</h2>
      {body}
    </aside>
  );
}
