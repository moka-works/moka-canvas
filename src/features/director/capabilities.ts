/**
 * What the host can actually do with 3D, asked by trying rather than sniffing.
 *
 * A browser name or a user agent string says nothing about whether a WebView
 * handed this page a WebGL context, whether it can record its canvas, or
 * whether the reader asked for less motion. Each is probed once, kept in
 * memory, and never written to a document.
 */
export interface DirectorCapabilities {
  webgl2: boolean;
  webgl: boolean;
  maxTextureSize: number;
  mediaRecorder: boolean;
  recordingMimeTypes: string[];
  reduceMotion: boolean;
  /** Why no context was handed out, when none was. */
  failure?: string;
}

/** The MIME types a blocking recording is offered, best first. */
export const RECORDING_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/** Whether the viewport can be drawn at all. */
export function canRender3d(capabilities: DirectorCapabilities): boolean {
  return capabilities.webgl2 || capabilities.webgl;
}

/** Whether a blocking reference can be recorded from the canvas. */
export function canRecordCanvas(capabilities: DirectorCapabilities): boolean {
  return (
    capabilities.mediaRecorder && capabilities.recordingMimeTypes.length > 0
  );
}

type ProbeHost = {
  document?: {
    createElement(tag: "canvas"): HTMLCanvasElement;
  };
  matchMedia?: (query: string) => { matches: boolean };
  MediaRecorder?: {
    isTypeSupported?: (type: string) => boolean;
  };
  HTMLCanvasElement?: {
    prototype: { captureStream?: unknown };
  };
};

function context(
  canvas: HTMLCanvasElement,
  kind: "webgl2" | "webgl",
  onFailure: (reason: string) => void,
): WebGLRenderingContext | WebGL2RenderingContext | null {
  try {
    const gl = canvas.getContext(kind, {
      // SwiftShader in a test browser is a legitimate way to run the room;
      // refusing a software renderer would hide the feature there.
      failIfMajorPerformanceCaveat: false,
      antialias: true,
      alpha: false,
    }) as WebGLRenderingContext | WebGL2RenderingContext | null;
    return gl;
  } catch (error) {
    onFailure(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Asks the host for one offscreen context and reports what came back.
 *
 * The context is released straight away: the probe is a question, not the
 * renderer the room will use later, and a left-open probe counts against the
 * handful of contexts a browser allows a page.
 */
export function probeDirectorCapabilities(): DirectorCapabilities {
  const host = globalThis as unknown as ProbeHost;
  const reduceMotion =
    host.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const recorder = host.MediaRecorder;
  const recordingMimeTypes = RECORDING_MIME_TYPES.filter((type) =>
    recorder?.isTypeSupported ? recorder.isTypeSupported(type) : true,
  );
  const mediaRecorder =
    recorder !== undefined &&
    typeof host.HTMLCanvasElement?.prototype.captureStream !== "undefined";
  const base = {
    webgl2: false,
    webgl: false,
    maxTextureSize: 0,
    mediaRecorder: mediaRecorder && recordingMimeTypes.length > 0,
    recordingMimeTypes,
    reduceMotion,
  };

  const page = host.document;
  if (page === undefined) {
    return { ...base, failure: "This host has no document to draw on." };
  }

  const canvas = page.createElement("canvas");
  let contextError = "";
  const noteFailure = (reason: string) => {
    contextError = reason;
  };
  // A browser refuses a context through this event rather than an exception;
  // its status message is the only true reason the host gives.
  const listensForCreation = canvas as HTMLCanvasElement & {
    addEventListener(
      type: "webglcontextcreationerror",
      listener: (event: WebGLContextEvent) => void,
    ): void;
  };
  listensForCreation.addEventListener("webglcontextcreationerror", (event) => {
    noteFailure(event.statusMessage || "The browser did not say why.");
  });

  const gl2 = context(canvas, "webgl2", noteFailure);
  const gl1 = gl2 ? null : context(canvas, "webgl", noteFailure);
  const gl = gl2 ?? gl1;
  const maxTextureSize = gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : 0;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();

  return {
    ...base,
    webgl2: gl2 !== null,
    webgl: gl1 !== null,
    maxTextureSize,
    failure:
      gl === null ? contextError || "No WebGL context was created." : undefined,
  };
}

/**
 * Whether the texture ceiling is low enough to warn about, without blocking.
 *
 * A host under this can still draw the room; it will be slower with large
 * model textures, which is a sentence to show rather than a door to close.
 */
export function lowTextureBudget(capabilities: DirectorCapabilities): boolean {
  return canRender3d(capabilities) && capabilities.maxTextureSize < 4096;
}
