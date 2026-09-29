// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MokaFile } from "../../../shared/domain";
import { buildShelfMokaFile } from "../../../shared/domain/fixtures";
import { AssetShelf, type AssetShelfProps } from "./AssetShelf";
import { heldLens } from "./shelfFilter";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";

function openShelf(moka: MokaFile, props: AssetShelfProps = {}) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-shelf-tray-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  render(<AssetShelf {...props} />);
  return moka;
}

/** The lens a scoped face reads through: only files the document holds. */
function lensHolding(moka: MokaFile) {
  return heldLens(new Set([moka.resources.images[0].id]));
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({ announcement: "" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the tray above a scoped shelf", () => {
  it("offers files waiting for a place, with the page's own action", () => {
    const moka = buildShelfMokaFile();
    const waiting = moka.resources.texts[0];
    openShelf(moka, {
      kind: "text",
      lens: lensHolding(moka),
      unplaced: {
        titleKey: "assets:shelf.unplaced",
        action: (entry) => (
          <button data-testid={`place-${entry.id}`} type="button">
            Place
          </button>
        ),
      },
    });
    const tray = screen.getByTestId("shelf-tray");
    expect(tray.textContent).toContain("Imported, not placed");
    expect(tray.textContent).toContain("opening-lines.md");
    expect(screen.getByTestId(`place-${waiting.id}`)).toBeTruthy();
    // The lens leaves the tray alone: the waiting file is exactly what a face
    // about one document's files would have hidden.
    expect(
      screen.queryByText(/No .* assets yet/),
      "an empty shelf is not announced while the tray has rows",
    ).toBeNull();
  });

  it("narrows the tray by the words a reader asks with, like the list", () => {
    const moka = buildShelfMokaFile();
    openShelf(moka, {
      kind: "text",
      lens: lensHolding(moka),
      unplaced: { titleKey: "assets:shelf.unplaced", action: () => null },
    });
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "nothing matches this" },
    });
    expect(screen.queryByTestId("shelf-tray")).toBeNull();
  });

  it("stands as it did for a face that keeps no tray", () => {
    const moka = buildShelfMokaFile();
    openShelf(moka, { kind: "text", lens: lensHolding(moka) });
    expect(screen.queryByTestId("shelf-tray")).toBeNull();
    // Nothing the lens keeps is on this kind, and there is no tray to say
    // otherwise: the shelf says what it holds.
    expect(document.querySelector(".inspector-empty")).not.toBeNull();
  });
});
