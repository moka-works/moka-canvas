// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { i18n } from "../../shared/i18n";
import { AssetsPage } from "./AssetsPage";
import { useAppStore } from "../editor/stores/appStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useAssetsStore } from "./stores/assetsStore";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The room as a reader arrives in it: a project open, nothing chosen. */
function openRoom() {
  const moka = buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  useAppStore.getState().setPhase("assets");
  render(<AssetsPage />);
  return moka;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(json({})));
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAssetsStore.setState({ inspectedAssetId: null, view: "all" });
  useAppStore.setState({ phase: "launcher", toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the files room", () => {
  it("stands its three panes, the menu marking it as where the reader is", () => {
    openRoom();
    expect(screen.getByTestId("assets-page")).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("assets:page.title"))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("assets:stage.label"))).toBeTruthy();
    expect(
      screen.getByLabelText(i18n.t("assets:inspector.label")),
    ).toBeTruthy();
    expect(screen.getByTestId("assets-overview")).toBeTruthy();

    fireEvent.click(screen.getByTestId("home-menu-button"));
    const current = screen
      .getAllByRole("menuitem")
      .find((item) => item.getAttribute("aria-current") === "page");
    expect(current?.textContent).toContain(i18n.t("app:homeMenu.assets"));
  });

  it("stands the bar's export button grayed, since nothing leaves from here", () => {
    openRoom();

    // The button keeps its place in the bar's corner, which is where every
    // page wears it, and says why it is grayed rather than opening a menu with
    // nothing in it.
    const button = screen.getByTestId("export-menu-button");
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBe(
      i18n.t("editor:topBar.exportNothing"),
    );
    fireEvent.click(button);
    expect(screen.queryByTestId("export-menu")).toBeNull();
  });

  it("reads the file a row is clicked at, and puts it down when let go of", () => {
    const ids = goldenNodeIds();
    openRoom();

    const row = document.querySelector<HTMLElement>(
      `.resource-row[data-asset-id="${ids.assetImage}"]`,
    );
    fireEvent.click(within(row!).getByTestId("resource-main"));

    expect(useAssetsStore.getState().inspectedAssetId).toBe(ids.assetImage);
    expect(screen.queryByTestId("assets-overview")).toBeNull();
    expect(screen.getByTestId("assets-stage-file").textContent).toContain(
      "lake.png",
    );
    expect(screen.getByTestId("assets-inspector-file").textContent).toContain(
      "lake.png",
    );

    // Choosing nothing is a question the room can be returned to: with no file
    // chosen the stage reads the project again.
    act(() => {
      useAssetsStore.getState().select(null);
    });
    expect(screen.getByTestId("assets-overview")).toBeTruthy();
    expect(screen.queryByTestId("assets-stage-file")).toBeNull();
  });

  it("puts the project down on going home", async () => {
    openRoom();
    fireEvent.click(screen.getByTestId("home-menu-button"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    });
    expect(useAppStore.getState().phase).toBe("launcher");
    expect(useProjectStore.getState().moka).toBeNull();
  });
});
