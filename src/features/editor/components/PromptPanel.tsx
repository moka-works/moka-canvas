import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { runsApi, type GenerationPreview } from "../../../api";
import {
  CAPABILITY_LABELS,
  MAX_PROMPT_LENGTH,
  boundsForShape,
  capabilityServes,
  defaultGenerationSpec,
  findNode,
  generationCapabilityFor,
  mentionNodeIds,
  nowIso,
  paramsForCapability,
  type AssetId,
  type Capability,
  type GenerationInputMode,
  type GenerationMode,
  type GenerationSpec,
  type NodeId,
  type Rect,
  type ResourceEntry,
  type WorkflowNode,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { ModelPicker } from "../../settings/ModelPicker";
import { modelOptionsFor, useModelStore } from "../../settings/modelStore";
import { worldToClient } from "../canvas/canvasControl";
import { buildIssueIndex, buildResourceIndex } from "../canvas/mediaCards";
import { mentionChoices } from "../canvas/mentions";
import {
  attachAssetsToNode,
  disconnectEdge,
  fitSelectionAction,
  importFiles,
  moveInput,
  setNodeGeneration,
} from "../interactions/actions";
import {
  generationUnavailable,
  useAppStore,
  useGenerationAvailable,
} from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import {
  isActive,
  useLatestRunForNode,
  useNodeRunStatus,
  useRunStore,
} from "../stores/runStore";
import { GenerationParams, type ParamValue } from "./GenerationParams";
import { InputPreview } from "./InputPreview";
import { MentionField, focusEnd } from "./MentionField";
import { MentionStrip } from "./MentionStrip";
import { ReferenceBar } from "./ReferenceBar";

/** The narrowest and widest the panel gets from the size of its node. */
const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 720;
/** How much wider than its node the panel comes up, so words have room. */
const PANEL_WIDTH_FACTOR = 1.3;
/**
 * How tall the panel comes up before the reader drags its corner.
 *
 * Sized around the field rather than around the panel: the words are what the
 * panel is for, and everything else in it is a row or two, so the room a box
 * of words gets is close to this less a fixed hundred-odd.
 */
const PANEL_DEFAULT_HEIGHT = 460;
/** The shortest the panel may be dragged to and still be a panel. */
const PANEL_MIN_HEIGHT = 140;

/**
 * The parameter that states the shape of what a node makes, and so the shape the
 * node itself is given while it waits.
 */
const SHAPE_PARAM: Record<Capability, string | null> = {
  image: "size",
  video: "ratio",
  text: null,
  speech: null,
  music: null,
  asr: null,
};

/** Whether a node already holds something rather than waiting to be filled. */
function holdsSomething(node: WorkflowNode): boolean {
  const data = node.data as { assetId?: string; content?: string };
  return Boolean(data.assetId) || (data.content ?? "").trim() !== "";
}

/**
 * Whether what a node holds is a picture.
 *
 * Read off the registry where the asset is known, since a text node may hold a
 * picture of its own; the node's kind answers where the registry has not caught
 * up with a document that was just opened.
 */
function holdsAnImage(
  node: WorkflowNode,
  resources: ReadonlyMap<AssetId, ResourceEntry>,
): boolean {
  const assetId = (node.data as { assetId?: string }).assetId;
  if (!assetId) return false;
  const entry = resources.get(assetId as AssetId);
  return entry
    ? (entry.mime ?? "").startsWith("image/")
    : node.kind === "image";
}

/**
 * How long a prompt gets before the panel counts it out loud.
 *
 * A count beside every word would be noise for the short asks that are most of
 * them; what matters is that the limit is not reached in silence.
 */
const COUNTED_FROM = Math.round(MAX_PROMPT_LENGTH * 0.9);

/** The three things the panel can be showing, one at a time. */
type PanelTab = "prompt" | "parameter" | "preview";

/**
 * Why this node cannot be asked yet, or null when it can.
 *
 * Stated on the control rather than left to be discovered by using it: a refusal
 * that arrives as a failed run costs a round trip, and reads as something a
 * provider did rather than as something missing here.
 */
function refusalFor(asked: {
  available: boolean;
  /** Settled: the models were read, and this kind of node has none to be pointed at. */
  noModel: boolean;
  capability: Capability;
  prompt: string;
  /** The prompt names a node this canvas has none of. */
  dangling: boolean;
  fedFromUpstream: boolean;
}): string | null {
  if (!asked.available) return generationUnavailable();
  if (asked.noModel) {
    return i18n.t("editor:promptPanel.noModel", {
      kind: i18n.t(CAPABILITY_LABELS[asked.capability]).toLowerCase(),
    });
  }
  if (asked.dangling) {
    return i18n.t("editor:promptPanel.danglingMention");
  }
  if (asked.prompt.trim() === "" && !asked.fedFromUpstream) {
    return i18n.t("editor:promptPanel.nothingToAsk");
  }
  const over = asked.prompt.length - MAX_PROMPT_LENGTH;
  if (over > 0) {
    const limit = MAX_PROMPT_LENGTH.toLocaleString();
    return i18n.t("editor:promptPanel.overLimit", {
      over: over.toLocaleString(),
      limit,
    });
  }
  return null;
}

/**
 * Asks one node for something: the model, the words, and the button that sends
 * them.
 *
 * Nothing here is offered as a mode to pick. Where the ask takes what it is
 * given from is read off the panel rather than chosen on it: the prompt's own
 * words when they name cards, the list kept by hand when there is one, and the
 * wiring otherwise. What it asks to do follows the same way: an image asked
 * with a picture among its inputs changes that picture, and every other ask
 * starts over.
 *
 * A DOM panel under the node rather than part of its card, because a card drawn
 * on a canvas has no room for a form and a child element in it would break the
 * canvas's own hit testing. Anchored in world coordinates so it travels with the
 * node — and deliberately not kept inside the view: its top edge sits on its
 * node's bottom edge wherever that is, so a node dragged to the edge of the
 * canvas takes the panel off screen with it rather than leaving it behind
 * floating over the middle of the view like a dialog that belongs to nothing.
 * It reaches past its node by the same distance on both sides, so the card
 * stands centred in the panel it is asked from. The corner it is dragged by is
 * its bottom-right one, so growing it never moves the corner its node put it
 * at.
 *
 * What is typed is held here until it is asked for, so a keystroke is not an
 * undo entry and a save; the discrete controls write straight through, because
 * a click is a choice rather than a draft of one.
 */
export function PromptPanel() {
  const { t } = useTranslation();
  const open = useEditorStore((state) => state.promptPanel);
  const selected = useEditorStore((state) => state.selection.nodeIds);
  const camera = useEditorStore((state) => state.camera);
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const generationOn = useGenerationAvailable();
  const view = useModelStore((state) => state.view);
  const run = useLatestRunForNode(open?.nodeId ?? null);
  // This node's own step, not the run's whole: a run that drove several nodes
  // stays going after one of them has landed, and this panel is about the one
  // node it is open on.
  const stepStatus = useNodeRunStatus(open?.nodeId ?? null);
  const areaRef = useRef<HTMLDivElement>(null);
  const shownFor = useRef<NodeId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which of the panel's three tabs is being read. */
  const [tab, setTab] = useState<PanelTab>("prompt");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** The size the reader dragged the panel to, or null for its node's own. */
  const [size, setSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  /** Sizes taken by hand, kept per node for as long as the editor is open. */
  const sizesFor = useRef(new Map<NodeId, { width: number; height: number }>());
  const panelRef = useRef<HTMLDivElement>(null);
  const sizedFor = useRef<NodeId | null>(null);

  // Built once per document rather than once per keystroke: a project may hold
  // thousands of assets and the field asks after every one of them.
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map<AssetId, ResourceEntry>()),
    [moka],
  );
  const issues = useMemo(() => buildIssueIndex(selfCheck), [selfCheck]);

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  const node = open && canvas ? findNode(canvas, open.nodeId) : null;
  // Each node brings its own size back: a panel widened by hand for one node
  // is that node's, and coming up on another is not a reason to forget it.
  if (node && canvas && sizedFor.current !== node.id) {
    sizedFor.current = node.id;
    setSize(sizesFor.current.get(node.id) ?? null);
  }
  // What the field may mention, worked out here rather than in it: the field
  // narrows this list on every keystroke, and walking the canvas each time it
  // does would cost more than the narrowing.
  const choices = useMemo(
    () =>
      node && canvas ? mentionChoices(canvas, node, resources, issues) : [],
    [canvas, node, resources, issues],
  );
  const capability = node ? generationCapabilityFor(node.kind) : null;
  const nodeId = node && capability ? node.id : null;
  const canvasId = canvas?.id ?? null;
  /** The document's own word for "it moved", which is when an answer goes stale. */
  const revision = moka?.metadata.revision ?? 0;
  const chosen =
    selected.length === 1 && canvas ? findNode(canvas, selected[0]) : undefined;
  const chosenId =
    chosen && generationCapabilityFor(chosen.kind) !== null ? chosen.id : null;

  /**
   * Brings the panel up with the selected node, once per selection.
   *
   * Remembering which node it was shown for is what lets Escape close it: an
   * effect that only asked whether the panel is open would put it straight back,
   * and the key would look like it did nothing.
   */
  useEffect(() => {
    if (shownFor.current === chosenId) return;
    shownFor.current = chosenId;
    // Already up on this node means an entry the user chose put it there, and
    // may have asked for the keyboard with it: bringing it up again would take
    // that request back without the panel ever having been closed.
    const shown = useEditorStore.getState().promptPanel;
    if (chosenId && shown?.nodeId !== chosenId) {
      useEditorStore.getState().openPromptPanel(chosenId);
    }
  }, [chosenId]);

  // The panel is about a selected node, so a selection that has let go of that
  // node takes the panel with it.
  useEffect(() => {
    const current = useEditorStore.getState().promptPanel;
    if (current && !selected.includes(current.nodeId)) {
      useEditorStore.getState().closePromptPanel();
    }
  }, [selected]);

  useEffect(() => {
    if (!nodeId || !node) return;
    const stored = (node.data as { generation?: GenerationSpec }).generation;
    setPrompt(stored?.prompt ?? "");
    // Taking the keyboard is for an entry the user chose. Coming up because a
    // node was selected must not, or words would land in the prompt and Delete
    // would stop deleting the node.
    if (!open?.focus) return;
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      focusEnd(area);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Reads what this node will send, while the disclosure is open and again
   * whenever the document moves.
   *
   * Asked of the server rather than worked out here a second time: the same pass
   * that folds a graph into one prompt is the one a run takes, and a copy of it
   * in the panel would be a second thing free to disagree with the first.
   */
  useEffect(() => {
    if (!previewOpen || !canvasId || !nodeId) return;
    const asked = new AbortController();
    let abandoned = false;
    setReading(true);
    runsApi
      .preview(canvasId, nodeId, asked.signal)
      .then((answer) => {
        if (abandoned) return;
        setPreview(answer);
        setPreviewError(null);
      })
      .catch((error) => {
        if (abandoned) return;
        setPreviewError(
          error instanceof Error
            ? error.message
            : t("editor:promptPanel.previewUnreadable"),
        );
      })
      .finally(() => {
        if (!abandoned) setReading(false);
      });
    return () => {
      abandoned = true;
      asked.abort();
    };
    // The revision is not read here: it is what makes this ask again, since a
    // preview of the document as it was is a preview of something else.
  }, [previewOpen, canvasId, nodeId, revision, t]);

  if (!node || !canvas || !capability) return null;

  const stored = (node.data as { generation?: GenerationSpec }).generation;
  const spec = stored ?? defaultGenerationSpec(node.kind);
  if (!spec) return null;

  /**
   * Which capability this ask is in. A stored spec says so itself — a sound
   * node is the one kind two capabilities serve — and a node nothing has been
   * asked of yet starts in the capability its kind implies.
   */
  const asked =
    stored && capabilityServes(stored.capability, node.kind)
      ? stored.capability
      : capability;

  /** Everything arriving at this node, which is what an ask with no words of its own is given. */
  const wired = canvas.edges.filter((edge) => edge.target.nodeId === node.id);

  /**
   * Whether a director's blocking reference is among the inputs.
   *
   * A plain white-model film is a video of the motion, not a picture a clip
   * starts from. The gateway only reads it that way in the reference mode, so
   * the panel says so before a run spends anything.
   */
  const blockingFed = wired.some((edge) => {
    const source = findNode(canvas, edge.source.nodeId);
    return source?.kind === "director" && edge.source.portId === "blocking";
  });
  const videoBlocking = asked === "video" && blockingFed;
  const explicitVideoMode =
    typeof spec.params.mode === "string" ? spec.params.mode : undefined;
  // Left to the default, a wired blocking reference means reference mode.
  // Choosing auto is a choice, and the panel warns rather than overrides it.
  const panelParams =
    videoBlocking && explicitVideoMode === undefined
      ? { ...spec.params, mode: "reference" }
      : spec.params;

  /**
   * Where the ask takes what it is given from, read off the words and the
   * graph rather than chosen on the panel.
   *
   * A prompt that names cards is asking for those cards and nothing else, so
   * it says so; otherwise the list kept by hand speaks where there is one, and
   * the wiring where there is not. A node with none of the three is asked in
   * words alone, which is the empty list.
   */
  const inputModeFor = (): GenerationInputMode => {
    if (mentionNodeIds(prompt).length > 0) return "mentions";
    if (spec.referenceNodeIds.length > 0) return "manual";
    if (wired.length > 0) return "upstream";
    return "manual";
  };

  /**
   * What this kind of node is being asked to do, which nothing is offered as a
   * choice either: an image asked with a picture among its inputs is changing
   * that picture, and every other ask anywhere is starting over.
   */
  const modeFor = (taken: GenerationInputMode): GenerationMode => {
    if (capability !== "image") return "generate";
    const fed =
      taken === "upstream"
        ? wired.map((edge) => edge.source.nodeId)
        : taken === "manual"
          ? spec.referenceNodeIds
          : mentionNodeIds(prompt);
    return fed.some((id) => {
      const source = findNode(canvas, id);
      return source !== undefined && holdsAnImage(source, resources);
    })
      ? "edit"
      : "generate";
  };

  const inputMode = inputModeFor();
  const mode = modeFor(inputMode);
  const models = modelOptionsFor(view, asked);
  const going = stepStatus !== null && isActive(stepStatus);
  const stopping = run !== null && going && run.cancelRequested;
  /**
   * Whether the run this node was last asked in is one worth asking again as a
   * follower of itself, which is what keeps the two visible as one question
   * asked twice rather than as two that have nothing to do with each other.
   * Only where it asked for this node and nothing else: a run that drove several
   * is not this panel's to send off again.
   */
  const again =
    run !== null &&
    !going &&
    (run.status === "failed" || run.status === "cancelled") &&
    run.requestedNodeIds.length === 1 &&
    run.requestedNodeIds[0] === node.id;
  // A configuration still being read is not one with nothing in it.
  const noModel = view !== null && models.length === 0;
  // What a node with no words of its own may still be asked for: something
  // arriving on its prompt port, or a reference it points at by hand.
  const fedFromUpstream =
    spec.referenceNodeIds.length > 0 ||
    canvas.edges.some(
      (edge) =>
        edge.target.nodeId === node.id && edge.target.portId === "prompt",
    );
  // A mention of a node that is not there sends nothing for itself, and a run
  // that answers anyway reads as a provider ignoring the reference rather than
  // as a pointer that has come loose.
  const dangling = mentionNodeIds(prompt).some((id) => !findNode(canvas, id));
  const refusal = refusalFor({
    available: generationOn,
    noModel,
    capability: asked,
    prompt,
    dangling,
    fedFromUpstream,
  });
  const over = prompt.length - MAX_PROMPT_LENGTH;
  const counted = prompt.length >= COUNTED_FROM;

  const commit = (patch: Partial<GenerationSpec> = {}, bounds?: Rect) => {
    setNodeGeneration(
      canvas.id,
      node.id,
      {
        ...spec,
        mode,
        inputMode,
        prompt,
        ...patch,
        updatedAt: nowIso(),
      },
      bounds,
    );
  };

  const setParam = (key: string, value: ParamValue | null) => {
    const params = { ...spec.params };
    if (value === null) delete params[key];
    else params[key] = value;
    // The panel's reading of a wired blocking reference is written down with
    // the first parameter touch, so what is shown and what is sent agree.
    if (
      key !== "mode" &&
      videoBlocking &&
      explicitVideoMode === undefined &&
      params.mode === undefined
    ) {
      params.mode = "reference";
    }
    // A shape is the shape of the node as well, while the node is still waiting
    // for something: an empty one is resized to it in the same step. One that
    // already holds something keeps the size its content gave it, since a
    // picture has the shape it has whatever was asked for.
    const reshaped =
      value !== null && key === SHAPE_PARAM[asked] && !holdsSomething(node)
        ? boundsForShape(node.bounds, `${value}`)
        : null;
    commit({ params }, reshaped ?? undefined);
  };

  /**
   * Moves a sound ask between the two capabilities that serve it.
   *
   * The model goes with the move: a voice model does not compose, and a
   * reference to one left standing over a score's ask would only be refused
   * when a run reached it. The parameters are cut to what the capability the
   * ask lands in takes — a voice field on a score is nothing the services a
   * score can reach would read.
   */
  const switchCapability = (next: Capability) => {
    if (next === asked) return;
    commit({
      capability: next,
      model: "",
      params: paramsForCapability(next, spec.params),
    });
  };

  // Losing focus with nothing typed is not a request. The panel came up on its
  // own here, and a spec written for it would make the node look runnable
  // before anything had been asked of it.
  const commitPrompt = () => {
    if (!stored && prompt.trim() === "") return;
    commit({ prompt });
  };

  /**
   * Takes the words as they are typed.
   *
   * Nothing is written through here: where the ask takes its inputs from is
   * read off the words themselves, so a keystroke is only ever a draft.
   */
  const changePrompt = (next: string) => {
    setPrompt(next);
  };

  /**
   * Takes an asset dropped on what this node is given.
   *
   * A node is made for it beside this one first, because a reference is a node
   * and an asset on its own is not one. Where this node takes what it is given
   * from the wiring, the new node is wired in; where it takes it from a list
   * kept by hand, it is listed instead.
   */
  const takeAsset = (assetId: AssetId) => {
    void attachAssetsToNode(node.id, [assetId]);
  };

  /** The same, for files brought from this machine rather than the panel. */
  const takeFiles = (files: File[]) => {
    void (async () => {
      const imported = await importFiles(files);
      if (imported.length > 0) await attachAssetsToNode(node.id, imported);
    })();
  };

  /**
   * Brings one of the nodes this node is given into view.
   *
   * The panel goes with the selection, so this closes it — which is the point:
   * the reader asked to be taken to the other node, not to keep looking at this
   * one while it happens somewhere off screen.
   */
  const locate = (target: NodeId) => {
    useEditorStore.getState().selectOnly(target);
    fitSelectionAction();
  };

  /**
   * Moves between the panel's tabs.
   *
   * Opening the preview saves what the panel holds first and waits for it to
   * land. The preview is read off the document on disk, so asking for it
   * straight after a keystroke would answer for the ask before this one — and
   * then answer again, differently, once the save caught up.
   *
   * Saved whole, since a node the panel has just come up on holds no ask at all
   * and may still have one to show: its words can be arriving on a wire rather
   * than typed here. Where nothing could be asked for yet, nothing is written
   * for it — a spec gained by opening a tab would make a node look asked when
   * the panel itself is still saying why it cannot be. An ask already in the
   * document is left alone by the command layer, so this costs a step of
   * history only the first time.
   */
  const selectTab = (next: PanelTab) => {
    if (next === tab) return;
    if (next !== "preview") {
      setPreviewOpen(false);
      setTab(next);
      return;
    }
    void (async () => {
      setPreviewError(null);
      if (refusal === null) commit();
      await useProjectStore.getState().flush();
      setTab("preview");
      setPreviewOpen(true);
    })();
  };

  /**
   * Takes the panel's bottom-right corner and drags it.
   *
   * Only the far edges move: the corner the node put the panel at stays where
   * its node left it, however wide or tall the reader makes it. The size is
   * remembered per node for as long as the editor is open.
   */
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

  /**
   * Asks the node for what the panel holds.
   *
   * Where a run of this node's gave up, the ask follows it rather than starting
   * over: a retry is asked against the document as it now stands, so what has
   * been typed since still counts, and the two runs stay visible as one question
   * asked twice rather than as two with nothing to do with each other.
   */
  const ask = async () => {
    setBusy(true);
    try {
      // A run is served from the document on disk, so what the panel holds is
      // saved before the run is asked for.
      commit(
        videoBlocking && explicitVideoMode === undefined
          ? { params: { ...spec.params, mode: "reference" } }
          : {},
      );
      await useProjectStore.getState().flush();
      const runs = useRunStore.getState();
      if (again && run) await runs.retry(run.id);
      else await runs.start(canvas.id, [node.id]);
    } catch (error) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          error instanceof Error
            ? error.message
            : t("editor:promptPanel.runFailedToStart"),
        );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Asks a run still going to stop.
   *
   * The store says so at once rather than when the server answers, so the
   * control reads as one that has been used instead of one still waiting to be.
   */
  const stop = () => {
    if (run) void useRunStore.getState().cancel(run.id);
  };

  const dismiss = () => useEditorStore.getState().closePromptPanel();

  // The camera is read for its own sake as much as for the zoom: it is what
  // re-renders the panel as the view moves, since worldToClient answers from the
  // live camera without telling anyone it changed.
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  const nodeWidth = node.bounds.width * zoom;
  // As wide as the node it belongs to asks for, times a little for the words:
  // a panel narrower than its own node reads as belonging to something else.
  // A corner dragged by hand decides instead, since a size taken by hand is a
  // size to keep.
  const naturalWidth = Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, Math.round(nodeWidth * PANEL_WIDTH_FACTOR)),
  );
  // How far the panel reaches past its node on the right. The same distance on
  // the left, so the card stands centred in the panel it is asked from: a
  // panel hanging off one corner reads as belonging to the card beside it, and
  // the words are given the room its own node denies them.
  const overhang = Math.max(0, naturalWidth - Math.round(nodeWidth));
  const width = size?.width ?? naturalWidth + overhang;
  // The node's bottom-left corner, which is where the panel's top-left corner
  // sits — in the world rather than in the view, so the two stay together
  // through a pan, a zoom, and a node dragged to the edge of the canvas.
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

  /**
   * The control that sends the ask, or the one that stops it once it is going.
   *
   * On the prompt page it stands in the field's own corner, where the words
   * are written and where the hand already is; on the pages that hold no
   * field it stays in the head, since a control the reader cannot reach from
   * where they are is a control they have to go looking for.
   */
  const sendButton = going ? (
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
      disabled={busy || refusal !== null}
      onClick={() => void ask()}
      title={refusal ?? undefined}
      type="button"
    >
      {busy ? t("editor:promptPanel.starting") : t("editor:action.run")}
    </button>
  );

  return (
    <div
      aria-label={t("editor:promptPanel.aria", { name: node.title })}
      className="prompt-panel"
      data-testid="prompt-panel"
      ref={panelRef}
      role="group"
      style={style}
    >
      <div className="prompt-panel-head">
        <div
          aria-label={t("editor:promptPanel.sections")}
          className="prompt-panel-tabs"
          role="tablist"
        >
          <button
            aria-selected={tab === "prompt"}
            className={tab === "prompt" ? "is-active" : ""}
            onClick={() => selectTab("prompt")}
            role="tab"
            type="button"
          >
            {t("editor:promptPanel.prompt")}
          </button>
          <button
            aria-selected={tab === "parameter"}
            className={tab === "parameter" ? "is-active" : ""}
            onClick={() => selectTab("parameter")}
            role="tab"
            title={t("editor:promptPanel.parameterHint")}
            type="button"
          >
            {t("editor:promptPanel.parameter")}
          </button>
          <button
            aria-selected={tab === "preview"}
            className={tab === "preview" ? "is-active" : ""}
            onClick={() => selectTab("preview")}
            role="tab"
            title={t("editor:promptPanel.previewHint")}
            type="button"
          >
            {t("editor:promptPanel.preview")}
          </button>
        </div>
        {tab !== "prompt" && sendButton}
        <button
          aria-label={t("editor:promptPanel.close")}
          className="prompt-panel-close"
          onClick={dismiss}
          type="button"
        >
          ✕
        </button>
      </div>

      <div className="prompt-panel-body">
        {tab === "prompt" && (
          <div className="prompt-panel-prompt">
            <MentionField
              canvas={canvas}
              choices={choices}
              corner={sendButton}
              inputRef={areaRef}
              issues={issues}
              key={`prompt-${node.id}`}
              label={t("editor:promptPanel.promptField", {
                name: node.title,
              })}
              offerAtCaret
              onChange={changePrompt}
              onCommit={commitPrompt}
              onDismiss={dismiss}
              onOffer={() => {}}
              onSubmit={() => void ask()}
              placeholder={t("editor:promptPanel.promptPlaceholder")}
              resources={resources}
              // Inside the field's own box rather than after it in the column:
              // the field is what grows with the panel, so a list outside it
              // would be the first thing pushed under the fold.
              under={
                <MentionStrip
                  canvas={canvas}
                  issues={issues}
                  prompt={prompt}
                  resources={resources}
                />
              }
              value={prompt}
            />

            {dangling && (
              <p className="prompt-panel-warn" role="alert">
                {t("editor:promptPanel.danglingMentionPeriod")}
              </p>
            )}

            {counted && (
              <p
                className={
                  over > 0 ? "prompt-panel-count is-over" : "prompt-panel-count"
                }
              >
                {t("editor:promptPanel.counter", {
                  used: prompt.length.toLocaleString(),
                  limit: MAX_PROMPT_LENGTH.toLocaleString(),
                })}
              </p>
            )}

            {noModel ? (
              <div className="prompt-panel-models">
                <p className="prompt-panel-note">
                  {t("editor:promptPanel.noModelPeriod", {
                    kind: t(CAPABILITY_LABELS[asked]).toLowerCase(),
                  })}
                </p>
                <button
                  onClick={() =>
                    // Straight to the category that would serve this node, on
                    // the model it named when that still exists, rather than
                    // to a list to be searched.
                    useModelStore
                      .getState()
                      .openModelForCapability(asked, spec.model || null)
                  }
                  type="button"
                >
                  {t("editor:promptPanel.configureModels")}
                </button>
              </div>
            ) : (
              <ModelPicker
                capability={asked}
                noneLabel={t("editor:promptPanel.providerDefault")}
                onChange={(reference) => commit({ model: reference ?? "" })}
                value={spec.model || null}
              />
            )}

            <ReferenceBar
              canvas={canvas}
              issues={issues}
              key={`refs-${node.id}`}
              node={node}
              onCut={(edge) => disconnectEdge(edge.id)}
              onFind={locate}
              onMove={(edge, portId) => moveInput(edge.id, portId)}
              onPoint={(nodeIds) => commit({ referenceNodeIds: nodeIds })}
              onTakeAsset={(assetId) => void takeAsset(assetId)}
              onTakeFiles={takeFiles}
              resources={resources}
              // The panel's own reading of where the ask takes its inputs
              // from, rather than the document's: the words just changed and
              // the document catches up when something is written.
              spec={{ ...spec, inputMode }}
            />
          </div>
        )}

        {tab === "parameter" && (
          <>
            {videoBlocking && (
              <p
                className="prompt-panel-note"
                data-testid="blocking-reference-note"
                role="status"
              >
                {explicitVideoMode === "auto"
                  ? t("editor:generationParams.blockingAuto")
                  : t("editor:generationParams.blockingReference")}
                {explicitVideoMode === "auto" && (
                  <button
                    className="prompt-panel-link"
                    onClick={() => setParam("mode", "reference")}
                    type="button"
                  >
                    {t("editor:generationParams.useReferenceMode")}
                  </button>
                )}
              </p>
            )}
            <GenerationParams
              capability={asked}
              defaults={view?.preferences ?? null}
              key={node.id}
              onCapabilityChange={
                asked === "speech" || asked === "music"
                  ? switchCapability
                  : undefined
              }
              onChange={setParam}
              params={panelParams}
            />
          </>
        )}

        {tab === "preview" && previewOpen && (
          <InputPreview
            error={previewError}
            preview={preview}
            reading={reading}
            titleOf={(id) => findNode(canvas, id)?.title ?? id}
          />
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
