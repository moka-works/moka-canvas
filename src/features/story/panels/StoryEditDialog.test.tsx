// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { resetUiPrefs } from "../../../shared/prefs/prefsData";
import { buildStoryMokaFile } from "../../../shared/domain/fixtures";
import type { ModelsView } from "../../../api/models";
import { storyApi, type StoryJobRecord } from "../../../api/story";
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

function openDialog(onClose: () => void = () => {}) {
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
      onClose={onClose}
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

describe("taking an edit back", () => {
  /** A batch record of the place, with as many pieces as named. */
  function batch(
    storyId: string,
    target: ReturnType<typeof openDialog>["target"],
    pieces: number,
  ): StoryJobRecord {
    return {
      id: "edit-1",
      projectId: "project-1",
      storyId,
      kind: "keyframeArt",
      status: "running",
      model: "painter",
      items: Array.from({ length: pieces }, (_, at) => ({
        id: at === 0 ? jobKey(target) : `${jobKey(target)}-other-${at}`,
        target,
        capability: "image" as const,
        prompt: "change the coat",
        inputs: [],
        params: {},
        status: "running" as const,
      })),
      cancelRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as StoryJobRecord;
  }

  it("offers no cancel while nothing is on its way, and closes from the corner", () => {
    useModelStore.setState({ view: view(), protocols: null });
    const onClose = vi.fn();
    openDialog(onClose);
    expect(screen.queryByTestId("story-edit-cancel")).toBeNull();

    fireEvent.click(screen.getByTestId("story-edit-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes a hand-over back on cancel, before the batch exists", () => {
    useModelStore.setState({ view: view(), protocols: null });
    const onClose = vi.fn();
    const { storyId, target } = openDialog(onClose);
    const key = `${storyId}:${jobKey(target)}`;
    let handover: AbortController = new AbortController();
    act(() => {
      handover = useEditStarts.getState().begin(key);
    });

    // The hand-over is on its way, so cancel is offered — and it is the
    // hand-over it takes back, not the dialog it closes over.
    fireEvent.click(screen.getByTestId("story-edit-cancel"));
    expect(handover.signal.aborted).toBe(true);
    expect(useEditStarts.getState().starting[key]).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("story-edit-cancel")).toBeNull();
  });

  it("takes back the batch this dialog asked for, once it is making the place", () => {
    useModelStore.setState({ view: view(), protocols: null });
    const { storyId, target } = openDialog();
    const record = batch(storyId, target, 1);
    act(() => {
      useStoryJobStore.setState({ storyId, jobs: [record] });
    });
    const cancel = vi
      .spyOn(storyApi, "cancel")
      .mockResolvedValue({ ...record, status: "cancelled" });

    fireEvent.click(screen.getByTestId("story-edit-cancel"));
    expect(cancel).toHaveBeenCalledWith("edit-1");
    cancel.mockRestore();
  });

  it("leaves a batch making the place among others to the room's records", () => {
    useModelStore.setState({ view: view(), protocols: null });
    const { storyId, target } = openDialog();
    act(() => {
      useStoryJobStore.setState({
        storyId,
        jobs: [batch(storyId, target, 2)],
      });
    });

    // The place is being made, but not by an ask this dialog owns: the
    // dialog says so and offers no cancel of its own.
    expect(screen.queryByTestId("story-edit-cancel")).toBeNull();
    expect(screen.getByRole("button", { name: /Generating/ }).textContent).toBe(
      "Generating…",
    );
  });

  it("takes back a batch that made it out while the cancel was on its way", async () => {
    useModelStore.setState({ view: view(), protocols: null });
    const onClose = vi.fn();
    const { storyId, target } = openDialog(onClose);
    let release: (record: StoryJobRecord) => void = () => {};
    const pending = new Promise<StoryJobRecord>((resolve) => {
      release = resolve;
    });
    const start = vi.fn(() => pending);
    useStoryJobStore.setState({
      start: start as unknown as ReturnType<
        typeof useStoryJobStore.getState
      >["start"],
    });

    fireEvent.change(screen.getByTestId("story-edit-instruction"), {
      target: { value: "change the coat" },
    });
    fireEvent.submit(screen.getByTestId("story-edit-dialog"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // The cancel lands while the batch is still being handed over.
    fireEvent.click(screen.getByTestId("story-edit-cancel"));
    const record = { ...batch(storyId, target, 1), id: "edit-2" };
    const cancel = vi
      .spyOn(storyApi, "cancel")
      .mockResolvedValue({ ...record, status: "cancelled" });
    await act(async () => {
      release(record);
    });

    // One that made it to the server all the same is taken back there, and
    // the dialog does not close over an ask it was told to take back.
    expect(cancel).toHaveBeenCalledWith("edit-2");
    expect(onClose).not.toHaveBeenCalled();
    cancel.mockRestore();
  });
});
