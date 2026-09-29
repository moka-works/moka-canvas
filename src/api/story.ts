import type { AssetId, Capability, IsoTimestamp } from "../shared/domain";
import type { InputRole } from "./generate";
import { http } from "./client";

/**
 * A batch of generations, as the client and the server say it between them.
 *
 * The shapes here are the server's record verbatim, because they are read as
 * one: a batch is what the room watches, what it applies, and what it reads
 * again after a restart. Nothing here names a provider field.
 */
export type StoryJobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type StoryJobKind =
  | "outline"
  | "elements"
  | "storyboard"
  | "elementArt"
  | "keyframeArt"
  | "actVideo"
  | "keyframeVideo"
  | "voice"
  | "music";

export type StoryArtView = "main" | "turnaround";

/**
 * The place in a story a piece is being made for.
 *
 * The same vocabulary a command files an answer with, so an answer knows where
 * it goes without either side reading the document.
 */
export type StoryTarget =
  | { kind: "outline" }
  | { kind: "elements" }
  | { kind: "storyboard"; chapterId: string }
  | { kind: "elementArt"; elementId: string; view: StoryArtView }
  | {
      kind: "keyframeArt";
      chapterId: string;
      actId: string;
      keyframeId: string;
    }
  | { kind: "actVideo"; chapterId: string; actId: string }
  | {
      kind: "keyframeVideo";
      chapterId: string;
      actId: string;
      keyframeId: string;
    }
  /** One act's lines read aloud, in a single voice for the whole act. */
  | { kind: "voice"; chapterId: string; actId: string }
  /** One line of dialogue read on its own, in the voice its speaker has. */
  | {
      kind: "lineVoice";
      chapterId: string;
      actId: string;
      keyframeId: string;
      lineId: string;
    }
  /** One act's music and sound, under the words and the pictures. */
  | { kind: "music"; chapterId: string; actId: string };

export interface StoryJobInput {
  role: InputRole;
  assetId: AssetId;
}

export interface StoryJobItem {
  id: string;
  target: StoryTarget;
  capability: Capability;
  prompt: string;
  /** The standing instruction a written answer is asked under. */
  system?: string;
  inputs: StoryJobInput[];
  params: Record<string, unknown>;
  status: StoryJobStatus;
  /** What a text piece was answered with, kept whole for a reader to repair. */
  text?: string;
  assetIds?: AssetId[];
  /** The provider's handle for a shot still being filmed. */
  taskId?: string;
  progress?: number;
  error?: string;
  /**
   * What kind of trouble it was and the values behind it — which model, which
   * capability — so the same failure can be said in the reader's own language.
   */
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  /** Whether asking again, as things stand, is worth doing. */
  retryable?: boolean;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
}

export interface StoryJobRecord {
  id: string;
  projectId: string;
  storyId: string;
  kind: StoryJobKind;
  status: StoryJobStatus;
  /** The model this batch resolved to, for a reader reading the record later. */
  model: string;
  items: StoryJobItem[];
  error?: string;
  cancelRequested: boolean;
  /**
   * When the room read this batch's answer into its story, if it has.
   *
   * An answer whose record carries this is in the document and is never
   * written in again: what the reader has said to the story since stands over
   * what the answer said, which is the whole point of writing it down.
   */
  readAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * One piece as it is asked for.
 *
 * The id is the client's to choose and is what an answer is recognised by when
 * it is applied, so it is the target's own name ({@link targetKey}) rather than
 * a running number: an answer that arrives twice lands in the same place twice.
 */
export type StoryJobItemDraft = Pick<
  StoryJobItem,
  "id" | "target" | "capability" | "prompt"
> &
  Partial<Pick<StoryJobItem, "inputs" | "params" | "system">>;

const jobsPath = "/api/v1/projects/current/story/jobs";

export const storyApi = {
  /**
   * Starts a batch of one kind.
   *
   * The model is the room's own choice, when it has one: a reference names a
   * model configuration, and none leaves the deployment's default to answer —
   * which for a score is the music model rather than the voice one.
   */
  start(
    storyId: string,
    kind: StoryJobKind,
    items: StoryJobItemDraft[],
    model?: string | null,
    signal?: AbortSignal,
  ): Promise<StoryJobRecord> {
    return http.request<StoryJobRecord>(jobsPath, {
      method: "POST",
      body: { storyId, kind, items, model: model ?? null },
      signal,
    });
  },

  list(storyId?: string, signal?: AbortSignal): Promise<StoryJobRecord[]> {
    const query =
      storyId === undefined ? "" : `?storyId=${encodeURIComponent(storyId)}`;
    return http.request<StoryJobRecord[]>(`${jobsPath}${query}`, { signal });
  },

  get(id: string, signal?: AbortSignal): Promise<StoryJobRecord> {
    return http.request<StoryJobRecord>(
      `${jobsPath}/${encodeURIComponent(id)}`,
      {
        signal,
      },
    );
  },

  /**
   * Asks a batch to stop. The answer is the record as it stands: one being
   * driven says the request was heard rather than that it is over.
   */
  cancel(id: string): Promise<StoryJobRecord> {
    return http.request<StoryJobRecord>(
      `${jobsPath}/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
    );
  },

  /**
   * Says a batch's answer has been read into its story.
   *
   * The room does this once the batch has settled and what it answered is
   * really in the document, and every room opened afterwards reads it and
   * leaves that answer alone. A batch still being driven is answered as it
   * stands and not written down: its pieces are still to come.
   */
  readIn(id: string): Promise<StoryJobRecord> {
    return http.request<StoryJobRecord>(
      `${jobsPath}/${encodeURIComponent(id)}/read`,
      { method: "POST" },
    );
  },
};
