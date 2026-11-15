/**
 * What the story's batches are working on just now, place by place.
 *
 * A piece of a batch is out at the provider only once it has one of its model's
 * slots; the rest wait their turn. Both are the room's own news but not the
 * same news: a place holding a slot is being made, while one waiting for a slot
 * is in line behind the others, and a reader looking at a board of a dozen
 * missing shots is owed the difference. The count and the place in line travel
 * together, so a queued place says where it stands rather than only that it is
 * waiting.
 */

import type { TFunction } from "i18next";

import type { StoryJobRecord } from "../../../api/story";
import { jobKey } from "./plan";

/** A place a batch is working on: holding a model's slot, or waiting for one. */
export type PlaceBusy =
  { state: "running" } | { state: "queued"; at: number; of: number };

/**
 * Every place the given batches are working on, by the name a place is known
 * by. A place named by two batches at once is being made if either has its
 * slot out; otherwise it waits in the earlier of the two queues.
 */
export function busyPlaces(jobs: StoryJobRecord[]): Map<string, PlaceBusy> {
  const places = new Map<string, PlaceBusy>();
  for (const job of jobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    const waiting = job.items.filter((item) => item.status === "queued");
    for (const item of job.items) {
      if (item.status !== "queued" && item.status !== "running") continue;
      const next: PlaceBusy =
        item.status === "running"
          ? { state: "running" }
          : {
              state: "queued",
              at: waiting.indexOf(item) + 1,
              of: waiting.length,
            };
      const key = jobKey(item.target);
      const held = places.get(key);
      if (held === undefined || next.state === "running") {
        places.set(key, next);
      }
    }
  }
  return places;
}

/** One place's state from the states of several pieces making it, any of them
    with a slot out being what the place is doing. */
export function mergePlaces(
  states: Array<PlaceBusy | undefined>,
): PlaceBusy | undefined {
  const held = states.filter(
    (state): state is PlaceBusy => state !== undefined,
  );
  for (const state of held) {
    if (state.state === "running") return state;
  }
  return held.reduce<PlaceBusy | undefined>((first, state) => {
    if (first === undefined) return state;
    return state.state === "queued" &&
      first.state === "queued" &&
      state.at < first.at
      ? state
      : first;
  }, undefined);
}

/** What a place says it is doing, in the reader's own words. */
export function placeText(t: TFunction, busy: PlaceBusy): string {
  return busy.state === "running"
    ? t("story:panels.drawing")
    : t("story:panels.queued", { at: busy.at, of: busy.of });
}
