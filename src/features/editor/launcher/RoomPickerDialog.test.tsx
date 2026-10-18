// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoomPickerDialog } from "./RoomPickerDialog";

afterEach(cleanup);

function open() {
  const onChoose = vi.fn();
  const onDismiss = vi.fn();
  render(
    <RoomPickerDialog
      onChoose={onChoose}
      onDismiss={onDismiss}
      projectName="Launch teaser"
    />,
  );
  return { onChoose, onDismiss };
}

describe("the room a new project opens onto", () => {
  it("offers the three rooms by name and keeps their long scenes off the face", () => {
    open();

    expect(
      screen.getByRole("heading", { name: "Where would you like to start?" }),
    ).toBeTruthy();
    for (const name of ["Story", "Canvas", "Clip"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }

    const scene = screen.getByTestId("room-picker-detail");
    expect(scene.textContent).toContain("Hover or focus a card");
    fireEvent.mouseEnter(screen.getByTestId("room-choice-canvas"));
    expect(scene.textContent).toContain(
      "Best for experimenting and fine control",
    );
  });

  it("enters the room whose card was chosen", () => {
    const { onChoose } = open();

    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));

    expect(onChoose).toHaveBeenCalledWith("canvas");
  });

  it("steps back without choosing", () => {
    const { onDismiss } = open();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
