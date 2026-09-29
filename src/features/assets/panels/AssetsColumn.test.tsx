// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { MokaFile, ResourceEntry } from "../../../shared/domain";
import { buildShelfMokaFile } from "../../../shared/domain/fixtures";
import { assetsApi, type AssetChange } from "../../../api";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { AssetsColumn } from "./AssetsColumn";
import { useAssetsStore } from "../stores/assetsStore";

/** The files room's library column, open on a project. */
function openColumn(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-column-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  render(<AssetsColumn />);
  return moka;
}

function rowsShown(): string[] {
  return [...document.querySelectorAll(".resource-main strong")].map(
    (name) => name.textContent ?? "",
  );
}

function showKind(kind: "text" | "image" | "audio" | "video") {
  fireEvent.click(screen.getByTestId(`asset-kind-${kind}`));
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useAssetsStore.setState({
    inspectedAssetId: null,
    view: "all",
    kind: "image",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the library column", () => {
  it("lists the files of the kind being read, and counts both views", () => {
    openColumn(buildShelfMokaFile());
    expect(rowsShown()).toEqual(["lake.png"]);
    expect(screen.getByTestId("assets-view-all").textContent).toContain("2");
    expect(screen.getByTestId("assets-view-unused").textContent).toContain("1");

    showKind("text");
    expect(rowsShown()).toEqual(["opening-lines.md"]);
  });

  it("narrows to what nothing holds when the unused view is asked for", () => {
    openColumn(buildShelfMokaFile());
    fireEvent.click(screen.getByTestId("assets-view-unused"));
    showKind("text");
    expect(rowsShown()).toEqual(["opening-lines.md"]);

    showKind("image");
    expect(rowsShown()).toEqual([]);
    expect(screen.getByText(/Nothing is unused/)).toBeTruthy();
  });

  it("hands the row a reader chooses to the stage", () => {
    openColumn(buildShelfMokaFile());
    fireEvent.click(screen.getAllByTestId("resource-main")[0]);
    expect(useAssetsStore.getState().inspectedAssetId).toBe(
      buildShelfMokaFile().resources.images[0].id,
    );
  });

  it("narrows the list by the words a reader asks with", () => {
    const moka = buildShelfMokaFile();
    moka.resources.images.push({
      id: "image-dawn",
      name: "dawn.png",
      path: "assets/images/dawn-00000000.png",
      mime: "image/png",
      bytes: 2048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    openColumn(moka);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "dawn" },
    });
    expect(rowsShown()).toEqual(["dawn.png"]);
  });

  it("imports a file dropped over the column", async () => {
    const moka = buildShelfMokaFile();
    const filed: ResourceEntry = {
      id: "asset-shot",
      name: "shot.png",
      path: "assets/images/shot-00000000.png",
      mime: "image/png",
      bytes: 3,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const change: AssetChange = {
      entry: filed,
      revision: moka.metadata.revision + 1,
      updatedAt: "2026-01-02T00:00:01.000Z",
    };
    const upload = vi.spyOn(assetsApi, "upload").mockResolvedValue(change);
    openColumn(moka);

    // A drop is taken anywhere over the column the shelf sits in, not only
    // over its rows — the region is the page's, named by the shelf's prop.
    const column = document.querySelector(".assets-column");
    expect(column).not.toBeNull();
    fireEvent.drop(column!, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["png"], "shot.png", { type: "image/png" })],
      },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(
      useProjectStore.getState().moka?.resources.images.map((e) => e.name),
    ).toContain("shot.png");
  });
});
