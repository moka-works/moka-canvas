import type { InputRole } from "./generate";
import type {
  AssetId,
  CanvasId,
  NodeId,
  RunId,
  RunRecord,
  RunStatus,
  SessionId,
} from "../shared/domain";
import { http, withProject } from "./client";

/**
 * One reference a node will send, described from what the project recorded
 * about the asset rather than from anything the client believes about it.
 */
export interface PreviewInput {
  role: InputRole;
  /** The card this reference is, which is how a reader gets back to the canvas. */
  nodeId: NodeId;
  assetId: AssetId;
  name: string | null;
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /**
   * Set when the asset this names is not there. Nothing is sent for one, and
   * saying so here beats a run tripping over it later.
   */
  missing: boolean;
}

/**
 * What one node will send, answered by the same resolver a run uses.
 *
 * The editor holds the document and could walk the graph itself, but then there
 * would be two answers to what a node feeds the model — the one on screen and
 * the one sent. So the walking happens on the server and this only renders it.
 */
export interface GenerationPreview {
  /** The prompt as a run will send it, upstream text folded in behind labels. */
  prompt: string;
  inputs: PreviewInput[];
  /** Characters cut off the contributing text to stay inside the prompt cap. */
  truncatedChars: number;
  /** Ids named by a mention this canvas has no node for. */
  unresolved: NodeId[];
}

/** Words a run said about one of its nodes as they arrived. */
export interface RunWords {
  nodeId: NodeId;
  /** The slot the words are going to land in. */
  slotId: string;
  text: string;
}

/** What a listener is told, and what to do when the stream stops being one. */
export interface RunListener {
  onWords?: (words: RunWords) => void;
  onEnded: (status: RunStatus) => void;
  /**
   * The stream broke, or there was never a way to hold one open.
   *
   * Nothing was lost but the shortcut. The record is still where the truth is,
   * and a caller that hears this asks for it the way it always did.
   */
  onBroken?: () => void;
}

/**
 * Follows what a run says while it is going, and returns the way to stop.
 *
 * A display's shortcut to the record rather than a source of anything: the
 * closing frame says the run is over and the caller reads the record next,
 * which is the only thing that decides what happened.
 */
function follow(id: RunId, listener: RunListener): () => void {
  // A platform that cannot hold a stream open is not broken, it is a reason to
  // keep asking for the record instead.
  if (typeof EventSource === "undefined") {
    listener.onBroken?.();
    return () => {};
  }

  // An event source sends no header of its own, so the project rides in the
  // address here as it does for a picture.
  const source = new EventSource(
    withProject(`/api/v1/generate/stream?runId=${encodeURIComponent(id)}`),
  );
  const stop = () => source.close();

  const hear = (kind: string, handler: (event: MessageEvent<string>) => void) =>
    source.addEventListener(kind, handler as EventListener);

  hear("delta", (event) => {
    const { nodeId, slotId, text } = JSON.parse(event.data) as RunWords;
    listener.onWords?.({ nodeId, slotId, text });
  });
  hear("done", (event) => {
    const { status } = JSON.parse(event.data) as { status: RunStatus };
    stop();
    listener.onEnded(status);
  });
  // Closed rather than left to reconnect, because a stream that broke is a
  // reason to fall back on the record rather than to keep reopening a door
  // that has just shut.
  source.onerror = () => {
    stop();
    listener.onBroken?.();
  };

  return stop;
}

export const runsApi = {
  list(signal?: AbortSignal): Promise<RunRecord[]> {
    return http.request<RunRecord[]>("/api/v1/projects/current/runs", {
      signal,
    });
  },

  get(id: RunId, signal?: AbortSignal): Promise<RunRecord> {
    return http.request<RunRecord>(`/api/v1/projects/current/runs/${id}`, {
      signal,
    });
  },

  /**
   * `askedBy` is the conversation a run was asked over, when a conversation
   * asked rather than a card wanting something for itself. The record carries
   * it so the answer filed among the assets can say whose it is.
   */
  start(
    canvasId: CanvasId,
    nodeIds: NodeId[],
    askedBy?: SessionId,
  ): Promise<RunRecord> {
    return http.request<RunRecord>("/api/v1/projects/current/runs", {
      method: "POST",
      body: { canvasId, nodeIds, assistantSessionId: askedBy },
    });
  },

  cancel(id: RunId): Promise<RunRecord> {
    return http.request<RunRecord>(
      `/api/v1/projects/current/runs/${id}/cancel`,
      { method: "POST" },
    );
  },

  retry(id: RunId): Promise<RunRecord> {
    return http.request<RunRecord>(
      `/api/v1/projects/current/runs/${id}/retry`,
      { method: "POST" },
    );
  },

  /** What one node will send, resolved the way a run resolves it. */
  preview(
    canvasId: CanvasId,
    nodeId: NodeId,
    signal?: AbortSignal,
  ): Promise<GenerationPreview> {
    return http.request<GenerationPreview>(
      "/api/v1/projects/current/generate/preview",
      { method: "POST", body: { canvasId, nodeId }, signal },
    );
  },

  follow,
};
