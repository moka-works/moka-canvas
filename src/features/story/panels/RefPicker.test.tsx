// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createElement } from "../../../shared/domain/factories";
import { RefPicker } from "./RefPicker";

const picked = createElement("character", "林", "深色大衣。");

function renderPicker() {
  render(
    <RefPicker
      chosen={[]}
      elements={[picked]}
      kind="character"
      label="Characters"
      many
      onPick={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("an act's reference menu", () => {
  it("opens from the + and puts itself away on a press elsewhere", () => {
    renderPicker();
    fireEvent.click(screen.getByTestId("story-ref-add-character"));
    expect(screen.getByTestId("story-ref-menu-character")).toBeDefined();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("story-ref-menu-character")).toBeNull();
  });

  it("stays open while a choice is being made", () => {
    const onPick = vi.fn();
    render(
      <RefPicker
        chosen={[]}
        elements={[picked]}
        kind="character"
        label="Characters"
        many
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByTestId("story-ref-add-character"));
    const menu = screen.getByTestId("story-ref-menu-character");
    fireEvent.pointerDown(menu);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /林/ }));
    expect(onPick).toHaveBeenCalledWith([picked.id]);
    expect(screen.getByTestId("story-ref-menu-character")).toBeDefined();
  });

  it("stands an undrawn element in with its kind's placeholder", () => {
    renderPicker();
    fireEvent.click(screen.getByTestId("story-ref-add-character"));
    const avatar = screen
      .getByTestId("story-ref-menu-character")
      .querySelector(".story-ref-avatar");
    expect(avatar?.getAttribute("src")).toBe("/story/element-character.svg");
  });
});
