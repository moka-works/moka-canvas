/**
 * Laying a telling's clips down on the timeline it owns.
 *
 * The one way a telling is assembled: the fifth step's button and the film
 * card's export press both come through here, so the film that is rendered is
 * the film the step would have shown. It saves first for a reason that is the
 * server's, not this room's: the clips are laid down in the document the server
 * holds, and the material they are made of is filed there — what is still in
 * this window goes out first, and only then is the document read back, since
 * reading it first would throw the waiting work away.
 */

import { i18n } from "../../shared/i18n";
import { execute } from "../editor/commands/execute";
import { saveTrouble, useProjectStore } from "../editor/stores/projectStore";
import { assemblyCommands, assemblyDigest, planAssembly } from "./assembly";
import { saveEverything } from "./stores/storyJobStore";

/** An assembly that could not be made, with what is worth saying about it. */
export class AssembleTrouble extends Error {
  /** More to say under the message, when the room has more to say. */
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

/**
 * Assembles the telling and answers with what it laid down.
 *
 * Throws rather than answering with nothing: an assembly is what a film is
 * rendered from, and a caller that went on to render would render the telling
 * as it was, which is the whole thing this is here to prevent.
 */
export async function assembleStory(
  storyId: string,
  options: { withSubtitles: boolean },
): Promise<{ timelineId: string; units: number; seconds: string }> {
  const sayBlocked = (): AssembleTrouble => {
    const blocked = saveTrouble();
    return new AssembleTrouble(blocked.message, blocked.detail);
  };
  if (!(await saveEverything())) throw sayBlocked();
  // A change made between the save settling and the read keeps the document: a
  // plan drawn on one a step behind would lay the clips out twice, so nothing
  // is assembled until the reader asks again.
  if (!(await useProjectStore.getState().reload())) throw sayBlocked();
  const held = useProjectStore.getState().moka;
  const current =
    held === null
      ? undefined
      : (held.stories ?? []).find((each) => each.id === storyId);
  if (held === null || current === undefined) {
    throw new AssembleTrouble(i18n.t("errors:command.storyNotFound"));
  }
  const plan = planAssembly(current, held);
  const { commands, clipByAct } = assemblyCommands(current, held, plan, {
    withSubtitles: options.withSubtitles,
    ...(current.edit.timelineId === undefined
      ? {}
      : { timelineId: current.edit.timelineId }),
  });
  const added = commands.find((command) => command.type === "addTimeline");
  const timelineId =
    added?.type === "addTimeline" ? added.timeline.id : current.edit.timelineId;
  if (timelineId === undefined) {
    throw new AssembleTrouble(i18n.t("story:edit.noTimeline"));
  }
  // What was laid down, written down beside it: the film card reads the
  // telling the same way and can say whether the timeline is behind it.
  const assembledDigest = assemblyDigest(current, held, plan, {
    withSubtitles: options.withSubtitles,
    timelineId,
  });
  execute(i18n.t("story:history.assemble"), [
    ...commands,
    {
      type: "setStoryEdit",
      storyId: current.id,
      patch: { timelineId, clipByAct, assembledDigest },
    },
  ]);
  return {
    timelineId,
    units: plan.units.length,
    seconds: (plan.totalPlannedMs / 1000).toFixed(1),
  };
}
