import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

/**
 * Where the stand-in provider listens.
 *
 * A fixed port rather than one chosen as it binds: the server under test is
 * booted by the runner before any test could say where a channel should point,
 * and the address ends up typed into a dialog by a browser. It follows the
 * app's port by default so that one `MOKA_E2E_PORT` moves a whole isolated
 * run off the default pair, and can be pinned on its own when needed.
 */
export const PROVIDER_PORT = Number(
  process.env.MOKA_E2E_PROVIDER_PORT ??
    Number(process.env.MOKA_E2E_PORT ?? 8971) + 1,
);
/** Where the stand-in's own bookkeeping routes are, beside the ones it serves. */
export const PROVIDER_ORIGIN = `http://127.0.0.1:${PROVIDER_PORT}`;
export const PROVIDER_ADDRESS = `${PROVIDER_ORIGIN}/v1`;

/** The models on offer, one per capability the suite drives. */
export const PAINTER = "painter";
export const STORYTELLER = "storyteller";
export const VIDEOGRAPHER = "videographer";
export const SPEAKER = "speaker";
export const READER = "reader";
export const MUSICIAN = "musician";

/**
 * What the stand-in says, whole and in the pieces it arrives in.
 *
 * MOKA_E2E_TEXT swaps in another sentence — the website screenshot capture is
 * the only caller — and the default the tests assert against is untouched by it.
 */
export const SENTENCE =
  process.env.MOKA_E2E_TEXT ?? "A lantern drifts over a quiet lake.";
const PIECES = (() => {
  if (!process.env.MOKA_E2E_TEXT) {
    return ["A lantern ", "drifts over ", "a quiet lake."];
  }
  const third = Math.ceil(SENTENCE.length / 3);
  return [
    SENTENCE.slice(0, third),
    SENTENCE.slice(third, third * 2),
    SENTENCE.slice(third * 2),
  ];
})();

/**
 * One 1x1 transparent PNG, which is all an ingest path needs to be real.
 *
 * MOKA_E2E_PICTURE points at a picture the stand-in should paint with instead —
 * the website screenshot capture is the only caller, and the default the tests
 * run against is untouched by it.
 */
const PICTURE = (() => {
  const custom = process.env.MOKA_E2E_PICTURE;
  if (!custom) {
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  }
  return readFileSync(custom).toString("base64");
})();

/**
 * The one-second shot the stand-in hands back when it is asked for a clip.
 *
 * A video endpoint answers with a job rather than with the bytes: the job is
 * started, polled, and collected from a third route, so a stand-in that only
 * spoke the first of the three would leave every clip hanging.
 */
const SHOT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shot.mp4"),
).toString("base64");
/** The handle the one job the stand-in ever starts is polled by. */
const SHOT_JOB = "video-job-1";

/**
 * One second of sound, written as a real WAV.
 *
 * A speech endpoint answers with the bytes themselves rather than with a job,
 * so this is the whole of the stand-in's part in making a voice. It is a real
 * WAV rather than bytes with the right header, because the shelf measures what
 * it files — a take nobody can read the length of is not one that can be laid
 * on a track.
 */
function wav(seconds: number): Buffer {
  const sampleRate = 8_000;
  const dataSize = sampleRate * seconds;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize, 128)]);
}

/**
 * The stand-in's part in making a voice: a known length, so a test can say
 * where a line lands on a timeline and how fast it had to be read to get
 * there. A voice named "long" reads for four seconds; every other voice reads
 * for one, which is what a telling whose characters were never given voices
 * gets.
 */
export function spokenSeconds(voice: unknown): number {
  return voice === "long" ? 4 : 1;
}

/** What the stand-in was asked for, holding nothing a credential could be in. */
export interface ProviderCall {
  path: string;
  model: string;
  prompt: string;
  /**
   * The voice a speech ask named. A cloned voice has no name to send, so the
   * converter puts the reference recording's file name here instead, which is
   * how a spec reads which recording the ask carried.
   */
  voice: string;
  count: number;
  /** Whether a request arrived carrying a credential, never what it was. */
  credentialed: boolean;
}

export interface MockProvider {
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((whole, failed) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => whole(Buffer.concat(chunks).toString("utf8")));
    request.on("error", failed);
  });
}

/** The last thing said to a chat endpoint, which is where its prompt travels. */
function lastMessage(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const content = (messages[messages.length - 1] as { content?: unknown })
    ?.content;
  return typeof content === "string" ? content : "";
}

/**
 * One field of a multipart body, read as text.
 *
 * An image ask that carries a picture — a character's turn-around is drawn
 * from the main picture already on file — is sent as a multipart edit rather
 * than as json, so the stand-in reads the prompt out of the part it travels in
 * instead of the body. What it does with the part is answer with the picture,
 * which is all any test asserts.
 */
function partOf(raw: string, name: string): string {
  const at = raw.indexOf(`name="${name}"`);
  if (at === -1) return "";
  const after = raw.slice(at);
  const start = after.indexOf("\r\n\r\n");
  if (start === -1) return "";
  const rest = after.slice(start + 4);
  const end = rest.indexOf("\r\n--");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** Writes an answer as a server-sent stream, a piece at a time. */
async function streamText(
  response: ServerResponse,
  answers: boolean,
  answer: { text: string; pieces: string[] } = {
    text: SENTENCE,
    pieces: PIECES,
  },
) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const write = (frame: unknown) =>
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  for (const piece of answer.pieces) {
    write(
      answers
        ? { type: "response.output_text.delta", delta: piece }
        : { choices: [{ delta: { content: piece } }] },
    );
    // Held apart so the stream is one a listener can hear arriving rather than
    // a single write that happens to be chunked.
    await sleep(40);
  }
  write(
    answers
      ? {
          type: "response.completed",
          response: {
            output_text: answer.text,
            usage: { input_tokens: 4, output_tokens: 6 },
          },
        }
      : {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        },
  );
  write("[DONE]");
  response.end();
}

/** A text cut into the pieces it arrives in, so an answer streams either way. */
function inPieces(text: string): { text: string; pieces: string[] } {
  const third = Math.ceil(text.length / 3);
  return {
    text,
    pieces: [
      text.slice(0, third),
      text.slice(third, third * 2),
      text.slice(third * 2),
    ],
  };
}

/**
 * What an ask that wants json is answered with, or none when it wants words.
 *
 * The story room asks for the chapters of a telling as a table, with the count
 * it wants in the ask, and for a manuscript's part as one chapter of one. A
 * real model writes them; what the suite has to prove is that an answer in
 * that shape arrives, is read, and lands in the story — so the stand-in
 * answers in the shape the prompt asked for.
 */
function jsonAnswer(prompt: string): string | undefined {
  const table = /as (\d+) chapters/.exec(prompt);
  if (table !== null) {
    const count = Math.max(1, Number(table[1]));
    return JSON.stringify({
      chapters: Array.from({ length: count }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        synopsis: `What happens in chapter ${index + 1} of the telling.`,
      })),
    });
  }
  const part = /Part (\d+) of (\d+)/.exec(prompt);
  if (part !== null) {
    return JSON.stringify({
      title: `Chapter ${part[1]}`,
      synopsis: `What happens in part ${part[1]} of the manuscript.`,
    });
  }
  // One episode's board: two acts of two shots each, with the cast the
  // elements answer above gives the story — a board naming anyone else would
  // be a board whose references the reading drops. The names a shot is drawn
  // from are written in backticks, the way the prompt asks for them: a mention
  // is the picture that travels with the shot's ask.
  if (prompt.includes("Board this chapter as acts")) {
    return JSON.stringify({
      acts: [
        {
          title: "The platform",
          summary: "She waits under the one lamp still burning.",
          characters: ["Keeper", "Traveller"],
          scene: "Last carriage",
          props: [],
          sound: { music: "low strings", sfx: "rain", ambience: "empty hall" },
          keyframes: [
            {
              shotSize: "wide",
              cameraMove: "pushIn",
              angle: "eyeLevel",
              content: "Rain over the platform, `Keeper` under the lamp.",
              durationMs: 3_000,
              dialogue: [
                { speaker: "Keeper", text: "It stopped running years ago." },
              ],
            },
            {
              shotSize: "close",
              cameraMove: "static",
              angle: "overTheShoulder",
              content: "`Traveller` turns.",
              durationMs: 2_000,
              dialogue: [{ speaker: "Traveller", text: "Then we walk." }],
            },
          ],
        },
        {
          title: "The last carriage",
          summary: "The doors close on both of them.",
          characters: ["Traveller"],
          scene: "Last carriage",
          props: ["Old ticket"],
          sound: { music: "", sfx: "door chime", ambience: "carriage hum" },
          keyframes: [
            {
              shotSize: "medium",
              cameraMove: "handheld",
              angle: "low",
              content: "The `Old ticket` is held up to the light.",
              durationMs: 2_000,
              dialogue: [],
            },
          ],
        },
      ],
    });
  }
  // The cast of a telling, asked for by the chapters it stands in.
  if (prompt.includes("List what this telling is made of")) {
    return JSON.stringify({
      characters: [
        {
          name: "Keeper",
          description: "A woman in a grey coat, slow to speak.",
          chapters: [1],
        },
        {
          name: "Traveller",
          description: "Young, carrying a worn satchel.",
          chapters: [1, 2],
        },
      ],
      scenes: [
        {
          name: "Last carriage",
          description: "An empty carriage, lights flickering.",
          chapters: [1],
        },
      ],
      props: [
        {
          name: "Old ticket",
          description: "A cardboard ticket, corners rounded.",
          chapters: [2],
        },
      ],
    });
  }
  return undefined;
}

/**
 * A provider that answers without being one.
 *
 * What the suite has to prove is the whole path: a node's spec, a run, a call
 * out, an answer filed as an asset, and the panel that shows it. The part a
 * real provider contributes to that is only "an answer arrives in this shape",
 * so serving the shape locally leaves everything else the real thing.
 */
export async function startMockProvider(): Promise<MockProvider> {
  const calls: ProviderCall[] = [];

  const server = createServer((request, response) => {
    void answer(request, response);
  });

  async function answer(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(
      request.url ?? "/",
      `http://127.0.0.1:${PROVIDER_PORT}`,
    ).pathname;
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      });
      response.end(payload);
    };
    const missing = () =>
      send(404, {
        error: { message: `the stand-in has no route for ${path}` },
      });

    if (path === "/__calls" && request.method === "GET") {
      return send(200, { calls });
    }
    if (path === "/__reset" && request.method === "POST") {
      calls.length = 0;
      return send(200, { ok: true });
    }
    // A clip is asked for as a job: started, looked at, then collected. The
    // stand-in's job is over before the first look, which is what "succeeded"
    // says; the bytes are served from the third route.
    if (path === `/v1/videos/${SHOT_JOB}` && request.method === "GET") {
      return send(200, { id: SHOT_JOB, status: "succeeded" });
    }
    if (path === `/v1/videos/${SHOT_JOB}/content` && request.method === "GET") {
      const bytes = Buffer.from(SHOT, "base64");
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.length),
      });
      return response.end(bytes);
    }
    // A song travels the other way round from a clip: the composition answers
    // with a link, and the link is what the runtime fetches next. Both halves
    // are served here, so the second request is a real one.
    if (path === "/song.mp3" && request.method === "GET") {
      const bytes = wav(1);
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
      });
      return response.end(bytes);
    }
    if (request.method !== "POST") return missing();

    const raw = await bodyOf(request);
    const multipart = String(request.headers["content-type"] ?? "").startsWith(
      "multipart/form-data",
    );
    let body: Record<string, unknown> = {};
    if (!multipart) {
      try {
        body =
          raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        return send(400, { error: { message: "the request was not JSON" } });
      }
    }
    // What was asked, whichever of the three shapes the ask arrived in: words
    // of their own, a conversation's last message, or the words a voice reads
    // — which is what a speech ask carries them in.
    const prompt = multipart
      ? partOf(raw, "prompt")
      : String(body.prompt ?? "") ||
        lastMessage(body) ||
        String(body.input ?? "");
    calls.push({
      path,
      model: multipart ? "" : String(body.model ?? ""),
      prompt,
      voice: multipart ? "" : String(body.voice ?? ""),
      count: multipart ? 1 : Number(body.n ?? 1),
      credentialed: Boolean(request.headers.authorization),
    });

    // A marker word in a prompt is a direction to the stand-in rather than part
    // of it: refuse, so that a run which gave up exists to be looked at.
    // MOKA_E2E_REFUSAL_STATUS and MOKA_E2E_REFUSAL_MESSAGE swap in another
    // refusal — the website screenshot capture is the only caller — and the
    // defaults the tests assert against are untouched by them.
    if (prompt.includes("[refuse]")) {
      return send(Number(process.env.MOKA_E2E_REFUSAL_STATUS ?? 500), {
        error: {
          message:
            process.env.MOKA_E2E_REFUSAL_MESSAGE ??
            "the stand-in will not paint that",
        },
      });
    }

    if (path === "/v1/images/generations" || path === "/v1/images/edits") {
      const count = multipart ? 1 : Math.max(1, Number(body.n ?? 1));
      return send(200, {
        created: 1700000000,
        data: Array.from({ length: count }, () => ({
          b64_json: PICTURE,
          revised_prompt: prompt,
        })),
      });
    }
    if (path === "/v1/videos") {
      return send(200, { id: SHOT_JOB, status: "queued" });
    }
    // A voice or a score: the answer is the sound itself, not an answer about
    // where the sound is. How long it reads for is the voice's own business,
    // so a test can tell one character's reading from another's.
    if (path === "/v1/audio/speech") {
      const bytes = wav(spokenSeconds(body.voice));
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
      });
      return response.end(bytes);
    }
    // A song is asked for at a music service's own address, and the answer
    // names the song rather than carrying it.
    if (path === "/api/v1/services/audio/music/generation") {
      const host = request.headers.host ?? "127.0.0.1";
      return send(200, {
        output: {
          audio: { url: `http://${host}/song.mp3?sig=stand-in` },
          extra_info: { channels: 2, sample_rate: 48000 },
          finish_reason: "stop",
        },
        usage: { duration: 1 },
      });
    }
    if (path === "/v1/chat/completions") {
      const json = jsonAnswer(prompt);
      if (body.stream !== true) {
        return send(200, {
          choices: [
            {
              message: { role: "assistant", content: json ?? SENTENCE },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        });
      }
      return streamText(
        response,
        false,
        json === undefined ? undefined : inPieces(json),
      );
    }
    if (path === "/v1/responses") {
      const json = jsonAnswer(prompt);
      return streamText(
        response,
        true,
        json === undefined ? undefined : inPieces(json),
      );
    }
    return missing();
  }

  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(PROVIDER_PORT, "127.0.0.1", listening);
  });

  return {
    stop: () =>
      new Promise<void>((stopped) => {
        server.closeAllConnections();
        server.close(() => stopped());
      }),
  };
}
