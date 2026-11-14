// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import type { ModelsView } from "../../../api/models";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { useStoryJobStore } from "../stores/storyJobStore";
import { jobKey } from "../jobs/plan";
import { useEditStarts } from "./editStarts";
import { StoryEditDialog } from "./StoryEditDialog";

/** One image model configured, with what its protocol declares it takes. */
function model(id: string, displayName: string, protocol: string) {
  return {
    id,
    category: "image" as const,
    protocol,
    url: "http://127.0.0.1:1/images/generations",
    model: id,
    displayName,
    enabled: true,
    apiKey: { set: true, masked: "*" },
  };
}

function view(): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [
      model("painter", "Painter", "openaiImages"),
      model("plain", "Plain redraw", "plainImage"),
    ],
    defaults: { image: "painter" },
    preferences: {},
    secretStorage: "file",
  } as unknown as ModelsView;
}

function openDialog() {
  const moka = buildStoryMokaFile();
  const story = moka.stories![0]!;
  const chapter = story.chapters[0]!;
  const act = chapter.acts[0]!;
  const keyframe = act.keyframes[0]!;
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-edit-dialog-test",
    selfCheck: { ok: true, issues: [] },
    selfCheckVerified: true,
  });
  render(
    <StoryEditDialog
      onClose={() => {}}
      place={{ kind: "keyframe", chapterId: chapter.id, act, keyframe }}
      story={story}
    />,
  );
  return {
    select: screen.getByTestId("story-edit-model") as HTMLSelectElement,
    submit: screen.getByRole("button", {
      name: /Draw a new version|Sending|Generating/,
    }) as HTMLButtonElement,
    storyId: story.id,
    target: {
      kind: "keyframeArt" as const,
      chapterId: chapter.id,
      actId: act.id,
      keyframeId: keyframe.id,
    },
  };
}

beforeEach(() => {
  resetUiPrefs();
  useHistoryStore.getState().clear();
  useProjectStore.getState().close();
  useModelStore.getState().reset();
  useEditStarts.getState().reset();
  useStoryJobStore.getState().reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("the registry is not on file"))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the model an edit is asked of", () => {
  it("offers the image models whose protocol takes a picture as input", () => {
    useModelStore.setState({
      view: view(),
      protocols: {
        image: {
          openaiImages: {
            script: "image/openaiImages/openai-images.lua",
            displayName: "OpenAI-compatible · Images API",
            urlExample: "",
            features: { mask: true, imageInput: true },
          },
          plainImage: {
            script: "image/plainImage/plain-image.lua",
            displayName: "Plain redraw",
            urlExample: "",
            features: {},
          },
        },
      },
    });
    const { select } = openDialog();
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "painter",
    ]);
    expect(select.value).toBe("painter");
  });

  it("still offers them when the registry could not be read", () => {
    useModelStore.setState({
      view: view(),
      protocols: null,
    });
    const { select } = openDialog();
    // Nothing says what these take, so nothing is filtered out and the note
    // beside the list says the capabilities are not known.
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "painter",
      "plain",
    ]);
    expect(screen.getByTestId("story-edit-capability").textContent).toContain(
      "capabilities are not known",
    );
  });
});

describe("an edit that outlives its dialog", () => {
  /** A batch of the room's working on the place the dialog was opened on. */
  function editRunning(
    storyId: string,
    target: ReturnType<typeof openDialog>["target"],
  ) {
    useStoryJobStore.setState({
      storyId,
      jobs: [
        {
          id: "edit-1",
          projectId: "project-1",
          storyId,
          kind: "keyframeArt",
          status: "running",
          model: "painter",
          items: [
            {
              id: jobKey(target),
              target,
              capability: "image",
              prompt: "change the coat",
              inputs: [],
              params: {},
              status: "running",
            },
          ],
          cancelRequested: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  }

  it("shows the place being made when the dialog is opened again", () => {
    useModelStore.setState({ view: view(), protocols: null });
    const { storyId, target } = openDialog();
    editRunning(storyId, target);

    // The dialog may have been closed while the batch was handed over; opened
    // again, it reads the place from the room's records rather than from a
    // state of its own that the close took with it.
    cleanup();
    const again = openDialog();
    expect(again.submit.disabled).toBe(true);
    expect(again.submit.textContent).toBe("Generating…");
  });

  it("comes back to the reason a place's edit was refused", () => {
    useModelStore.setState({ view: view(), protocols: null });
    const first = openDialog();
    const key = `${first.storyId}:${jobKey(first.target)}`;
    useEditStarts.getState().refuse(key, "the picture could not be read");

    cleanup();
    openDialog();
    expect(screen.getByText("the picture could not be read")).toBeTruthy();
  });
});
