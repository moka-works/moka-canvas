import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTextStyle,
  type MokaFile,
  type TimelineClip,
  type TimelineDocument,
} from "../../../shared/domain";
import {
  buildTimelineMokaFile,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { useClipStore } from "./clipStore";
import { useTranscribeStore } from "./transcribeStore";

/**
 * The errand from the panel to the cut.
 *
 * What the recognizer answers is a subtitle file measured from the beginning
 * of the audio it was sent, so the two things worth pinning here are the audio
 * it is sent — the clip's own window, not the whole file — and where the words
 * land once they come back.
 */

const ids = timelineIds();
const ask = {
  style: defaultTextStyle(),
  language: "zh",
  speakerLabel: "",
};

/** The cue the recognizer answers with, as an SRT document. */
const SRT = "1\n00:00:00,000 --> 00:00:02,000\nhello\n";

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The fixture cut, with its shot standing where a test wants it. */
function cutWith(over: Partial<TimelineClip> = {}): MokaFile {
  const moka = buildTimelineMokaFile();
  const timeline = moka.timelines?.[0];
  if (!timeline) throw new Error("the fixture has no cut");
  timeline.clips = timeline.clips.map((clip) =>
    clip.id === ids.videoClip ? { ...clip, ...over } : clip,
  );
  return moka;
}

function open(moka: MokaFile, selected: string[] = [], playheadMs = 0): void {
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka,
    selfCheck: { ok: true, issues: [] },
  });
  useClipStore.setState({
    activeTimelineId: ids.timeline,
    selection: { clipIds: selected, transitionId: null },
    playheadMs,
    adjustDraft: null,
    textDraft: null,
  });
}

function cut(): TimelineDocument {
  const timeline = useProjectStore.getState().moka?.timelines?.[0];
  if (!timeline) throw new Error("no cut is open");
  return timeline;
}

function toasts() {
  return useAppStore.getState().toasts;
}

/**
 * A server that takes the ask and then answers the poll the way a test wants.
 *
 * Every request is written down as it arrives, so a test can say what the
 * recognizer was asked about rather than only what came back.
 */
function stubServer(poll: () => Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  const mock = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body;
    sent.push({
      url,
      method: init?.method ?? "GET",
      body: typeof body === "string" ? JSON.parse(body) : undefined,
    });
    if (url.endsWith("/api/v1/generate/asr")) {
      return Promise.resolve(
        json({
          status: "pending",
          outputs: [],
          task: {
            id: "task-1",
            capability: "asr",
            model: "bailian::fun-asr",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      );
    }
    return poll();
  });
  vi.stubGlobal("fetch", mock);
  return sent;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise a test settles by hand, for a server that answers when told to. */
function deferred<T>() {
  let settle: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    settle: (value: T) => settle?.(value),
  };
}

/** The answer a job gives once it is finished. */
function succeeded(): Response {
  return json({ status: "succeeded", text: SRT, outputs: [] });
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useModelStore.setState({ open: false, tab: "text" });
  useTranscribeStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("start", () => {
  it("asks about the clip's own window and lays the words on a new row", async () => {
    // The shot stands two seconds into the cut and reads its own second on.
    open(
      cutWith({
        startMs: 2_000,
        durationMs: 4_000,
        inPointMs: 1_000,
        outPointMs: 5_000,
      }),
      [ids.videoClip],
    );
    const sent = stubServer(() => Promise.resolve(succeeded()));

    await useTranscribeStore.getState().start(ask);

    // What travels is the window, not the file: the whole of a shot that may
    // be an hour long is not what one subtitle was asked for.
    expect(sent[0].url).toBe("/api/v1/generate/asr");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].body).toEqual({
      capability: "asr",
      params: { language: "zh" },
      inputs: [
        {
          role: "controlAudio",
          assetId: ids.videoAsset,
          window: { startMs: 1_000, durationMs: 4_000 },
        },
      ],
    });
    expect(sent[1].url).toBe("/api/v1/generate/tasks/task-1");

    // The cue is measured from the beginning of the audio that was sent, which
    // is a second into the material and two seconds into the cut.
    const after = cut();
    const landed = after.clips.filter((clip) => clip.kind === "text");
    expect(landed).toHaveLength(1);
    expect(landed[0].startMs).toBe(2_000);
    expect(landed[0].durationMs).toBe(2_000);
    expect(landed[0].text?.content).toBe("hello");
    // A row of its own, wherever the first text row already is.
    const holder = after.tracks.find((track) => track.id === landed[0].trackId);
    expect(holder?.kind).toBe("text");
    expect(holder?.id).not.toBe(ids.textTrack);
    // Chosen, so the panel reads the row the words just arrived on.
    expect(useClipStore.getState().selection.clipIds).toEqual([landed[0].id]);
    expect(useTranscribeStore.getState().phase).toBe("idle");
    expect(useTranscribeStore.getState().error).toBeNull();
    expect(toasts().map((toast) => toast.message)).toEqual([
      "1 subtitles written",
    ]);
  });

  it("tells the recognizer what was asked for and nothing else", async () => {
    open(cutWith(), [ids.videoClip]);
    const sent = stubServer(() => Promise.resolve(succeeded()));

    await useTranscribeStore
      .getState()
      .start({ ...ask, language: "", speakerLabel: "Speaker {id}: " });

    // A language left to the recognizer is not sent as one, and the template a
    // diarized sentence is written with is the reader's own words.
    expect(sent[0].body?.params).toEqual({ speakerLabel: "Speaker {id}: " });
  });

  it("does not start a second reading while one is out", async () => {
    open(cutWith(), [ids.videoClip]);
    const poll = deferred<Response>();
    const sent = stubServer(() => poll.promise);

    const first = useTranscribeStore.getState().start(ask);
    await flush();
    expect(useTranscribeStore.getState().phase).toBe("recognizing");
    await useTranscribeStore.getState().start(ask);
    poll.settle(succeeded());
    await first;

    expect(
      sent.filter((each) => each.url.endsWith("/generate/asr")),
    ).toHaveLength(1);
    expect(cut().clips.filter((clip) => clip.kind === "text")).toHaveLength(1);
  });

  it("refuses words about material the clip no longer reads", async () => {
    open(cutWith({ inPointMs: 0, outPointMs: 4_000 }), [ids.videoClip]);
    const poll = deferred<Response>();
    const sent = stubServer(() => poll.promise);

    const running = useTranscribeStore.getState().start(ask);
    await flush();
    // The shot is trimmed while the reading is out, so the times that come
    // back are measured against audio the clip no longer stands for.
    open(cutWith({ inPointMs: 500, outPointMs: 4_000 }), [ids.videoClip]);
    poll.settle(succeeded());
    await running;

    expect(sent).toHaveLength(2);
    expect(useTranscribeStore.getState().error).toBe(
      "The clip was trimmed while it was being recognized, so nothing landed — recognize it again",
    );
    expect(cut().clips.every((clip) => clip.kind !== "text")).toBe(true);
    expect(toasts()).toEqual([]);
  });

  it("sends a reader to the models when none is set up", async () => {
    open(cutWith(), [ids.videoClip]);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          json(
            {
              code: "PROVIDER_NOT_CONFIGURED",
              message: "no default model is set for asr",
              status: 400,
            },
            400,
          ),
        ),
      ),
    );

    await useTranscribeStore.getState().start(ask);

    const [spoken] = toasts();
    expect(spoken.kind).toBe("error");
    // What is wrong, not only that nothing is set up: the server said why, and
    // a reader sent to Settings is owed the reason before they get there.
    expect(spoken.message).toBe(
      "Cannot transcribe yet: no default model is set for asr",
    );
    expect(spoken.choice?.label).toBe("Set up models");
    spoken.choice?.go();
    expect(useModelStore.getState().open).toBe(true);
    expect(useModelStore.getState().tab).toBe("asr");
    // The refusal is a place to go rather than a line to read twice.
    expect(useTranscribeStore.getState().error).toBeNull();
  });

  it("says there is nothing to listen to rather than asking", async () => {
    // Past the end of the only clip, with nothing chosen.
    open(cutWith(), [], 5_000);
    const sent = stubServer(() => Promise.resolve(json({})));

    await useTranscribeStore.getState().start(ask);

    expect(sent).toEqual([]);
    expect(toasts().map((toast) => toast.message)).toEqual([
      "Nothing to recognize — choose a sound or a shot, or move the playhead onto one",
    ]);
  });

  it("carries a failure of the reading itself to the panel", async () => {
    open(cutWith(), [ids.videoClip]);
    stubServer(() =>
      Promise.resolve(
        json(
          {
            code: "PROVIDER_REJECTED",
            message: "the recording could not be uploaded",
            status: 502,
          },
          502,
        ),
      ),
    );

    await useTranscribeStore.getState().start(ask);

    expect(useTranscribeStore.getState().error).toContain(
      "the recording could not be uploaded",
    );
    expect(useTranscribeStore.getState().phase).toBe("idle");
    expect(toasts()).toEqual([]);
  });
});
