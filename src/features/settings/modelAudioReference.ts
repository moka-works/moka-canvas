/**
 * What a video model's converter promises about a speaker's recording, as the
 * model pickers say it.
 *
 * The numbers are the converter's own and optional: a service that conditions
 * more rows per window names a shorter clip, one that pays per recording names
 * how many speakers it reads, and one that names neither takes every recorded
 * speaker over the model's whole clip. The pickers show the numbers beside the
 * model's name so a choice is made on what it can do rather than on its label.
 */
import type { TFunction } from "i18next";

import type { ModelView } from "../../api";
import type { ProtocolGroups } from "../../api/models";
import { protocolFeatures } from "./modelStore";

/** One video model's recording ability. */
export interface AudioReferenceAbility {
  supported: boolean;
  /** The longest clip it reads a recording over; null means no window of its own. */
  seconds: number | null;
  /** How many speakers it reads in one clip; null means every recorded speaker. */
  speakers: number | null;
}

const NOTHING: AudioReferenceAbility = {
  supported: false,
  seconds: null,
  speakers: null,
};

/** The ability one configured model declares, where its category has one. */
export function modelAudioReference(
  model: ModelView | undefined,
  protocols: ProtocolGroups | null,
): AudioReferenceAbility {
  if (model === undefined || model.category !== "video") return NOTHING;
  const features = protocolFeatures(protocols, model.protocol);
  const seconds = features.audioReferenceSeconds;
  const speakers = features.audioReferenceSpeakers;
  return {
    supported: features.audioReference === true,
    seconds:
      typeof seconds === "number" && seconds > 0 ? Math.floor(seconds) : null,
    speakers:
      typeof speakers === "number" && speakers > 0
        ? Math.floor(speakers)
        : null,
  };
}

/**
 * The ability in one short line: the window and the count the converter names,
 * and nothing where it names none. A model that reads no recording says so by
 * returning null, so a list of other capabilities is left uncluttered.
 */
export function audioReferenceLabel(
  t: TFunction,
  ability: AudioReferenceAbility,
): string | null {
  if (!ability.supported) return null;
  if (ability.seconds !== null && ability.speakers !== null) {
    return t("settings:audioReference.scale", {
      seconds: ability.seconds,
      speakers: ability.speakers,
    });
  }
  if (ability.seconds !== null) {
    return t("settings:audioReference.seconds", { seconds: ability.seconds });
  }
  if (ability.speakers !== null) {
    return t("settings:audioReference.speakers", {
      speakers: ability.speakers,
    });
  }
  return t("settings:audioReference.any");
}
