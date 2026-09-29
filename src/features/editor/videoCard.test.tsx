// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  createNode,
  type ResourceEntry,
  type WorkflowNode,
} from "../../shared/domain";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { VideoCardOverlays } from "./components/VideoCardOverlays";
import { useEditorStore } from "./stores/editorStore";
import { useProjectStore } from "./stores/projectStore";

const ids = goldenNodeIds();

const SHOT: ResourceEntry = {
  id: "asset-shot",
  name: "opening.mp4",
  path: "assets/opening.mp4",
  mime: "video/mp4",
  bytes: 40960,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  probe: {
    mime: "video/mp4",
    bytes: 40960,
    sha256: "bb",
    width: 640,
    height: 360,
    durationMs: 4000,
  },
};

function shotNode(): WorkflowNode {
  const node = createNode("video", { x: 40, y: 160 });
  node.id = "node-shot";
  node.title = "Opening shot";
  node.data = { ...node.data, assetId: SHOT.id };
  return node;
}

/** The editor holding one canvas with one video node on it. */
function openCanvas({
  withAsset = true,
  zoom = 1,
}: { withAsset?: boolean; zoom?: number } = {}) {
  const moka = buildGoldenMokaFile();
  if (withAsset) moka.resources.videos.push(SHOT);
  const canvas = moka.canvas.find((entry) => entry.id === ids.canvasMain);
  if (!canvas) throw new Error("the golden fixture has a main canvas");
  canvas.nodes.push(shotNode());
  act(() => {
    useProjectStore.setState({
      moka,
      activeCanvasId: ids.canvasMain,
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
    useEditorStore.setState({
      camera: { x: 0, y: 0, zoom },
      gesture: { kind: "idle" },
    });
  });
}

let play: ReturnType<typeof vi.fn>;

beforeEach(() => {
  play = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: play,
  });
  useProjectStore.setState({
    moka: null,
    activeCanvasId: null,
    selfCheck: null,
  });
  useEditorStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({
    moka: null,
    activeCanvasId: null,
    selfCheck: null,
  });
});

describe("a video on the canvas", () => {
  it("stands on its card as its first frame with a button to start it", () => {
    openCanvas();
    render(<VideoCardOverlays />);

    const face = screen.getByTestId("video-card-face");
    const video = face.querySelector("video");
    expect(video).toBeTruthy();
    // The file itself, read only as far as its header: that is what shows a
    // first frame without playing anything.
    expect(video?.getAttribute("src")).toContain(
      `/api/v1/projects/current/assets/${SHOT.id}`,
    );
    expect(video?.getAttribute("preload")).toBe("metadata");
    // What the project measured about it, where the drawn card cannot say it.
    expect(face.textContent).toContain("640×360 · 0:04");
    expect(
      screen.getByRole("button", { name: "Play Opening shot" }),
    ).toBeTruthy();
  });

  it("plays the file in place once the button is pressed", async () => {
    openCanvas();
    render(<VideoCardOverlays />);
    const video = screen.getByTestId("video-card-face").querySelector("video");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Play Opening shot" }),
      );
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.instances[0]).toBe(video);

    // The file takes over its own face: controls, and the pointer to use them.
    await act(async () => {
      fireEvent.play(video!);
    });
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Play Opening shot" }),
    ).toBeNull();
  });

  it("gives the face back when the file is paused or has run out", async () => {
    openCanvas();
    render(<VideoCardOverlays />);
    const video = screen.getByTestId("video-card-face").querySelector("video");

    await act(async () => {
      fireEvent.play(video!);
    });
    await act(async () => {
      fireEvent.pause(video!);
    });
    expect(
      screen.getByRole("button", { name: "Play Opening shot" }),
    ).toBeTruthy();
  });

  it("leaves a video with no file on this machine to the card", () => {
    openCanvas({ withAsset: false });
    render(<VideoCardOverlays />);
    expect(screen.queryByTestId("video-card-face")).toBeNull();
  });

  it("stands aside where the card itself stops showing media", () => {
    openCanvas({ zoom: 0.2 });
    render(<VideoCardOverlays />);
    expect(screen.queryByTestId("video-card-face")).toBeNull();
  });
});
