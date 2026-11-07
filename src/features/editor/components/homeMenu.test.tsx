// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HomeMenu } from "./HomeMenu";
import { useAppStore } from "../stores/appStore";

/** What stands under the menu here, so a click that reaches it can be seen. */
function Underneath() {
  return (
    <div
      className="side-panel-tabs"
      role="tablist"
      aria-label="What the column shows"
    >
      <button
        data-testid="tab-underneath"
        onClick={() => useAppStore.getState().pushToast("error", "turned over")}
        role="tab"
        type="button"
      >
        Assets
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ phase: "launcher", toasts: [] });
});

function openMenu() {
  render(<HomeMenu current="canvas" onHome={() => {}} />);
  render(<Underneath />);
  fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
  return screen.getByTestId("home-menu");
}

describe("the corner menu's guard", () => {
  it("stands the menu on a ring that takes the pointer", () => {
    const menu = openMenu();
    const guard = screen.getByTestId("home-menu-guard");
    // The menu is inside the ring rather than beside it, so the ring is what a
    // pointer sliding off the menu's edge meets first.
    expect(menu.parentElement).toBe(guard);
  });

  it("puts the menu down when the ring is clicked, and nothing else happens", () => {
    openMenu();
    fireEvent.mouseDown(screen.getByTestId("home-menu-guard"));
    expect(screen.queryByTestId("home-menu")).toBeNull();
    // The ring is transparent and takes the click rather than passing it on:
    // what stands under this corner of the window is not turned over.
    expect(useAppStore.getState().toasts).toEqual([]);
  });

  it("keeps a row of the menu under the press that chooses it", () => {
    openMenu();
    const clip = screen.getByRole("menuitem", { name: "Clip" });
    // A press on a row bubbles out to the ring, and a menu that closed on the
    // way would be gone before the click that chooses was ever made.
    fireEvent.mouseDown(clip);
    expect(screen.getByTestId("home-menu")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("launcher");

    fireEvent.click(clip);
    expect(useAppStore.getState().phase).toBe("clip");
    expect(screen.queryByTestId("home-menu")).toBeNull();
  });

  it("still answers to its own rows", () => {
    const menu = openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clip" }));
    expect(useAppStore.getState().phase).toBe("clip");
    expect(screen.queryByTestId("home-menu")).toBeNull();
    expect(menu).toBeTruthy();
    cleanup();
  });

  it("lets the page hold a reader who still has work to send", () => {
    const asked: string[] = [];
    render(
      <HomeMenu
        current="story"
        onGo={(phase) => {
          asked.push(phase);
          return false;
        }}
        onHome={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Projects menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clip" }));

    // The row asked the page first, and the page's no is the answer: the app
    // does not move out from under the work the room is still sending.
    expect(asked).toEqual(["clip"]);
    expect(useAppStore.getState().phase).toBe("launcher");
  });

  it("lists the rooms, the story room first", () => {
    openMenu();
    const rooms = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
      .filter((name) => name !== "Projects");
    expect(rooms).toEqual(["Story", "Canvas", "Clip", "Assets"]);
  });
});
