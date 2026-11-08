import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import {
  createAct,
  createTransitionAct,
  emptyStorySlot,
} from "../../../shared/domain/factories";
import { newId } from "../../../shared/domain/ids";
import type {
  StoryAct,
  StoryDocument,
  StoryKeyframe,
} from "../../../shared/domain/types";

/**
 * A board written whole, which is how it is rearranged.
 *
 * Adding an act, moving one, taking one away: each is one write of the episode's
 * acts in the order the reader wants them, and one step of the history. A known
 * act keeps its frames and its clip through the write, since the command reads
 * the ids rather than the places.
 */
export function writeActs(
  story: StoryDocument,
  chapterId: string,
  acts: StoryAct[],
): void {
  execute(i18n.t("story:history.storyboard"), [
    { type: "setStoryActs", storyId: story.id, chapterId, acts },
  ]);
}

/** One act's shots, whole — how a shot is added to a board, moved, or taken off. */
export function writeKeyframes(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframes: StoryKeyframe[],
): void {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  writeActs(
    story,
    chapterId,
    (chapter?.acts ?? []).map((held) =>
      held.id === act.id ? { ...held, keyframes } : held,
    ),
  );
}

/** A list with one entry moved to another place in it. */
export function moved<T>(held: T[], from: number, to: number): T[] {
  const next = [...held];
  const [taken] = next.splice(from, 1);
  if (taken !== undefined) next.splice(to, 0, taken);
  return next;
}

/** The longest an act's name may be, which a split's suffix must not outrun. */
const ACT_TITLE_MAX = 40;

/** A name with the words a second half is known by, cut to the title's bound. */
function continuation(title: string): string {
  const suffix = i18n.t("story:storyboard.splitContinuation", { name: "" });
  const room = Math.max(1, ACT_TITLE_MAX - Array.from(suffix).length);
  const head = Array.from(title.trim()).slice(0, room).join("");
  return `${head}${suffix}`;
}

/**
 * One act cut in two at the seam between two of its frames.
 *
 * Both halves are written as new acts: what the old act's clip was made from is
 * no longer either of them, so neither may keep it. The frames themselves are
 * the ones the board already holds — their pictures, their clips and their
 * lines travel with them — and the act's cast and sound are copied to both,
 * since which half a character belongs to is the reader's to take away.
 */
export function splitAct(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  at: number,
): void {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  const index = chapter?.acts.indexOf(act) ?? -1;
  if (chapter === undefined || index < 0) return;
  if (at <= 0 || at >= act.keyframes.length) return;
  const common = {
    summary: act.summary,
    characterIds: [...act.characterIds],
    propIds: [...act.propIds],
    sound: { ...act.sound },
    ...(act.sceneId === undefined ? {} : { sceneId: act.sceneId }),
    ...(act.shotGranularity === undefined
      ? {}
      : { shotGranularity: act.shotGranularity }),
  };
  const head: StoryAct = {
    ...createAct(act.title),
    ...common,
    keyframes: act.keyframes.slice(0, at),
    video: emptyStorySlot(),
  };
  const tail: StoryAct = {
    ...createAct(continuation(act.title)),
    ...common,
    keyframes: act.keyframes.slice(at),
    video: emptyStorySlot(),
  };
  const acts = [...chapter.acts];
  acts.splice(index, 1, head, tail);
  writeActs(story, chapterId, acts);
}

/**
 * Two neighbouring acts made one, at the seam between them.
 *
 * The one written is a new act for the same reason a split's halves are: the
 * old clips belonged to the acts before they were joined. The shots are laid
 * end to end as they stood; the cast and sound come together, taking the first
 * act's words where both said something, since one card holds one of each.
 */
export function mergeActsAt(
  story: StoryDocument,
  chapterId: string,
  at: number,
): void {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  const above = chapter?.acts[at - 1];
  const below = chapter?.acts[at];
  if (chapter === undefined || above === undefined || below === undefined) {
    return;
  }
  if (above.transition !== undefined || below.transition !== undefined) return;
  const words = (one: string, other: string) =>
    one.trim() === ""
      ? other
      : other.trim() === ""
        ? one
        : `${one}\n\n${other}`;
  const sound = {
    music: words(above.sound.music, below.sound.music),
    sfx: words(above.sound.sfx, below.sound.sfx),
    ...((above.sound.ambience ?? "").trim() === "" &&
    (below.sound.ambience ?? "").trim() === ""
      ? {}
      : {
          ambience: words(
            above.sound.ambience ?? "",
            below.sound.ambience ?? "",
          ),
        }),
  };
  const merged: StoryAct = {
    ...createAct(above.title, words(above.summary, below.summary)),
    id: newId(),
    characterIds: [...new Set([...above.characterIds, ...below.characterIds])],
    propIds: [...new Set([...above.propIds, ...below.propIds])],
    sound,
    keyframes: [...above.keyframes, ...below.keyframes],
    video: emptyStorySlot(),
    ...(above.sceneId === undefined && below.sceneId === undefined
      ? {}
      : { sceneId: above.sceneId ?? below.sceneId }),
    ...(above.shotGranularity !== undefined &&
    above.shotGranularity === below.shotGranularity
      ? { shotGranularity: above.shotGranularity }
      : {}),
  };
  const acts = [...chapter.acts];
  acts.splice(at - 1, 2, merged);
  writeActs(story, chapterId, acts);
}

/** A bridge added at the seam it was asked for. */
export function addTransitionAt(
  story: StoryDocument,
  chapterId: string,
  at: number,
): void {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  const above = chapter?.acts[at - 1];
  const below = chapter?.acts[at];
  if (chapter === undefined || above === undefined || below === undefined) {
    return;
  }
  if (above.transition !== undefined || below.transition !== undefined) return;
  const acts = [...chapter.acts];
  acts.splice(
    at,
    0,
    createTransitionAct(
      i18n.t("story:storyboard.newTransition", { at: at + 1 }),
    ),
  );
  writeActs(story, chapterId, acts);
}
