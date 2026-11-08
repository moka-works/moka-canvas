import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { historyBoundary } from "../editor/commands/execute";
import { PanelUnfold } from "../editor/components/PanelFold";
import { PanelResizer } from "../editor/components/PanelResizer";
import { panelWidthStyle } from "../editor/components/panelWidthVars";
import { useAppStore } from "../editor/stores/appStore";
import { usePanelFolds } from "../editor/stores/panelFolds";
import { usePanelWidths } from "../editor/stores/panelWidths";
import { useProjectStore } from "../editor/stores/projectStore";
import { i18n } from "../../shared/i18n";
import { StoryFlow } from "./StoryFlow";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { StoryIcon } from "./components/StoryIcons";
import { StoryTopBar } from "./components/StoryTopBar";
import { StorySide } from "./panels/StorySide";
import { forgetTextAssets } from "./readText";
import { useStoryJobStore } from "./stores/storyJobStore";
import { useActiveStory, useStoryStore } from "./stores/storyStore";

/**
 * The story room.
 *
 * A third page beside the board and the cutting room, and the one the other
 * two are for: a premise is told here, chapter by chapter, until there is a
 * film of it. The page holds no document of its own — which story is open and
 * which step of it is being stood on is a reader's place, remembered on this
 * machine — and everything that changes a telling goes through the command
 * pipeline, so a step taken here is a step that can be undone.
 */
export function StoryPage() {
  const { t } = useTranslation();
  // The page is drawn from the stories alone: a save landing, a shelf entry
  // filed, a revision moved — none of it changes a telling, and subscribing to
  // the whole document would re-render every card for each of them.
  const stories = useProjectStore((state) => state.moka?.stories);
  const story = useActiveStory();
  const leftWidth = usePanelWidths((state) => state.left);
  const leftFolded = usePanelFolds((state) => state.left);
  const projectId = useProjectStore((state) => state.moka?.metadata.id ?? null);

  // Entering the room is a seam in the history: what is undone here is not
  // undone on a canvas, and a board's undos stop at the door.
  useEffect(() => {
    if (!projectId) return;
    useStoryStore.getState().adopt(useProjectStore.getState().moka);
    historyBoundary(i18n.t("story:page.historyBoundary"));
  }, [projectId]);

  // A story the document no longer holds — deleted here, or by an undo of the
  // command that made it — is not what the room can be looking at; the store
  // takes up the place the stories that are left leave open. Only the list is
  // watched: a save or a shelf entry does not move a story.
  useEffect(() => {
    useStoryStore.getState().adopt(useProjectStore.getState().moka);
  }, [stories]);

  /**
   * The batches out for the story being looked at.
   *
   * Read on entering the room, on the story being changed, and on the project
   * being opened again — all of which are this one effect, since what it
   * watches is the story. A batch that ended while the app was closed is read
   * into the story here; a batch still out is waited on from here.
   */
  const storyId = story?.id ?? null;
  useEffect(() => {
    void useStoryJobStore.getState().load(storyId);
  }, [storyId]);

  const pendingLeave = useStoryStore((state) => state.pendingLeave);
  const [leavingHome, setLeavingHome] = useState(false);
  const [leavingTo, setLeavingTo] = useState<
    "editing" | "clip" | "assets" | null
  >(null);
  const leaving =
    pendingLeave ??
    (leavingHome
      ? { kind: "home" as const }
      : leavingTo !== null
        ? { kind: "room" as const }
        : null);

  /**
   * Going home from here puts the project down first.
   *
   * There is no dialog about unsaved work on this page, since nothing on it
   * can leave work unsaved: what the room holds when the reader steps over is
   * flushed, and a flush that cannot land says so and keeps the reader here
   * rather than walking away from the work. What is not the document's is the
   * elements reading still to be sent, and leaving with that out is asked
   * about first.
   */
  const goHome = async () => {
    if (elementsReading()) {
      setLeavingHome(true);
      return;
    }
    await leaveRoom();
  };

  /** Whether the elements step still has reading only it can send. */
  const elementsReading = () => {
    const held = useStoryStore.getState();
    return held.step === "elements" && held.elementsBusy;
  };

  /** Whether the room may hand over to another page as it stands. */
  const onGo = (phase: "editing" | "clip" | "assets"): boolean => {
    if (!elementsReading()) return true;
    setLeavingTo(phase);
    return false;
  };

  const leaveRoom = async () => {
    const project = useProjectStore.getState();
    if (project.moka) {
      try {
        await project.flush();
      } catch {
        // The flush's own error is on the store; the toast says the rest.
      }
      const after = useProjectStore.getState();
      if (after.pending.length > 0 || after.saveStatus === "conflicted") {
        useAppStore
          .getState()
          .pushToast(
            "error",
            after.saveStatus === "conflicted"
              ? t("story:page.saveConflict")
              : (after.saveError ?? t("story:page.saveFailed")),
          );
        return;
      }
      after.close();
      useStoryStore.getState().forget();
      // The batches were that project's: a reader who put the project down is
      // not waited on for anything, and the records are read again on opening.
      useStoryJobStore.getState().reset();
      forgetTextAssets();
    }
    useAppStore.getState().setPhase("launcher");
  };

  return (
    <div className="story-page" data-testid="story-page">
      <StoryTopBar onGo={onGo} onHome={() => void goHome()} />
      <div className="story-body" style={panelWidthStyle(leftWidth, null)}>
        {leftFolded ? <PanelUnfold side="left" /> : <StorySide />}
        {!leftFolded && <PanelResizer side="left" />}
        <main className="story-stage">
          {story === null ? <StoryEmpty /> : <StoryFlow story={story} />}
        </main>
      </div>

      {leaving !== null && (
        <ConfirmDialog
          body={t("story:elements.leaveBody")}
          confirm={t("story:elements.leaveConfirm")}
          initialFocus="cancel"
          onCancel={() => {
            if (leaving.kind === "home") setLeavingHome(false);
            else if (leaving.kind === "room") setLeavingTo(null);
            else useStoryStore.getState().stay();
          }}
          onConfirm={() => {
            if (leaving.kind === "home") {
              setLeavingHome(false);
              void leaveRoom();
            } else if (leaving.kind === "room") {
              const phase = leavingTo;
              setLeavingTo(null);
              if (phase !== null) {
                useAppStore.getState().setPhase(phase);
              }
            } else {
              useStoryStore.getState().leaveNow();
            }
          }}
          testId="leave-elements"
          title={t("story:elements.leaveTitle")}
        />
      )}
    </div>
  );
}

/** A project that tells no story yet: the one thing there is to do. */
function StoryEmpty() {
  const { t } = useTranslation();
  return (
    <div className="clip-empty clip-empty-first" data-testid="story-empty">
      <StoryIcon size={30} />
      <h2>{t("story:page.emptyTitle")}</h2>
      <p>{t("story:page.emptyHint")}</p>
      <NewStoryButton />
    </div>
  );
}

/**
 * Opening the question a story is started under, from wherever the room is
 * standing empty. The question is the panel's to ask — one dialog, one place
 * that knows how a story is begun — so the button asks for it to be raised
 * rather than carrying a copy of it.
 */
function NewStoryButton() {
  const { t } = useTranslation();
  return (
    <button
      className="primary"
      data-testid="story-empty-new"
      onClick={() => useStoryStore.getState().setNewStoryOpen(true)}
      type="button"
    >
      {t("story:page.newStory")}
    </button>
  );
}
