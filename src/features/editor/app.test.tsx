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
import App from "../../App";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
import { Toasts } from "./components/Toasts";
import { splitToastMessage, useAppStore } from "./stores/appStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png"],
  limits: {
    maxNodesPerCanvas: 500,
    maxEdgesPerCanvas: 800,
    maxCanvasesPerProject: 12,
    maxPackageBytes: 536870912,
    maxPackageEntries: 20000,
  },
  capabilities: { mode: "web", executors: ["noop"], assetCategories: [] },
};

const RECENTS = [
  {
    id: "recent-1",
    name: "Golden Fixture",
    path: "/tmp/golden",
    lastOpened: "2026-01-01T00:00:00.000Z",
  },
];

function route(url: string): Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (url === "/api/v1/config") return json(CONFIG);
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/recent-projects") return json(RECENTS);
  if (url === "/api/v1/projects" || url === "/api/v1/projects/open") {
    return json({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
      selfCheckVerified: true,
    });
  }
  if (url === "/api/v1/projects/current/commands") {
    return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => Promise.resolve(route(String(input)))),
  );
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({
    phase: "booting",
    config: null,
    bootError: null,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("app boot", () => {
  it("reaches the launcher and lists recent projects", async () => {
    render(<App />);
    const heading = await screen.findByRole("heading", {
      name: "Moka Canvas",
    });
    expect(heading).toBeTruthy();
    expect(screen.getByText("Golden Fixture")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
    // The ways in are named for what they bring rather than for the format the
    // work happens to travel in, so a package arriving says "project".
    expect(screen.getByRole("button", { name: "Open project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import package" })).toBeNull();
    // A row wears an ellipsis when its name or path is long, so each half
    // carries the whole of its text where the pointer can ask for it.
    expect(screen.getByText("Golden Fixture").getAttribute("title")).toBe(
      "Golden Fixture",
    );
    expect(screen.getByText("/tmp/golden").getAttribute("title")).toBe(
      "/tmp/golden",
    );
  });

  it("opens a project into the editor shell", async () => {
    render(<App />);
    const recent = await screen.findByText("Golden Fixture");
    fireEvent.click(recent);

    // The row opens over the rooms a project can be entered by rather than
    // taking the project straight onto the board: the board is the room asked
    // for here.
    const rooms = within(
      screen.getByRole("group", { name: "Open Golden Fixture" }),
    );
    expect(
      rooms.getAllByRole("button").map((each) => each.textContent),
    ).toEqual(["Story", "Canvas", "Clip", "Assets"]);
    fireEvent.click(rooms.getByRole("button", { name: "Canvas" }));

    // The board a project opens onto has a tab, and the tree holds them both.
    const tab = await screen.findByTestId("canvas-tab-Canvas 1");
    expect(tab).toBeTruthy();
    expect(screen.queryByTestId("canvas-tab-Canvas 2")).toBeNull();
    const host = screen.getByTestId("canvas-host");
    expect(within(host).getByText("4 nodes · 2 edges")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("editing");

    // Opening a board from the tree puts a tab up and swaps the scene summary.
    fireEvent.click(screen.getByRole("button", { name: "Canvas 2" }));
    expect(await within(host).findByText("0 nodes · 0 edges")).toBeTruthy();
    expect(screen.getByTestId("canvas-tab-Canvas 2")).toBeTruthy();
  });

  it("enters a project in the room its row was asked for", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Golden Fixture"));
    fireEvent.click(await screen.findByRole("button", { name: "Story" }));

    // The room is a place in the work rather than a step through the board:
    // the story room stands, and the project was never put on a canvas first.
    expect(await screen.findByTestId("story-page")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("story");
    expect(useProjectStore.getState().moka).not.toBeNull();
    expect(screen.queryByTestId("canvas-host")).toBeNull();
  });

  it("opens a project straight into the files room", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Golden Fixture"));
    fireEvent.click(await screen.findByRole("button", { name: "Assets" }));

    // The files are a room of the project like any other: nothing is put on a
    // canvas on the way in, and the room stands with the project open.
    expect(await screen.findByTestId("assets-page")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("assets");
    expect(useProjectStore.getState().moka).not.toBeNull();
    expect(screen.queryByTestId("canvas-host")).toBeNull();
  });

  it("lands a new project in the story room", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));

    const dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByPlaceholderText("/Users/you/Movies/My project"),
      { target: { value: "/tmp/fresh" } },
    );
    fireEvent.change(within(dialog).getByPlaceholderText("Launch teaser"), {
      target: { value: "Launch teaser" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "New project" }),
    );

    // A project made here starts with a telling rather than a board to fill:
    // the story room is the room it lands in.
    expect(await screen.findByTestId("story-page")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("story");
    expect(useProjectStore.getState().moka).not.toBeNull();
  });

  it("walks between the board and the cutting room from the corner menu", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Golden Fixture"));
    fireEvent.click(await screen.findByRole("button", { name: "Canvas" }));
    await screen.findByTestId("canvas-host");

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Canvas" })
        .getAttribute("aria-current"),
    ).toBe("page");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Clip" }));
    expect(useAppStore.getState().phase).toBe("clip");
    expect(await screen.findByTestId("clip-page")).toBeTruthy();
    // The board the project was holding no longer stands in for the room: the
    // room itself does, asking for its first timeline.
    expect(screen.getByText("No timelines yet")).toBeTruthy();
    // Stepping over to the cutting room is not a close: the project stands.
    expect(useProjectStore.getState().moka).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    const clipMenu = screen.getByRole("menu");
    expect(
      within(clipMenu)
        .getByRole("menuitem", { name: "Clip" })
        .getAttribute("aria-current"),
    ).toBe("page");
    fireEvent.click(within(clipMenu).getByRole("menuitem", { name: "Canvas" }));
    expect(useAppStore.getState().phase).toBe("editing");
    expect(screen.getByTestId("canvas-host")).toBeTruthy();

    // The files room is one more page of the same walk, and stepping over to
    // it is no more a close than stepping to the cutting room was.
    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Assets",
      }),
    );
    expect(useAppStore.getState().phase).toBe("assets");
    expect(await screen.findByTestId("assets-page")).toBeTruthy();
    expect(useProjectStore.getState().moka).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Projects",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Moka Canvas" }),
    ).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("launcher");
    expect(useProjectStore.getState().moka).toBeNull();
  });

  it("never lets the native context menu appear over its own", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Moka Canvas" });

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("what has just happened", () => {
  it("goes away on being chosen", () => {
    render(<Toasts />);
    act(() => {
      useAppStore.getState().pushToast("info", "Saved");
    });
    const said = screen.getByRole("button", { name: "Saved" });
    expect(said).toHaveProperty("title", "Dismiss");

    fireEvent.click(said);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("goes where it says first when it named a place", () => {
    render(<Toasts />);
    let went = 0;
    act(() => {
      useAppStore.getState().pushToast("success", "Filed under Images (1)", {
        label: "Show assets",
        go: () => {
          went += 1;
        },
      });
    });
    const said = screen.getByRole("button", { name: /Filed under Images/ });
    // The label is what tells a reader this one leads somewhere rather than
    // only away.
    expect(said).toHaveProperty("title", "Show assets");
    expect(said.textContent).toContain("Show assets");

    fireEvent.click(said);
    expect(went).toBe(1);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the rest of a report under the line, shown when it is asked for", () => {
    render(<Toasts />);
    act(() => {
      useAppStore
        .getState()
        .pushToast(
          "error",
          "1 of 1 pieces did not come back",
          undefined,
          "model gpt-4o-mini has no stored API key",
        );
    });
    const line = screen.getByRole("button", { name: /did not come back/ });
    expect(line).toHaveProperty("title", "Show the full report");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    // Under the line, and not read out until it is asked for.
    const under = screen.getByText("model gpt-4o-mini has no stored API key");
    expect(under.hidden).toBe(true);

    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(line).toHaveProperty("title", "Hide the full report");
    expect(under.hidden).toBe(false);
  });

  it("goes where it says from its own control, and closes from another", () => {
    render(<Toasts />);
    let went = 0;
    act(() => {
      useAppStore.getState().pushToast(
        "error",
        "1 of 2 pieces did not come back",
        {
          label: "Ask again",
          go: () => {
            went += 1;
          },
        },
        "the provider refused it",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(went).toBe(1);
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      useAppStore
        .getState()
        .pushToast("error", "One more", undefined, "because of this");
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays while it is being read, and leaves once put away", () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      act(() => {
        useAppStore
          .getState()
          .pushToast("error", "It broke", undefined, "and here is why");
      });
      const line = screen.getByRole("button", { name: "It broke" });
      fireEvent.click(line);
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(screen.getByRole("button", { name: "It broke" })).not.toBeNull();

      fireEvent.click(line);
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.queryByRole("button")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts a message too long for a line where a sentence ends", () => {
    const long = `The provider refused the request. ${"b".repeat(90)}. and it said why`;
    expect(splitToastMessage(long)).toEqual({
      message: "The provider refused the request.",
      detail: `${"b".repeat(90)}. and it said why`,
    });
  });

  it("leaves a long single sentence whole", () => {
    // The exported package's path is read off a toast by one suite, so a
    // message with nowhere to cut is wrapped rather than cut anywhere.
    const whole = `Exported 3 files to /somewhere/${"x".repeat(140)}.mokapkg.zip`;
    expect(splitToastMessage(whole)).toEqual({ message: whole });
    expect(splitToastMessage("short and sweet")).toEqual({
      message: "short and sweet",
    });
  });
});
