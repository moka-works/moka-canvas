/**
 * The batches a story room has out, and what happens when they come back.
 *
 * A batch is minutes of a provider's time, so what is held here is not only the
 * list: it is the waiting, the reading of an answer into the document, and the
 * asking again for the pieces that did not come back. The page says what step
 * it is on; this says what is being tried for it.
 *
 * Nothing is remembered between sessions, and nothing has to be. The server
 * keeps the records, so a room opened tomorrow lists the same batches — and a
 * batch that ended while nobody was looking is read into the story then. What
 * keeps that from being a second reading of everything ever asked for is the
 * record's own memory: a batch whose answer is in the story says so, and no
 * room writes such an answer in again, however long ago it landed and whatever
 * the reader has said to the story since.
 */

import { create } from "zustand";

import {
  storyApi,
  type StoryJobItem,
  type StoryJobItemDraft,
  type StoryJobKind,
  type StoryJobRecord,
  type StoryTarget,
} from "../../../api/story";
import {
  errorText,
  isApiError,
  isConfigurationCode,
} from "../../../api/client";
import { failureText } from "../../../shared/i18n/problems";
import type { StoryDocument } from "../../../shared/domain/types";
import type { StoryStep } from "../../../shared/domain/story";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { applyJobResults } from "../jobs/apply";
import { itemsForTargets, jobKey } from "../jobs/plan";
import { storyAskModel } from "./storyModels";
import { useStoryStore } from "./storyStore";

/** How often a batch that is running is looked at. It runs for minutes. */
export const POLL_MS = 1500;

/** Which steps a batch of each kind is doing the work of. */
const STEP_OF_KIND: Record<StoryJobKind, StoryStep> = {
  outline: "outline",
  elements: "elements",
  storyboard: "storyboard",
  elementArt: "elements",
  keyframeArt: "storyboard",
  actVideo: "storyboard",
  keyframeVideo: "storyboard",
  voice: "storyboard",
  music: "storyboard",
};

function isRunning(status: StoryJobRecord["status"]): boolean {
  return status === "queued" || status === "running";
}

/**
 * The batches a look leaves in the room's hands.
 *
 * A look answers with the newest records and every answer still owed one: a
 * batch that settled and was read into the story drops out of it once enough
 * newer ones have been asked for, and the room lets it go with the look that
 * dropped it. Held on to instead, the room goes on reading a list the server
 * has stopped carrying — a record whose answer the story has long held — until
 * a reload starts the list over.
 *
 * What the look did not carry is kept while it can still be owed: a batch
 * still out, or one whose answer no room has read. A look that raced the ask
 * which made such a batch would not carry it, and dropping it there would
 * drop the answer the ask is for.
 */
function carriedOver(
  held: StoryJobRecord[],
  storyId: string,
  listed: Set<string>,
): StoryJobRecord[] {
  return held.filter(
    (record) =>
      record.storyId !== storyId ||
      listed.has(record.id) ||
      isRunning(record.status) ||
      record.readAt === undefined,
  );
}

function toast(
  kind: "info" | "success" | "error",
  message: string,
  choice?: { label: string; go: () => void },
  detail?: string,
): void {
  useAppStore.getState().pushToast(kind, message, choice, detail);
}

/**
 * What a batch that came back short has to say.
 *
 * The count, and the reason under it: a reader told only how many pieces did
 * not come back has been told the one thing they can see for themselves. One
 * reason is the whole of it — the toast keeps the rest of a long one — and
 * several are laid out under the line, because a batch can lose one piece to
 * a busy provider and another to a model that is not configured.
 *
 * Said apart from the words: whether every one of the failures is a
 * configuration the reader has to fix, which is what decides between offering
 * the place that fixes it and offering the same ask again.
 */
function failedTrouble(
  failed: StoryJobRecord["items"],
  record: StoryJobRecord,
): {
  message: string;
  detail?: string;
  blockedByConfiguration?: boolean;
} {
  const reasons = [
    ...new Set(
      failed
        .map((item) => failureText(item))
        .filter((said): said is string => said !== null),
    ),
  ];
  const count = { failed: failed.length, total: record.items.length };
  const first = reasons[0];
  const message =
    first === undefined
      ? i18n.t("story:jobs.failed", count)
      : i18n.t("story:jobs.failedWith", { ...count, reason: first });
  return {
    message,
    ...(reasons.length > 1 ? { detail: reasons.join("\n") } : {}),
    ...(failed.every((item) => isConfigurationCode(item.errorCode))
      ? { blockedByConfiguration: true }
      : {}),
  };
}

/**
 * Saves everything the window is holding, and says whether it all went out.
 *
 * One flush takes the commands it was sent with, so anything written while it
 * was on its way waits for the next one — and a batch asked for on the tail of
 * a chapter written a moment ago is asked for against a document that does not
 * have it yet. Which is what this is for: the server reads the document, so
 * everything in the window has to be the server's before anything is asked of
 * it — or before the document is read back whole, which would drop what was
 * still waiting.
 */
export async function saveEverything(): Promise<boolean> {
  for (let turn = 0; turn < 8; turn += 1) {
    await useProjectStore.getState().flush();
    const { pending, saveStatus } = useProjectStore.getState();
    if (pending.length === 0) return true;
    // Nothing is on its way any more, and something is still waiting: the save
    // was refused or could not be made, and asking now would ask against a
    // document the server does not hold.
    if (saveStatus !== "saved") return false;
  }
  return useProjectStore.getState().pending.length === 0;
}

interface StoryJobState {
  /** The story these batches belong to, which is the one being looked at. */
  storyId: string | null;
  /** That story's batches, newest first. */
  jobs: StoryJobRecord[];
  starting: boolean;
  /** Why starting failed, shown beside the button that asked. */
  error: string | null;
  /** Batches whose answers are being written into the document just now. */
  applying: string[];
  /** Lists the story's batches and reads in whatever has come back. */
  load: (storyId: string | null) => Promise<void>;
  start: (
    storyId: string,
    kind: StoryJobKind,
    items: StoryJobItemDraft[],
    /** The model to ask of; undefined is the room's own pick, as before. */
    model?: string | null,
  ) => Promise<StoryJobRecord | null>;
  /**
   * Asks one wave of pieces after another, each wave settled before the next
   * is sent: a telling's lines may be read by several models, and a batch
   * carries one model, so what is one ask to a reader is several to the room.
   */
  startWaves: (
    storyId: string,
    kind: StoryJobKind,
    waves: Array<{ model: string | null; items: StoryJobItemDraft[] }>,
  ) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /** Fetches one batch and reads it in, which is what a poll does. */
  adopt: (id: string) => Promise<void>;
  reset: () => void;
}

/**
 * What has been read out of a batch so far, by batch id.
 *
 * An optimisation, not the record: what says whether an answer has been applied
 * is the document itself, and reading an applied answer again writes nothing.
 * This is here so a room that is open all afternoon does not reload the project
 * once a second for batches that ended hours ago — and so a batch still running
 * is known by the pieces of it already written in.
 */
interface BatchRead {
  /** The pieces whose answers are already written into the document. */
  pieces: Set<string>;
  /** How many answers of this batch were written in all. */
  applied: number;
  /** Whether the batch's ending — its count, and what did not come back — is said. */
  endingSaid: boolean;
  /**
   * Whether the document refusing the batch has been said.
   *
   * A refusal is not a moment: the batch stays unread, and every look after it
   * tries the same answer against the same document until the conflict is
   * dealt with. Said once, not once a look.
   */
  refusalSaid: boolean;
}

let readIn = new Map<string, BatchRead>();

/**
 * The batches this room has watched be made, by the id of the record.
 *
 * A step's red badge counts the pieces that did not come back, and counts them
 * over these: a batch the room asked for itself, or one it took in still out.
 * A failure that came home before the room was looking — an ending from while
 * the app was closed, or a record the list has carried since some other day —
 * is not the room's news, and a number standing over the step until the
 * project is opened again says nothing a reader can act on.
 *
 * Held in memory and started over when the room takes up a story, so a project
 * opened again counts what is happening now rather than everything that ever
 * went wrong.
 */
let watched = new Set<string>();

/** Takes these records in as ones the room is watching, while they are out. */
function watching(records: StoryJobRecord[]): void {
  for (const record of records) {
    if (isRunning(record.status)) watched.add(record.id);
  }
}

/**
 * The places a batch being handed over is asking for, named by story and place.
 *
 * Read only while an ask is on its way, which is the one moment the jobs list
 * cannot say that a place is already being asked for.
 */
let handingOver = new Set<string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The trouble a look last reported, so that a look which keeps failing at the
 * same thing says it once.
 *
 * A look comes every second and a half while a batch is out, and the local
 * process being unreachable is not fifteen pieces of news a minute. Held by
 * the reason itself: one that changes is a different trouble and is said, and
 * a look that gets through clears it.
 */
let lookTrouble: string | null = null;

/** Says why a look failed, once per reason, and never twice in a row. */
function sayLookTrouble(reason: string): void {
  if (reason === lookTrouble) return;
  lookTrouble = reason;
  toast("error", i18n.t("story:jobs.lookFailed", { reason }));
}

/** The same, for a failure in words of its own. */
function sayLookProblem(problem: unknown): void {
  sayLookTrouble(errorText(problem).message);
}

export const useStoryJobStore = create<StoryJobState>()((set, get) => {
  /**
   * Reads what has come home of a batch into the document, whether it just
   * landed or landed while the app was closed.
   *
   * Read as the batch runs rather than only once it ends: a batch of drawings
   * comes home one picture at a time, and each one is shown as it lands rather
   * than the whole lot at the end. A look that brought answers for several
   * batches reloads the project once for all of them, and for a reason: the
   * assets a batch filed arrived on the server's side of the document, and a
   * command that points at one of them is refused until this client has been
   * told about it.
   */
  const readAnswers = async (records: StoryJobRecord[]): Promise<void> => {
    // Oldest first, though the room lists batches newest first: a batch asked
    // for later than another is the newer word on the places both of them
    // answered for, so reading them in the order they were asked for is what
    // leaves the newest one standing. Turned round before the sort, so that
    // two batches asked for in the same breath — a retry a moment after the
    // ask it retries — are read in the order the room listed them.
    const inOrder = [...records]
      .reverse()
      .sort((one, other) => one.createdAt.localeCompare(other.createdAt));
    const waiting = inOrder.flatMap((record) => {
      // An answer already read into the story is not read into it a second
      // time, whatever it says: the reader has had it, and what they have said
      // to the story since — a description rewritten, an element added or
      // dropped — is what reading it again would write over.
      if (record.readAt !== undefined) return [];
      const known = readIn.get(record.id) ?? {
        pieces: new Set<string>(),
        applied: 0,
        endingSaid: false,
        refusalSaid: false,
      };
      readIn.set(record.id, known);
      const fresh = record.items.filter(
        (item) => item.status === "succeeded" && !known.pieces.has(item.id),
      );
      const ending = !isRunning(record.status);
      // A batch still going with nothing new to write has nothing to say; one
      // that has ended is seen to even with nothing new in it, since the
      // record itself is still owed the note that its answer is in.
      if (fresh.length === 0 && !ending) return [];
      return [{ record, known, fresh, ending }];
    });
    if (waiting.length === 0) return;
    if (waiting.some(({ fresh }) => fresh.length > 0)) {
      // What the answers are written onto has to be the document as it stands,
      // so anything still waiting to be saved goes first: a reload would read
      // the server's copy over whatever the reader typed a moment ago. A save
      // that cannot land leaves the answers on their records for the next look
      // rather than losing the reader's work to read them in.
      if (!(await saveEverything())) return;
      try {
        if (!(await useProjectStore.getState().reload())) {
          // A change made between the save settling and the read keeps the
          // document. The answers are on the records and are read in by the
          // next look, once what is waiting has gone out.
          sayLookTrouble(saveTrouble().message);
          return;
        }
        lookTrouble = null;
      } catch (problem) {
        // The project could not be read again, so nothing can be written into
        // it just now. The answers are on the records and are read in by the
        // next look — and by the room the next time it stands up. Said once,
        // because the next look is a second and a half away.
        sayLookProblem(problem);
        return;
      }
    }
    set({
      applying: [...get().applying, ...waiting.map(({ record }) => record.id)],
    });
    try {
      const settled: string[] = [];
      for (const { record, known, fresh, ending } of waiting) {
        if (fresh.length > 0) {
          const report = applyJobResults({ ...record, items: fresh });
          if (report.refused === true) {
            // The document would not take it, so it is not in: nothing of the
            // answer is written down about it and the next look asks again. The
            // reason is said once — a look comes every second and a half, and a
            // reader does not need the same refusal fifteen times a minute.
            if (!known.refusalSaid) {
              known.refusalSaid = true;
              toast("error", report.notes.join(" "));
            }
            continue;
          }
          if (known.refusalSaid) known.refusalSaid = false;
          for (const item of fresh) known.pieces.add(item.id);
          known.applied += report.applied;
          if (report.notes.length > 0) toast("info", report.notes.join(" "));
        }
        if (ending && !known.endingSaid) {
          known.endingSaid = true;
          const failedItems = record.items.filter(
            (item) => item.status === "failed",
          );
          if (known.applied > 0) {
            toast(
              "success",
              i18n.t("story:jobs.done", { count: known.applied }),
            );
          }
          if (failedItems.length > 0) {
            const story = useProjectStore
              .getState()
              .moka?.stories?.find((held) => held.id === record.storyId);
            const trouble = failedTrouble(failedItems, record);
            // A batch that lost every piece to a missing voice is repaired on
            // the character cards the voices are written on — a step back
            // into the telling, not a page of Settings — and one that lost
            // every piece for want of a recording the same way: the row the
            // recording is picked on is on those cards too.
            const voiceless = failedItems.every(
              (item) => item.errorCode === "MODEL_VOICE_REQUIRED",
            );
            const unreferenced = failedItems.every(
              (item) => item.errorCode === "MODEL_REFERENCE_AUDIO_REQUIRED",
            );
            toast(
              "error",
              voiceless
                ? i18n.t("story:jobs.voiceMissing")
                : unreferenced
                  ? i18n.t("story:jobs.referenceMissing")
                  : trouble.message,
              voiceless
                ? {
                    label: i18n.t("story:jobs.voiceMissingGo"),
                    go: () => useStoryStore.getState().goStep("elements"),
                  }
                : unreferenced
                  ? {
                      label: i18n.t("story:jobs.referenceMissingGo"),
                      go: () => useStoryStore.getState().goStep("elements"),
                    }
                  : trouble.blockedByConfiguration === true
                    ? {
                        // Every one of them failed at its own model, and a batch
                        // is one step's worth of one capability, so the first
                        // failure names the page that holds the fix.
                        label: i18n.t("story:jobs.openSettings"),
                        go: () =>
                          useModelStore
                            .getState()
                            .openSettings(failedItems[0].capability),
                      }
                    : story === undefined
                      ? undefined
                      : {
                          label: i18n.t("story:jobs.retryFailed"),
                          go: () => void retryFailed(story, record),
                        },
              trouble.detail,
            );
          }
        }
        if (ending) settled.push(record.id);
      }
      // A batch is written down as read only once what it answered is really
      // in the story: nothing of this look's may still be waiting to be saved,
      // or the note would outlive the change it is about — no room reads that
      // batch again, and an answer lost that way is lost for good. A save that
      // cannot land leaves the note for the next look, which sees the batch as
      // it stands.
      if (settled.length > 0 && (await saveEverything())) {
        await markRead(settled);
      }
    } finally {
      const finished = new Set(waiting.map(({ record }) => record.id));
      set({ applying: get().applying.filter((id) => !finished.has(id)) });
    }
  };

  /** Puts a record where it belongs: newest first, replacing an older copy. */
  const integrate = (record: StoryJobRecord): void => {
    const held = get().jobs;
    const at = held.findIndex((job) => job.id === record.id);
    const jobs =
      at === -1
        ? [record, ...held]
        : held.map((job) => (job.id === record.id ? record : job));
    set({ jobs });
  };

  /**
   * Writes down that these batches' answers are in their story.
   *
   * One ask each, and a shrug at an ask that cannot be made: a note that does
   * not land leaves the record unread, which the next look sees and tries
   * again — the one thing worse than saying it twice is not saying it at all.
   */
  const markRead = async (ids: string[]): Promise<void> => {
    for (const id of ids) {
      try {
        integrate(await storyApi.readIn(id));
        lookTrouble = null;
      } catch (problem) {
        // Said again by the next look, which is where the note is retried —
        // and said out loud the first time it fails, since a note that does
        // not land is a batch the room will read into the story a second time.
        sayLookProblem(problem);
      }
    }
  };

  const pollOnce = async (): Promise<void> => {
    const { storyId, jobs } = get();
    if (storyId === null || !jobs.some((job) => isRunning(job.status))) {
      stopPolling();
      return;
    }
    try {
      const read = await storyApi.list(storyId);
      lookTrouble = null;
      watching(read);
      set({
        jobs: carriedOver(
          get().jobs,
          storyId,
          new Set(read.map((record) => record.id)),
        ),
      });
      for (const record of read) integrate(record);
      await readAnswers(read);
    } catch (problem) {
      // A poll that failed is a poll: the next one asks again, and a room that
      // has been closed has stopped asking anyway. What it is not is silent: a
      // process that has gone away would otherwise leave the room waiting for
      // answers that are never coming.
      sayLookProblem(problem);
    }
    if (!get().jobs.some((job) => isRunning(job.status))) stopPolling();
  };

  const startPolling = (): void => {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => void pollOnce(), POLL_MS);
  };

  const stopPolling = (): void => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  return {
    storyId: null,
    jobs: [],
    starting: false,
    error: null,
    applying: [],

    async load(storyId) {
      if (storyId === null) {
        get().reset();
        return;
      }
      // What was read in for another story says nothing about this one, and a
      // room reopened reads the whole story's batches again by design — the
      // batches it was watching with them, since the count of pieces that did
      // not come back is the room's own and starts from this reading.
      if (get().storyId !== storyId) {
        readIn = new Map<string, BatchRead>();
        watched = new Set<string>();
      }
      set({ storyId });
      try {
        const read = await storyApi.list(storyId);
        watching(read);
        set({ jobs: read, error: null });
        await readAnswers(read);
        if (read.some((record) => isRunning(record.status))) startPolling();
        else stopPolling();
      } catch (problem) {
        set({
          error: problem instanceof Error ? problem.message : String(problem),
        });
      }
    },

    async start(storyId, kind, items, model) {
      // A place asked for twice at once is paid for twice: the second ask is
      // planned against a document the first has not finished saving, so it
      // carries the same description and the same reference as the first. The
      // pieces on their way are remembered by their own names, and one that is
      // already out is left to come home. Places beside it are unaffected.
      const asking = items.map((item) => `${storyId}:${jobKey(item.target)}`);
      if (asking.some((key) => handingOver.has(key))) return null;
      for (const key of asking) handingOver.add(key);
      set({ starting: true, error: null });
      try {
        // The server reads the document it holds when it is asked for a batch:
        // a story that is still only in this window is a story it has never
        // heard of, and a chapter written a moment ago is not there to be
        // asked about. So what is still waiting to be saved goes first.
        if (!(await saveEverything())) {
          set({ starting: false });
          const blocked = saveTrouble();
          toast("error", blocked.message, undefined, blocked.detail);
          return null;
        }
        // Read here rather than where a batch is planned: every ask is made
        // with the model the room is set to now, which is what the pickers in
        // the steps stand for — a retry after the picker was changed is asked
        // of the model the reader changed it to. A caller naming a model asks
        // of that one instead, which is what a character's own voice does.
        const record = await storyApi.start(
          storyId,
          kind,
          items,
          model === undefined ? storyAskModel(kind) : model,
        );
        // Watched from the asking whatever the record comes back as: a batch
        // the room asked for is the room's own news.
        watched.add(record.id);
        // A batch started for the story the room is showing: the list it is
        // put at the head of is that story's, whichever one it was.
        set({ storyId, jobs: [record, ...get().jobs], starting: false });
        startPolling();
        return record;
      } catch (problem) {
        set({ starting: false });
        if (isApiError(problem, "PROVIDER_NOT_CONFIGURED")) {
          toast("error", problem.message, {
            label: i18n.t("story:jobs.openSettings"),
            go: () => useModelStore.getState().openSettings(),
          });
        } else {
          set({
            error: problem instanceof Error ? problem.message : String(problem),
          });
        }
        return null;
      } finally {
        for (const key of asking) handingOver.delete(key);
      }
    },

    async startWaves(storyId, kind, waves) {
      // One wave at a time, and the next only once the one before it has
      // settled: the batches share a room, and a wave that failed is not a
      // reason to lose the waves that have not been sent — what did not come
      // back is on its record, and the badge beside the step says so.
      for (const wave of waves) {
        if (wave.items.length === 0) continue;
        const record = await get().start(storyId, kind, wave.items, wave.model);
        if (record === null) return;
        await awaitSettled(record.id);
      }
    },

    async cancel(id) {
      const record = await storyApi.cancel(id);
      integrate(record);
      await readAnswers([record]);
    },

    async adopt(id) {
      const record = await storyApi.get(id);
      integrate(record);
      await readAnswers([record]);
    },

    reset() {
      stopPolling();
      readIn = new Map<string, BatchRead>();
      watched = new Set<string>();
      handingOver = new Set<string>();
      lookTrouble = null;
      set({
        storyId: null,
        jobs: [],
        starting: false,
        error: null,
        applying: [],
      });
    },
  };
});

/**
 * Waits out one batch, whichever way it ends.
 *
 * The room's own poll goes on looking the batch up all the same; this is the
 * asker's own wait, so that the wave after this one is not planned against a
 * story the answers have not been read into yet.
 */
async function awaitSettled(id: string): Promise<void> {
  for (;;) {
    try {
      await useStoryJobStore.getState().adopt(id);
    } catch {
      // A batch that cannot be looked up cannot be waited on: the room's own
      // poll goes on asking, and what came back is read into the story then.
      return;
    }
    const held = useStoryJobStore.getState().jobs.find((job) => job.id === id);
    if (held === undefined || !isRunning(held.status)) return;
    await new Promise((settle) => setTimeout(settle, POLL_MS));
  }
}

/**
 * Asks again for the pieces of a batch that failed, planned from the story as
 * it stands now.
 *
 * Not the same ask twice: a description edited since the batch went out belongs
 * to the new ask, and so does a reference that has been redrawn. A manuscript's
 * part is the exception, and not really one: the part is the ask, and the file
 * it was cut from is the same file — planning it again would cut the manuscript
 * at edges the first ask did not use.
 */
export async function retryFailed(
  story: StoryDocument,
  job: StoryJobRecord,
): Promise<void> {
  const failed = job.items.filter((item) => item.status === "failed");
  if (failed.length === 0) return;
  // A place's ask is one piece per name however many of the old batch's pieces
  // failed: an act filmed in pieces that lost two of them is asked for again as
  // the act, and not as the same piece twice.
  const planned = failed.flatMap((item) => againFor(story, item));
  const items = [...new Map(planned.map((item) => [item.id, item])).values()];
  if (items.length === 0) return;
  await useStoryJobStore.getState().start(story.id, job.kind, items);
}

/** One failed piece, as it is asked for the second time. */
function againFor(
  story: StoryDocument,
  item: StoryJobRecord["items"][number],
): StoryJobItemDraft[] {
  if (item.target.kind === "outline" && PART_ITEM.test(item.id)) {
    return [
      {
        id: item.id,
        target: item.target,
        capability: item.capability,
        prompt: item.prompt,
        system: item.system,
      },
    ];
  }
  return itemsForTargets(story, [item.target]);
}

/** An outline piece that answers for one part of a manuscript, not for all. */
const PART_ITEM = /^outline:\d+$/;

/**
 * Asks again for one episode that was written from a manuscript's part.
 *
 * The part is not planned again for the same reason a failed one is not: the
 * ask for a part is the part itself. What the record kept is sent again, so an
 * episode the reader did not like comes back from the same words it came from
 * the first time.
 */
export async function redoChapterPart(
  story: StoryDocument,
  chapterIndex: number,
): Promise<void> {
  const id = `outline:${chapterIndex + 1}`;
  const recorded = useStoryJobStore
    .getState()
    .jobs.filter((job) => job.storyId === story.id && job.kind === "outline")
    .flatMap((job) => job.items)
    .find((item) => item.id === id);
  if (recorded === undefined) {
    toast("info", i18n.t("story:outline.partGone"));
    return;
  }
  await useStoryJobStore.getState().start(story.id, "outline", [
    {
      id,
      target: { kind: "outline" },
      capability: recorded.capability,
      prompt: recorded.prompt,
      system: recorded.system,
    },
  ]);
}

/** Makes one place again, from the story as it stands now. */
export async function redoTarget(
  story: StoryDocument,
  target: StoryJobRecord["items"][number]["target"],
): Promise<void> {
  const items = itemsForTargets(story, [target]);
  if (items.length === 0) return;
  await useStoryJobStore
    .getState()
    .start(story.id, target.kind as StoryJobKind, items);
}

// -----------------------------------------------------------------------------
// What the room reads off the batches
// -----------------------------------------------------------------------------

/** How far along a set of pieces is, counted in pieces. */
export function piecesProgress(items: StoryJobItem[]): {
  done: number;
  total: number;
} {
  const done = items.filter((item) => !isRunning(item.status)).length;
  return { done, total: items.length };
}

/** The same, for a whole batch. */
export function jobProgress(job: StoryJobRecord): {
  done: number;
  total: number;
} {
  return piecesProgress(job.items);
}

/** The batch of this one kind a story has out just now, if it has one. */
export function kindJob(
  jobs: StoryJobRecord[],
  kind: StoryJobKind,
): StoryJobRecord | null {
  return jobs.find((job) => job.kind === kind && isRunning(job.status)) ?? null;
}

/** Whether a story has a batch of this one kind out just now. */
export function kindRunning(
  jobs: StoryJobRecord[],
  kind: StoryJobKind,
): boolean {
  return kindJob(jobs, kind) !== null;
}

/** Given a story's batches, only the ones working on this step. */
function forStep(
  jobs: StoryJobRecord[],
  storyId: string | null,
  step: StoryStep,
): StoryJobRecord[] {
  if (storyId === null) return [];
  return jobs.filter(
    (job) => job.storyId === storyId && STEP_OF_KIND[job.kind] === step,
  );
}

/**
 * What a step's badge stands on: the pieces it is short of, which batch says
 * so, and the reasons under the count.
 */
export interface StepFailure {
  failed: number;
  jobId: string;
  reasons: string[];
}

/**
 * The pieces of a step that failed among the batches it is handed, and what
 * each of them said.
 *
 * The badge is this reading taken over the batches the room has watched
 * ({@link watchedStepFailure}); what a batch from before the room was looking
 * says is history, and history is not a count that stands over the step.
 *
 * The reasons travel with the count because the bubble over the badge is the
 * only place a step says why it is red: a reader who has to open the batch to
 * find out what went wrong will not.
 *
 * A piece that came back later is not a piece that has not come back: the
 * batches are read newest first, and a piece an answer names takes the
 * failures of that piece off the step with it. Asking again for what did not
 * come back is what the badge is for, and one that outlived the answer it
 * asked for would go on saying a step is short of pieces it holds.
 */
export function stepFailure(
  jobs: StoryJobRecord[],
  storyId: string | null,
  step: StoryStep,
): StepFailure | null {
  const answered = new Set<string>();
  for (const job of forStep(jobs, storyId, step)) {
    const failed = job.items.filter(
      (item) => item.status === "failed" && !answered.has(item.id),
    );
    for (const item of job.items) {
      if (item.status === "succeeded") answered.add(item.id);
    }
    if (failed.length > 0) {
      return {
        failed: failed.length,
        jobId: job.id,
        reasons: [
          ...new Set(
            failed
              .map((item) => failureText(item))
              .filter((said): said is string => said !== null),
          ),
        ],
      };
    }
  }
  return null;
}

/** Whether a place is being made just now, by whichever batch is making it. */
export function targetRunning(
  jobs: StoryJobRecord[],
  storyId: string | null,
  key: string,
): boolean {
  if (storyId === null) return false;
  return jobs.some(
    (job) =>
      job.storyId === storyId &&
      isRunning(job.status) &&
      job.items.some(
        (item) => jobKey(item.target) === key && isRunning(item.status),
      ),
  );
}

/**
 * Whether the piece kept under this name is out just now, by the name it keeps.
 *
 * A place is not always enough to name what is being made — a telling's
 * chapters are one table, and each chapter's own ask is a numbered piece of it
 * — so a step that asks for one chapter at a time reads the piece itself.
 */
export function pieceRunning(jobs: StoryJobRecord[], id: string): boolean {
  return jobs.some((job) =>
    job.items.some((item) => item.id === id && isRunning(item.status)),
  );
}

/** Whether a place a piece is being made for stands inside one act. */
function inAct(target: StoryTarget, chapterId: string, actId: string): boolean {
  return (
    (target.kind === "keyframeArt" ||
      target.kind === "keyframeVideo" ||
      target.kind === "actVideo" ||
      target.kind === "voice" ||
      target.kind === "lineVoice" ||
      target.kind === "music") &&
    target.chapterId === chapterId &&
    target.actId === actId
  );
}

/** One batch working inside an act, with the pieces of it that stand there. */
export interface ActRun {
  job: StoryJobRecord;
  items: StoryJobItem[];
}

/**
 * The batches working inside one act just now, each with the pieces of it that
 * stand there: a shot being drawn or filmed, the act's own clip, its lines, its
 * score.
 *
 * A batch stands in the act while any of its pieces there is still out, and in
 * the act beside it just the same, since one ask may reach across a board.
 * Nothing is folded together: two batches working in one act are two things the
 * reader is waiting on, each with a clock of its own.
 */
export function actRuns(
  jobs: StoryJobRecord[],
  chapterId: string,
  actId: string,
): ActRun[] {
  const runs: ActRun[] = [];
  for (const job of jobs) {
    if (!isRunning(job.status)) continue;
    const items = job.items.filter((item) =>
      inAct(item.target, chapterId, actId),
    );
    if (!items.some((item) => isRunning(item.status))) continue;
    runs.push({ job, items });
  }
  return runs;
}

/**
 * The batches writing one episode's own board just now.
 *
 * A board is one numbered piece per episode, so a batch stands here while that
 * episode's piece is still out — and the bar belongs to the episode rather than
 * to anything inside it, which is why it is read apart from the acts.
 */
export function boardRuns(
  jobs: StoryJobRecord[],
  chapterId: string,
): StoryJobRecord[] {
  return jobs.filter(
    (job) =>
      job.kind === "storyboard" &&
      isRunning(job.status) &&
      job.items.some(
        (item) =>
          item.target.kind === "storyboard" &&
          item.target.chapterId === chapterId &&
          isRunning(item.status),
      ),
  );
}

/** A story's batches, newest first, as the room shows them. */
export function useStoryJobs(storyId: string | null): StoryJobRecord[] {
  const jobs = useStoryJobStore((state) => state.jobs);
  const held = useStoryJobStore((state) => state.storyId);
  if (storyId === null || held !== storyId) return [];
  return jobs.filter((job) => job.storyId === storyId);
}

/**
 * The failures standing on one step, for the badge and the retry wording.
 *
 * Counted over the batches the room has watched and not over everything the
 * server holds: a step stays marked for a failure the room saw come home, and
 * a project opened again starts the count over.
 */
export function watchedStepFailure(
  jobs: StoryJobRecord[],
  storyId: string | null,
  step: StoryStep,
): StepFailure | null {
  return stepFailure(
    jobs.filter((job) => watched.has(job.id)),
    storyId,
    step,
  );
}

/** The same, for the step the room is showing: the badge's own reading. */
export function useStoryStepFailure(
  storyId: string | null,
  step: StoryStep,
): StepFailure | null {
  const jobs = useStoryJobs(storyId);
  return watchedStepFailure(jobs, storyId, step);
}

/** Whether the place this key names is being made just now. */
export function useTargetRunning(storyId: string | null, key: string): boolean {
  const jobs = useStoryJobs(storyId);
  return targetRunning(jobs, storyId, key);
}

/** The batch a story is running just now, if it is running one. */
export function useRunningJob(storyId: string | null): StoryJobRecord | null {
  const jobs = useStoryJobs(storyId);
  return jobs.find((job) => isRunning(job.status)) ?? null;
}

/**
 * The one way a step's button asks for work.
 *
 * A step plans its pieces ({@link planOutline} and its sisters) and hands them
 * over; what happens next — the wait, the reading in, the toast when it cannot
 * start — is not the step's to tell. A button with nothing to ask for says so
 * rather than starting a batch that would come back empty.
 */
export function useStoryRun(): (
  storyId: string,
  kind: StoryJobKind,
  items: StoryJobItemDraft[],
) => Promise<void> {
  const start = useStoryJobStore((state) => state.start);
  return async (storyId, kind, items) => {
    if (items.length === 0) {
      toast("info", i18n.t("story:jobs.nothingToAsk"));
      return;
    }
    await start(storyId, kind, items);
  };
}

/**
 * The same, for work that is several asks: a telling's lines read in the
 * voices of whoever speaks them, one model's worth of them at a time.
 */
export function useStoryWavesRun(): (
  storyId: string,
  kind: StoryJobKind,
  waves: Array<{ model: string | null; items: StoryJobItemDraft[] }>,
) => Promise<void> {
  const startWaves = useStoryJobStore((state) => state.startWaves);
  return async (storyId, kind, waves) => {
    const promised = waves.filter((wave) => wave.items.length > 0);
    if (promised.length === 0) {
      toast("info", i18n.t("story:jobs.nothingToAsk"));
      return;
    }
    await startWaves(storyId, kind, promised);
  };
}
