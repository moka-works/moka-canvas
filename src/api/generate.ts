import type { AssetId, Capability, IsoTimestamp } from "../shared/domain";
import { ApiError, http, projectHeaders, readProblem } from "./client";

/**
 * Why a piece of media travels with a request. The role, not the mime type,
 * decides what a provider is asked to do with it.
 */
export type InputRole =
  | "reference"
  | "firstFrame"
  | "lastFrame"
  | "mask"
  | "controlVideo"
  | "controlAudio";

export interface GenerateInput {
  role: InputRole;
  assetId: AssetId;
  /**
   * The part of the asset this reference means, when it means a part of one.
   *
   * A timeline clip reads a window of the file it points at, and a window is
   * what gets sent: the whole of a two-hour recording is not what a subtitle
   * for one of its minutes was asked for.
   */
  window?: { startMs: number; durationMs: number };
}

/**
 * One generation, in this project's words. Nothing here names a provider
 * field, and nothing a provider says about itself comes back either.
 */
export interface GenerateRequest {
  capability: Capability;
  /** A model configuration id; empty means the default for the capability. */
  model?: string;
  prompt?: string;
  /** An instruction that frames the prompt rather than forming part of it. */
  system?: string | null;
  /** Already merged by the caller: a node's own parameters over the globals. */
  params?: Record<string, unknown>;
  inputs?: GenerateInput[];
}

/**
 * One thing a provider made. The bytes travel encoded because nothing is
 * stored until a run adopts the answer.
 */
export interface GeneratedOutput {
  kind: Capability;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Base64 of `bytes` bytes. */
  data: string;
}

/**
 * The handle a job is polled with. The provider's own identifier for the job
 * never crosses this boundary.
 */
export interface TaskHandle {
  id: string;
  capability: Capability;
  model: string;
  createdAt: IsoTimestamp;
  /** What the provider asked for; absent means poll at your own pace. */
  retryAfterMs?: number;
}

/** For display and statistics only; nothing decides based on it. */
export interface GenerationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  images: number | null;
  seconds: number | null;
}

/**
 * `pending` only for a capability that runs as an upstream job, where `task`
 * carries the handle and `outputs` is empty.
 */
export interface GenerateResponse {
  status: "succeeded" | "pending";
  text?: string;
  outputs: GeneratedOutput[];
  task?: TaskHandle;
  usage?: GenerationUsage;
}

/** The error a stream reports in its closing frame. */
interface StreamError {
  code: string;
  message: string;
  retryable: boolean;
}

interface ClosingFrame {
  error?: StreamError;
}

function path(capability: Capability): string {
  return `/api/v1/generate/${capability}`;
}

/**
 * One server-sent event, or null for anything that is not a complete frame.
 *
 * A frame ends at a blank line; the data is compact JSON on one line, so a
 * newline inside it would have ended the frame early.
 */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trim());
    }
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/**
 * A written answer sent as it arrives.
 *
 * The caller sees each piece through `onDelta` and gets the whole answer back
 * at the end, because what is stored is the aggregate rather than the pieces
 * it was displayed as. A stream always answers 200 once it has opened, so a
 * failure arrives in the closing frame and is raised here as the same error
 * every other call raises.
 */
async function streamText(
  request: GenerateRequest,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  let response: Response;
  try {
    response = await fetch(path("text"), {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...projectHeaders() },
      body: JSON.stringify({
        ...request,
        capability: "text",
        params: { ...request.params, stream: true },
      }),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    const cause = (error as Error).message;
    throw ApiError.transport(`Cannot reach the local process: ${cause}`, cause);
  }

  if (!response.ok || !response.body) {
    // The body is a problem like any other, and the reason in it is the whole
    // of what this stream ever got to hear.
    const refused = await readProblem(response);
    throw refused ?? ApiError.parse(response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closing: GenerateResponse | null = null;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = parseFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (!frame) continue;

      if (frame.event === "delta") {
        const delta = JSON.parse(frame.data) as { text?: string };
        if (delta.text) onDelta?.(delta.text);
        continue;
      }
      if (frame.event === "done") {
        const done = JSON.parse(frame.data) as ClosingFrame & GenerateResponse;
        if (done.error) {
          throw new ApiError({
            code: done.error.code,
            message: done.error.message,
            // A stream has no status left to carry, so the frame says it.
            status: 0,
            details: { retryable: done.error.retryable },
          });
        }
        closing = done;
      }
    }
  }

  if (!closing) {
    throw ApiError.transport("The stream ended before the answer did");
  }
  return closing;
}

export const generateApi = {
  text(request: GenerateRequest, signal?: AbortSignal) {
    return http.request<GenerateResponse>(path("text"), {
      method: "POST",
      body: request,
      signal,
    });
  },

  textStream(
    request: GenerateRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ) {
    return streamText(request, onDelta, signal);
  },

  image(request: GenerateRequest, signal?: AbortSignal) {
    return http.request<GenerateResponse>(path("image"), {
      method: "POST",
      body: request,
      signal,
    });
  },

  speech(request: GenerateRequest, signal?: AbortSignal) {
    return http.request<GenerateResponse>(path("speech"), {
      method: "POST",
      body: request,
      signal,
    });
  },

  music(request: GenerateRequest, signal?: AbortSignal) {
    return http.request<GenerateResponse>(path("music"), {
      method: "POST",
      body: request,
      signal,
    });
  },

  /** Starts a shot rather than waiting it out; poll the handle it returns. */
  video(request: GenerateRequest, signal?: AbortSignal) {
    return http.request<GenerateResponse>(path("video"), {
      method: "POST",
      body: request,
      signal,
    });
  },

  /**
   * Starts the reading of a recording rather than waiting it out.
   *
   * A job like a shot: an hour of speech takes minutes to recognize, and the
   * request carries the audio itself. What the handle answers with is the
   * transcript, in `text`.
   */
  asr(request: GenerateRequest, signal?: AbortSignal) {
    return http.request<GenerateResponse>(path("asr"), {
      method: "POST",
      body: request,
      signal,
    });
  },

  pollTask(id: string, signal?: AbortSignal) {
    return http.request<GenerateResponse>(
      `/api/v1/generate/tasks/${encodeURIComponent(id)}`,
      { signal },
    );
  },
};
