// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  AssetId,
  CanvasDocument,
  GenerationInputMode,
  GenerationSpec,
  NodeId,
  ResourceEntry,
  WorkflowEdge,
  WorkflowNode,
} from "../../shared/domain";
import {
  createCanvas,
  createNode,
  defaultGenerationSpec,
} from "../../shared/domain";
import { ReferenceBar } from "./components/ReferenceBar";
import { ASSET_DRAG_MIME } from "./interactions/actions";

const T = "2026-01-01T00:00:00.000Z";

function card(
  kind: WorkflowNode["kind"],
  id: string,
  title: string,
  data: Record<string, unknown> = {},
): WorkflowNode {
  const made = createNode(kind, { x: 0, y: 0 });
  made.id = id;
  made.title = title;
  made.data = { ...made.data, ...data };
  return made;
}

function wire(
  from: string,
  to: string,
  id: string,
  portId = "prompt",
): WorkflowEdge {
  return {
    id,
    source: { nodeId: from, portId: "out" },
    target: { nodeId: to, portId },
    createdAt: T,
  };
}

function sheet(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
): CanvasDocument {
  const made = createCanvas("Canvas");
  made.nodes = nodes;
  made.edges = edges;
  return made;
}

/** A card that can be asked for something, and so has a panel to be given in. */
function asked(
  kind: "image" | "video" | "audio" | "text",
  id: string,
  title: string,
): WorkflowNode {
  const made = card(kind, id, title);
  const spec = defaultGenerationSpec(kind);
  if (!spec) throw new Error(`${kind} is a kind that can be asked`);
  made.data = { ...made.data, generation: spec };
  return made;
}

const PICTURE: ResourceEntry = {
  id: "asset-1",
  name: "lantern.png",
  path: "assets/images/lantern.png",
  mime: "image/png",
  bytes: 20480,
  createdAt: T,
  updatedAt: T,
  probe: {
    mime: "image/png",
    bytes: 20480,
    sha256: "aa",
    width: 512,
    height: 512,
  },
};

const RECORDING: ResourceEntry = {
  id: "asset-voice",
  name: "voice.wav",
  path: "assets/audios/voice.wav",
  mime: "audio/wav",
  bytes: 40960,
  createdAt: T,
  updatedAt: T,
};

const RESOURCES = new Map<AssetId, ResourceEntry>([
  [PICTURE.id, PICTURE],
  [RECORDING.id, RECORDING],
]);
const ISSUES = new Map<AssetId, "missing">();

const BRIEF = card("text", "n-brief", "Brief", {
  content: "A lantern floats over a quiet lake at dusk.",
});
const PLATE = card("image", "n-plate", "Plate", { assetId: PICTURE.id });
const SHOT = card("image", "n-shot", "Shot", { assetId: PICTURE.id });
const TARGET = asked("image", "n-target", "Target");
const FILM = asked("video", "n-film", "Film");
const VOICE = card("audio", "n-voice", "Voice", { assetId: RECORDING.id });
const SPEAKER = asked("audio", "n-speaker", "Speaker");

/** Two arrivals at the target: words on its prompt, a picture on its images. */
const SHEET = sheet(
  [BRIEF, PLATE, SHOT, TARGET, FILM],
  [
    wire("n-brief", "n-target", "e-words"),
    wire("n-plate", "n-target", "e-picture", "images"),
  ],
);

const cut = vi.fn();
const find = vi.fn();
const move = vi.fn();
const point = vi.fn();
const tookAsset = vi.fn();
const tookFiles = vi.fn();

function Bar({
  canvas = SHEET,
  inputMode = "upstream",
  node = TARGET,
  referenceNodeIds = [],
}: {
  canvas?: CanvasDocument;
  inputMode?: GenerationInputMode;
  node?: WorkflowNode;
  referenceNodeIds?: NodeId[];
}) {
  const stored = (node.data as { generation?: GenerationSpec }).generation;
  if (!stored) throw new Error("a node with a panel has a spec");
  return (
    <ReferenceBar
      canvas={canvas}
      issues={ISSUES}
      node={node}
      onCut={cut}
      onFind={find}
      onMove={move}
      onPoint={point}
      onTakeAsset={tookAsset}
      onTakeFiles={tookFiles}
      resources={RESOURCES}
      spec={{ ...stored, inputMode, referenceNodeIds }}
    />
  );
}

function bar() {
  return screen.getByTestId("reference-bar");
}

function rows() {
  return within(bar()).getAllByRole("listitem");
}

/** Something being dragged from the resource panel, which is an asset id. */
function carrying(assetId: string | null) {
  return {
    dataTransfer: {
      getData: (type: string) =>
        assetId !== null && type === ASSET_DRAG_MIME ? assetId : "",
      types: assetId === null ? ["text/plain"] : [ASSET_DRAG_MIME],
    },
  };
}

/** Files being dragged from this machine, which is what Finder drags carry. */
function carryingFiles(files: File[]) {
  return {
    dataTransfer: {
      getData: () => "",
      files,
      types: ["Files"],
    },
  };
}

const FILE = new File(["x"], "lantern.png", { type: "image/png" });

beforeEach(() => {
  for (const spy of [cut, find, move, point, tookAsset, tookFiles]) {
    spy.mockClear();
  }
});

afterEach(cleanup);

describe("what is wired in", () => {
  it("is read off the graph, in the order the document holds it", () => {
    render(<Bar />);
    const [words, picture] = rows();
    expect(words.textContent).toContain("Brief");
    expect(words.textContent).toContain("Prompt");
    expect(picture.textContent).toContain("Plate");
    expect(picture.textContent).toContain("Images");
  });

  it("says so when nothing is", () => {
    render(<Bar canvas={sheet(SHEET.nodes)} />);
    expect(bar().textContent).toContain("Nothing is wired into this node yet");
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("hands back the edge that is to be taken out", () => {
    render(<Bar />);
    fireEvent.click(
      within(rows()[0]).getByRole("button", {
        name: "Disconnect Brief from Target",
      }),
    );
    expect(cut).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-words" }),
    );
  });

  it("hands back the node that is to be brought into view", () => {
    render(<Bar />);
    fireEvent.click(
      within(rows()[1]).getByRole("button", {
        name: "Find Plate on the canvas",
      }),
    );
    expect(find).toHaveBeenCalledWith("n-plate");
  });

  it("offers a picture as the mask of the picture being painted over", () => {
    render(<Bar />);
    const [words, picture] = rows();
    // Words have nowhere else to go on this node, and are not offered a move.
    expect(
      within(words).queryByRole("button", { name: /^Use Brief as/ }),
    ).toBeNull();
    fireEvent.click(
      within(picture).getByRole("button", { name: "Use Plate as the mask" }),
    );
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-picture" }),
      "mask",
    );
  });

  it("offers a picture as either frame of a shot", () => {
    const filmed = sheet(SHEET.nodes, [
      wire("n-shot", "n-film", "e-opening", "firstFrame"),
      wire("n-plate", "n-film", "e-subject", "images"),
    ]);
    render(<Bar canvas={filmed} node={FILM} />);
    const [opening, subject] = rows();
    expect(opening.textContent).toContain("First frame");
    fireEvent.click(
      within(subject).getByRole("button", {
        name: "Use Plate as the last frame",
      }),
    );
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-subject" }),
      "lastFrame",
    );
  });

  it("shows a recording wired into the sound card's audio input", () => {
    const spoken = sheet(
      [VOICE, SPEAKER],
      [wire("n-voice", "n-speaker", "e-voice", "audio")],
    );
    render(<Bar canvas={spoken} node={SPEAKER} />);
    const [recording] = rows();
    expect(recording.textContent).toContain("Voice");
    expect(recording.textContent).toContain("Audio");
  });
});

describe("where the ask takes what it is given from", () => {
  it("is not a choice on the bar: the fold beside the prompt decides", () => {
    render(<Bar inputMode="manual" referenceNodeIds={["n-plate"]} />);
    expect(screen.queryByRole("button", { name: /By hand/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wired in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /In the prompt/ })).toBeNull();
    // And what the fold decided is simply shown, here the list by hand.
    expect(rows()[0].textContent).toContain("Plate");
  });

  it("says what the prompt's own pointing means for what will be sent", () => {
    render(<Bar inputMode="mentions" />);
    expect(bar().textContent).toContain("What the prompt points at with @");
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

describe("what is pointed at by hand", () => {
  it("is listed in the order it was written, which is the order it is sent", () => {
    render(
      <Bar inputMode="manual" referenceNodeIds={["n-plate", "n-brief"]} />,
    );
    const [first, second] = rows();
    expect(first.textContent).toContain("Plate");
    expect(second.textContent).toContain("Brief");
  });

  it("writes the list whole when one is taken out", () => {
    render(
      <Bar inputMode="manual" referenceNodeIds={["n-plate", "n-brief"]} />,
    );
    fireEvent.click(
      within(rows()[0]).getByRole("button", {
        name: "Take Plate out of the list",
      }),
    );
    // One write rather than one per chip that moved: the order is one thing.
    expect(point).toHaveBeenCalledTimes(1);
    expect(point).toHaveBeenCalledWith(["n-brief"]);
  });

  it("writes the list whole when one is dragged somewhere else", () => {
    render(
      <Bar inputMode="manual" referenceNodeIds={["n-plate", "n-brief"]} />,
    );
    const [first, second] = rows();
    fireEvent.dragStart(second);
    fireEvent.drop(first);
    expect(point).toHaveBeenCalledTimes(1);
    expect(point).toHaveBeenCalledWith(["n-brief", "n-plate"]);
  });

  it("reads as broken when a node it names is gone, and can still be taken out", () => {
    render(<Bar inputMode="manual" referenceNodeIds={["n-gone"]} />);
    const [row] = rows();
    expect(row.textContent).toContain("a node that is gone");
    expect(within(row).queryByRole("button", { name: /^Find/ })).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Take a node that is gone out of the list",
      }),
    );
    expect(point).toHaveBeenCalledWith([]);
  });

  it("offers to list what is already wired in rather than starting from nothing", () => {
    render(<Bar inputMode="manual" />);
    expect(bar().textContent).toContain("Nothing is listed yet");
    fireEvent.click(
      screen.getByRole("button", { name: "List what is wired in" }),
    );
    expect(point).toHaveBeenCalledWith(["n-brief", "n-plate"]);
  });
});

describe("an asset left on the bar", () => {
  it("reads as a place it can be left while it is being dragged over", () => {
    render(<Bar />);
    fireEvent.dragOver(bar(), carrying(PICTURE.id));
    expect(bar().className).toContain("is-dropping");
    fireEvent.dragLeave(bar());
    expect(bar().className).not.toContain("is-dropping");
  });

  it("hands back the asset that was left there", () => {
    render(<Bar />);
    fireEvent.drop(bar(), carrying(PICTURE.id));
    expect(tookAsset).toHaveBeenCalledWith(PICTURE.id);
  });

  it("leaves alone something that is not an asset", () => {
    render(<Bar />);
    fireEvent.dragOver(bar(), carrying(null));
    expect(bar().className).not.toContain("is-dropping");
    fireEvent.drop(bar(), carrying(null));
    expect(tookAsset).not.toHaveBeenCalled();
  });

  it("is not a place anything can be left where the prompt decides", () => {
    render(<Bar inputMode="mentions" />);
    fireEvent.dragOver(bar(), carrying(PICTURE.id));
    expect(bar().className).not.toContain("is-dropping");
    fireEvent.drop(bar(), carrying(PICTURE.id));
    expect(tookAsset).not.toHaveBeenCalled();
  });

  it("takes files brought from this machine, to be filed and listed", () => {
    render(<Bar />);
    fireEvent.dragOver(bar(), carryingFiles([FILE]));
    expect(bar().className).toContain("is-dropping");
    fireEvent.drop(bar(), carryingFiles([FILE]));
    expect(tookFiles).toHaveBeenCalledWith([FILE]);
  });

  it("refuses files where the prompt decides, as it refuses assets", () => {
    render(<Bar inputMode="mentions" />);
    fireEvent.dragOver(bar(), carryingFiles([FILE]));
    expect(bar().className).not.toContain("is-dropping");
    fireEvent.drop(bar(), carryingFiles([FILE]));
    expect(tookFiles).not.toHaveBeenCalled();
  });

  it("keeps a drop it takes from reaching what lies under it", () => {
    const under = vi.fn();
    render(
      <div onDrop={under}>
        <Bar />
      </div>,
    );
    // The canvas under the panel would otherwise take the same drop and make
    // a node of it a second time.
    fireEvent.drop(bar(), carrying(PICTURE.id));
    fireEvent.drop(bar(), carryingFiles([FILE]));
    expect(tookAsset).toHaveBeenCalledWith(PICTURE.id);
    expect(tookFiles).toHaveBeenCalledWith([FILE]);
    expect(under).not.toHaveBeenCalled();
  });
});
