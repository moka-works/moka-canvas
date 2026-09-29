import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assetsApi } from "../../../api/assets";
import { ApiError } from "../../../api/client";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { i18n } from "../../../shared/i18n";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
import { liveStory, removeOldTake } from "./removeOldTake";

const ids = storyIds();

function open(): void {
  useProjectStore.getState().hydrate({
    moka: buildStoryMokaFile(),
    root: "/tmp/moka-remove-take-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
}

/** The shelf as the document holds it, which is what a delete has to move. */
function shelf(): string[] {
  return (useProjectStore.getState().moka?.resources.images ?? []).map(
    (entry) => entry.id,
  );
}

beforeEach(() => {
  useProjectStore.getState().close();
  open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeOldTake", () => {
  it("takes the file off the shelf once the story has let it go", async () => {
    const remove = vi
      .spyOn(assetsApi, "remove")
      .mockResolvedValue({ revision: 9, updatedAt: "2026-01-05T00:00:00Z" });

    const line = await removeOldTake(ids.heroMain, () => "dropped");

    expect(remove).toHaveBeenCalledWith(ids.heroMain);
    expect(line).toBeUndefined();
    expect(shelf()).not.toContain(ids.heroMain);
    expect(useProjectStore.getState().moka?.metadata.revision).toBe(9);
  });

  it("leaves a file the rest of the project still uses, and says so", async () => {
    await i18n.changeLanguage("zh");
    try {
      vi.spyOn(assetsApi, "remove").mockRejectedValue(
        new ApiError({
          code: "ASSET_IN_USE",
          message: "The asset is referenced by canvas nodes",
          status: 409,
        }),
      );

      const line = await removeOldTake(ids.heroMain, () => "dropped");

      expect(line).toBe("文件仍被别处使用，只从故事里移走了");
      expect(shelf()).toContain(ids.heroMain);
    } finally {
      // The catalogue is shared with the cases after this one.
      await i18n.changeLanguage("en");
    }
  });

  it("keeps the file while the step that dropped the take is still on its way", async () => {
    const remove = vi.spyOn(assetsApi, "remove");
    useProjectStore.setState({
      saveStatus: "conflicted",
      pending: [{ type: "renameStory", storyId: ids.story, name: "别处改过" }],
    });

    const line = await removeOldTake(ids.heroMain, () => "dropped");

    expect(line).toBe(i18n.t("story:panels.removeUnsettled"));
    expect(remove).not.toHaveBeenCalled();
  });

  it("says a take that is no longer there rather than calling the shelf", async () => {
    const remove = vi.spyOn(assetsApi, "remove");

    const line = await removeOldTake("asset-gone", () => "gone");

    expect(line).toBe(i18n.t("story:panels.removeGone"));
    expect(remove).not.toHaveBeenCalled();
  });

  it("hands back what the document said when it refused the change", async () => {
    const remove = vi.spyOn(assetsApi, "remove");

    const line = await removeOldTake(ids.heroMain, () => "refused");

    expect(line).toBe(saveTrouble().message);
    expect(remove).not.toHaveBeenCalled();
  });

  it("takes a file that is already gone as gone", async () => {
    vi.spyOn(assetsApi, "remove").mockRejectedValue(
      new ApiError({
        code: "NOT_FOUND",
        message: "Asset not found",
        status: 404,
      }),
    );

    expect(await removeOldTake(ids.heroMain, () => "dropped")).toBeUndefined();
  });

  it("says the reason when the file could not be removed for another one", async () => {
    vi.spyOn(assetsApi, "remove").mockRejectedValue(
      new ApiError({
        code: "IO",
        message: "The file could not be read",
        status: 500,
      }),
    );

    const line = await removeOldTake(ids.heroMain, () => "dropped");

    expect(line).toBe(
      i18n.t("story:panels.removeFailed", {
        reason: "The file could not be read",
      }),
    );
    expect(shelf()).toContain(ids.heroMain);
  });
});

describe("liveStory", () => {
  it("reads the story from the document as it stands", () => {
    expect(liveStory(ids.story)?.name).toBe("雨夜列车");
    expect(liveStory("story-gone")).toBeUndefined();
  });
});
