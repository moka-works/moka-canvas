// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MokaFile } from "../../../shared/domain";
import {
  buildGoldenMokaFile,
  buildStoryMokaFile,
} from "../../../shared/domain/fixtures";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useAssetsStore } from "../stores/assetsStore";
import { AssetsOverview } from "./AssetsOverview";

function openRoom(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  render(<AssetsOverview />);
  return moka;
}

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAssetsStore.setState({
    inspectedAssetId: null,
    view: "all",
    kind: "image",
  });
});

afterEach(cleanup);

describe("the project read at the stage", () => {
  it("counts what the project holds, what is placed, and how much room it takes", () => {
    openRoom(buildStoryMokaFile());
    expect(screen.getByTestId("assets-overview-total").textContent).toBe(
      "10 files · 9 used · 1 unused · 1.6 MB",
    );
  });

  it("says a lone file in the singular", () => {
    openRoom(buildGoldenMokaFile());
    expect(screen.getByTestId("assets-overview-total").textContent).toBe(
      "1 file · 1 used · 0 unused · 2.0 KB",
    );
    // Nothing unused is nothing to go and look at.
    expect(screen.queryByTestId("assets-overview-unused")).toBeNull();
  });

  it("says what each kind holds, and turns the column to one that is pressed", () => {
    openRoom(buildStoryMokaFile());
    expect(screen.getByTestId("assets-overview-image").textContent).toContain(
      "6 files",
    );
    expect(screen.getByTestId("assets-overview-video").textContent).toContain(
      "3 files",
    );

    fireEvent.click(screen.getByTestId("assets-overview-video"));
    expect(useAssetsStore.getState().kind).toBe("video");
    expect(
      screen.getByTestId("assets-overview-video").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("offers the files nothing points at, and takes the offer", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("assets-overview-unused"));
    expect(useAssetsStore.getState().view).toBe("unused");
  });
});
