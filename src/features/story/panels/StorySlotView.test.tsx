// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { slotWithCurrent } from "../../../shared/domain/story";
import type { StorySlot } from "../../../shared/domain/types";
import { StorySlotView } from "./StorySlotView";

function slot(takes: string[]): StorySlot {
  return {
    takes: takes.map((assetId, at) => ({
      assetIds: [assetId],
      createdAt: `2026-01-0${at + 1}T00:00:00Z`,
    })),
  };
}

function draw(overrides: Partial<Parameters<typeof StorySlotView>[0]> = {}) {
  const onGenerate = vi.fn();
  const onChoose = vi.fn();
  const onRemove = vi.fn(async () => undefined);
  render(
    <StorySlotView
      canGenerate
      label="Main picture"
      onChoose={onChoose}
      onGenerate={onGenerate}
      onRemove={onRemove}
      ratio="16 / 9"
      slot={slot([])}
      testId="story-slot-main"
      {...overrides}
    />,
  );
  return { onGenerate, onChoose, onRemove };
}

afterEach(() => {
  cleanup();
});

describe("a place with nothing in it", () => {
  it("offers to draw it, and says why when it cannot", () => {
    const { onGenerate } = draw({
      canGenerate: false,
      disabledReason: "Draw the main picture first",
    });
    const button = screen.getByTestId(
      "story-slot-main-generate",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Draw the main picture first");

    fireEvent.click(button);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("draws when the reader asks it to", () => {
    const { onGenerate } = draw();
    fireEvent.click(screen.getByTestId("story-slot-main-generate"));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("a place being drawn", () => {
  it("says so rather than offering the button twice", () => {
    draw({ busy: true });
    expect(screen.getByRole("status").textContent).toContain("Drawing…");
    expect(screen.queryByTestId("story-slot-main-generate")).toBeNull();
  });
});

describe("a place with a picture", () => {
  it("shows it, with a way to ask for another and to pick between them", () => {
    const { onGenerate } = draw({ slot: slot(["asset-one"]) });
    expect(
      screen
        .getByTestId("story-slot-main")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("/api/v1/projects/current/assets/asset-one?w=768");

    fireEvent.click(screen.getByTestId("story-slot-main-again"));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    // One picture is not a choice: picking only appears once there is more
    // than one to pick between.
    expect(screen.queryByTestId("story-slot-main-pick")).toBeNull();
  });

  it("has nothing to agree to one picture at a time", () => {
    draw({ slot: slot(["asset-one"]) });
    expect(screen.queryByTestId("story-slot-main-confirm")).toBeNull();
  });

  it("says over the old picture that it is being drawn again", () => {
    const { onGenerate } = draw({ busy: true, slot: slot(["asset-one"]) });
    // What is there stays where it is, with the wait said over it: a place
    // that looked empty while it was being redrawn would read as a loss.
    expect(
      screen.getByTestId("story-slot-main").querySelector("img"),
    ).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Drawing…");

    const again = screen.getByTestId(
      "story-slot-main-again",
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("lets a reader look at it closely, and closes on Escape", () => {
    draw({ slot: slot(["asset-one"]) });
    fireEvent.click(
      screen.getByRole("button", { name: "Look at Main picture closely" }),
    );
    expect(screen.getByTestId("story-lightbox")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("story-lightbox")).toBeNull();
  });
});

describe("choosing between what has been drawn", () => {
  it("marks the one being kept and hands the choice on", () => {
    const { onChoose } = draw({ slot: slot(["asset-a", "asset-b"]) });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));

    expect(screen.getByTestId("story-pick-asset-b").className).toContain(
      "is-current",
    );
    expect(screen.getByTestId("story-pick-asset-a").className).not.toContain(
      "is-current",
    );

    fireEvent.click(screen.getByTestId("story-pick-asset-a"));
    expect(onChoose).toHaveBeenCalledWith("asset-a");
    expect(screen.queryByTestId("story-picks")).toBeNull();
  });
});

describe("throwing an old drawing away", () => {
  it("offers the ✕ on every drawing but the one being kept", () => {
    draw({ slot: slot(["asset-a", "asset-b"]) });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));

    expect(screen.getByTestId("story-pick-remove-asset-a")).toBeTruthy();
    // The drawing in use is not one to throw away: letting it go would leave
    // the place holding a picture nobody chose.
    expect(screen.queryByTestId("story-pick-remove-asset-b")).toBeNull();
  });

  it("asks before it goes, and hands the answer on", async () => {
    const { onRemove } = draw({ slot: slot(["asset-a", "asset-b"]) });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));
    fireEvent.click(screen.getByTestId("story-pick-remove-asset-a"));

    expect(screen.getByTestId("story-pick-ask")).toBeTruthy();
    expect(screen.getByTestId("story-pick-asset-a").className).toContain(
      "is-asking",
    );

    fireEvent.click(screen.getByTestId("story-pick-remove-confirm"));
    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledWith("asset-a");
    });
    expect(screen.queryByTestId("story-pick-ask")).toBeNull();
  });

  it("says what came back, and stays up for the next one", async () => {
    const onRemove = vi.fn(
      async () => "The file is still used elsewhere, so it stays on the shelf",
    );
    draw({ slot: slot(["asset-a", "asset-b"]), onRemove });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));
    fireEvent.click(screen.getByTestId("story-pick-remove-asset-a"));
    fireEvent.click(screen.getByTestId("story-pick-remove-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("story-pick-notice").textContent).toContain(
        "still used elsewhere",
      );
    });
    // A reader clearing three old drawings in a row is not sent back into the
    // list between each of them.
    expect(screen.getByTestId("story-picks")).toBeTruthy();
  });

  it("does not ask the file for anything when the reader says no", () => {
    const { onRemove } = draw({ slot: slot(["asset-a", "asset-b"]) });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));
    fireEvent.click(screen.getByTestId("story-pick-remove-asset-a"));
    fireEvent.click(screen.getByTestId("story-pick-remove-cancel"));

    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByTestId("story-pick-ask")).toBeNull();
    expect(screen.getByTestId("story-picks")).toBeTruthy();
  });

  it("leaves the ask before it leaves the list", () => {
    draw({ slot: slot(["asset-a", "asset-b"]) });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));
    fireEvent.click(screen.getByTestId("story-pick-remove-asset-a"));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("story-pick-ask")).toBeNull();
    expect(screen.getByTestId("story-picks")).toBeTruthy();
  });
});

describe("slotWithCurrent", () => {
  it("keeps the chosen take as the newest, the rest in the order they were", () => {
    const held = slot(["asset-a", "asset-b", "asset-c"]);
    expect(
      slotWithCurrent(held, "asset-b").takes.map((take) => take.assetIds[0]),
    ).toEqual(["asset-a", "asset-c", "asset-b"]);
    // A take that is not there leaves the place alone.
    expect(slotWithCurrent(held, "asset-gone")).toBe(held);
  });
});
