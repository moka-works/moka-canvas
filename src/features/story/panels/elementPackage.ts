/**
 * A cast in a file of its own, for taking it to another project.
 *
 * The package is a zip: a manifest of the elements as they were written, and
 * every picture and recording those elements point at. The chapters a card
 * stands in are the one thing left behind — they are ids of the telling it came
 * from, and a card arriving in another telling stands in every chapter until
 * its reader says otherwise.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  MAX_ELEMENTS_PER_STORY,
  PROJECT_ASSET_CATEGORIES,
  type AssetCategory,
} from "../../../shared/domain/constants";
import { newId, nowIso } from "../../../shared/domain/ids";
import { elementCount, elementKey } from "../../../shared/domain/story";
import {
  STORY_ASPECTS,
  type MokaFile,
  type ResourceEntry,
  type StoryAspect,
  type StoryDocument,
  type StoryElement,
  type StoryElementKind,
  type StoryElementVariant,
  type StoryPictureReference,
  type StorySlot,
  type StoryTake,
  type StoryVoiceProfile,
} from "../../../shared/domain/types";

export const ELEMENT_PACKAGE_FORMAT = "moka.story.elements";
export const ELEMENT_PACKAGE_VERSION = 1;
export const ELEMENT_PACKAGE_MANIFEST = "moka-elements.json";
/** What a package may hold, counted before anything in it is read. */
export const ELEMENT_PACKAGE_MAX_ENTRIES = 2000;
export const ELEMENT_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;

export type ElementPackageErrorCode =
  | "INVALID"
  | "VERSION"
  | "EMPTY"
  | "LIMIT"
  | "ASSETS_MISSING"
  | "SAVE_BLOCKED"
  | "UPLOAD"
  | "WRITE";

/** A package that could not be made or read, and why. */
export class ElementPackageError extends Error {
  constructor(
    readonly code: ElementPackageErrorCode,
    readonly detail?: string,
    readonly meta?: Record<string, string | number>,
  ) {
    super(detail ?? code);
    this.name = "ElementPackageError";
  }
}

/** One take in a package, with its files still named by their old ids. */
export interface ElementPackageTake {
  assetIds: string[];
  note?: string;
  inMs?: number;
  outMs?: number;
  createdAt?: string;
}

export interface ElementPackageSlot {
  takes: ElementPackageTake[];
}

/** One form of an element, as the package carries it. */
export interface ElementPackageVariant {
  id: string;
  name: string;
  description: string;
  main: ElementPackageSlot;
  turnaround?: ElementPackageSlot;
  imageModel?: string;
  ratio?: StoryAspect;
  reference?: StoryPictureReference;
}

/** One element as the package carries it: everything but its chapters. */
export interface ElementPackageElement {
  /** The element's id in the telling it came from, for remapping references. */
  id: string;
  kind: StoryElementKind;
  name: string;
  description: string;
  main: ElementPackageSlot;
  turnaround?: ElementPackageSlot;
  variants?: ElementPackageVariant[];
  voice?: StoryVoiceProfile;
  imageModel?: string;
  ratio?: StoryAspect;
  reference?: StoryPictureReference;
}

/** One file in the package, and the asset it belongs to back home. */
export interface ElementPackageAsset {
  /** The asset's id in the telling it came from. */
  id: string;
  name: string;
  mime?: string;
  category: AssetCategory;
  /** Where the file sits inside the zip. */
  file: string;
}

export interface ElementPackageManifest {
  format: typeof ELEMENT_PACKAGE_FORMAT;
  version: number;
  exportedAt: string;
  elements: ElementPackageElement[];
  assets: ElementPackageAsset[];
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ElementPackageError("INVALID", `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTake(value: unknown): ElementPackageTake | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.assetIds)) return undefined;
  const assetIds = doc.assetIds
    .map(textOf)
    .filter((id): id is string => id !== undefined && id !== "");
  if (assetIds.length === 0) return undefined;
  const take: ElementPackageTake = { assetIds };
  const note = textOf(doc.note);
  if (note !== undefined) take.note = note;
  if (typeof doc.inMs === "number") take.inMs = doc.inMs;
  if (typeof doc.outMs === "number") take.outMs = doc.outMs;
  const createdAt = textOf(doc.createdAt);
  if (createdAt !== undefined) take.createdAt = createdAt;
  return take;
}

function readSlot(value: unknown): ElementPackageSlot {
  if (value === undefined || value === null) return { takes: [] };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ElementPackageError("INVALID", "a slot is not an object");
  }
  const takes = (value as Record<string, unknown>).takes;
  if (takes === undefined) return { takes: [] };
  if (!Array.isArray(takes)) {
    throw new ElementPackageError("INVALID", "a slot's takes are not a list");
  }
  return {
    takes: takes.flatMap((take) => {
      const read = readTake(take);
      return read === undefined ? [] : [read];
    }),
  };
}

function readReference(value: unknown): StoryPictureReference | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  if (doc.kind === "asset") {
    const assetId = textOf(doc.assetId);
    return assetId === undefined ? undefined : { kind: "asset", assetId };
  }
  if (doc.kind === "element") {
    const elementId = textOf(doc.elementId);
    if (elementId === undefined) return undefined;
    const variantId = textOf(doc.variantId);
    return {
      kind: "element",
      elementId,
      ...(variantId === undefined ? {} : { variantId }),
    };
  }
  return undefined;
}

function readVoice(value: unknown): StoryVoiceProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  const voice: StoryVoiceProfile = {
    model: textOf(doc.model) ?? "",
    voice: textOf(doc.voice) ?? "",
  };
  if (typeof doc.rate === "number") voice.rate = doc.rate;
  if (typeof doc.pitch === "number") voice.pitch = doc.pitch;
  const instructions = textOf(doc.instructions);
  if (instructions !== undefined) voice.instructions = instructions;
  const referenceAssetId = textOf(doc.referenceAssetId);
  if (referenceAssetId !== undefined) voice.referenceAssetId = referenceAssetId;
  return voice;
}

function readAspect(value: unknown): StoryAspect | undefined {
  const aspect = textOf(value);
  return aspect !== undefined && STORY_ASPECTS.includes(aspect as StoryAspect)
    ? (aspect as StoryAspect)
    : undefined;
}

function readVariant(
  value: unknown,
  elementAt: number,
  at: number,
): ElementPackageVariant {
  const doc = asRecord(value, `elements[${elementAt}].variants[${at}]`);
  const imageModel = textOf(doc.imageModel);
  const ratio = readAspect(doc.ratio);
  const reference = readReference(doc.reference);
  return {
    id: textOf(doc.id) ?? `variant-${elementAt + 1}-${at + 1}`,
    name: textOf(doc.name) ?? "",
    description: textOf(doc.description) ?? "",
    main: readSlot(doc.main),
    ...(doc.turnaround === undefined
      ? {}
      : { turnaround: readSlot(doc.turnaround) }),
    ...(imageModel === undefined ? {} : { imageModel }),
    ...(ratio === undefined ? {} : { ratio }),
    ...(reference === undefined ? {} : { reference }),
  };
}

function readElement(value: unknown, at: number): ElementPackageElement {
  const doc = asRecord(value, `elements[${at}]`);
  const kind = doc.kind;
  if (kind !== "character" && kind !== "scene" && kind !== "prop") {
    throw new ElementPackageError("INVALID", `elements[${at}] has no kind`);
  }
  const name = (textOf(doc.name) ?? "").trim();
  if (name === "") {
    throw new ElementPackageError("INVALID", `elements[${at}] has no name`);
  }
  const voice = readVoice(doc.voice);
  const imageModel = textOf(doc.imageModel);
  const ratio = readAspect(doc.ratio);
  const reference = readReference(doc.reference);
  return {
    id: textOf(doc.id) ?? `element-${at + 1}`,
    kind,
    name,
    description: textOf(doc.description) ?? "",
    main: readSlot(doc.main),
    ...(doc.turnaround === undefined
      ? {}
      : { turnaround: readSlot(doc.turnaround) }),
    ...(Array.isArray(doc.variants)
      ? {
          variants: doc.variants.map((variant, index) =>
            readVariant(variant, at, index),
          ),
        }
      : {}),
    ...(voice === undefined ? {} : { voice }),
    ...(imageModel === undefined ? {} : { imageModel }),
    ...(ratio === undefined ? {} : { ratio }),
    ...(reference === undefined ? {} : { reference }),
  };
}

function readAsset(value: unknown, at: number): ElementPackageAsset {
  const doc = asRecord(value, `assets[${at}]`);
  const id = textOf(doc.id) ?? "";
  const file = textOf(doc.file) ?? "";
  if (id === "" || file === "") {
    throw new ElementPackageError("INVALID", `assets[${at}] is incomplete`);
  }
  const category = textOf(doc.category);
  return {
    id,
    file,
    name: textOf(doc.name) ?? file.split("/").pop() ?? id,
    ...(textOf(doc.mime) === undefined ? {} : { mime: textOf(doc.mime) }),
    category: (PROJECT_ASSET_CATEGORIES as readonly string[]).includes(
      category ?? "",
    )
      ? (category as AssetCategory)
      : "images",
  };
}

function readManifest(value: unknown): ElementPackageManifest {
  const doc = asRecord(value, "the manifest");
  if (doc.format !== ELEMENT_PACKAGE_FORMAT) {
    throw new ElementPackageError("INVALID", "the manifest is not a cast");
  }
  if (typeof doc.version !== "number") {
    throw new ElementPackageError("INVALID", "the manifest has no version");
  }
  if (doc.version > ELEMENT_PACKAGE_VERSION) {
    throw new ElementPackageError(
      "VERSION",
      `the package is version ${doc.version}`,
      { version: doc.version },
    );
  }
  if (!Array.isArray(doc.elements) || !Array.isArray(doc.assets)) {
    throw new ElementPackageError("INVALID", "the manifest is incomplete");
  }
  const elements = doc.elements.map(readElement);
  if (elements.length === 0) {
    throw new ElementPackageError("EMPTY");
  }
  return {
    format: ELEMENT_PACKAGE_FORMAT,
    version: doc.version,
    exportedAt: textOf(doc.exportedAt) ?? nowIso(),
    elements,
    assets: doc.assets.map(readAsset),
  };
}

function packageTake(take: StoryTake): ElementPackageTake {
  return {
    assetIds: [...take.assetIds],
    ...(take.note === undefined ? {} : { note: take.note }),
    ...(take.inMs === undefined ? {} : { inMs: take.inMs }),
    ...(take.outMs === undefined ? {} : { outMs: take.outMs }),
    ...(take.createdAt === undefined ? {} : { createdAt: take.createdAt }),
  };
}

function packageSlot(
  slot: StorySlot | undefined,
): ElementPackageSlot | undefined {
  if (slot === undefined) return undefined;
  return { takes: slot.takes.map(packageTake) };
}

function packageVariant(variant: StoryElementVariant): ElementPackageVariant {
  return {
    id: variant.id,
    name: variant.name,
    description: variant.description,
    main: packageSlot(variant.main) ?? { takes: [] },
    ...(variant.turnaround === undefined
      ? {}
      : { turnaround: packageSlot(variant.turnaround) }),
    ...(variant.imageModel === undefined
      ? {}
      : { imageModel: variant.imageModel }),
    ...(variant.ratio === undefined ? {} : { ratio: variant.ratio }),
    ...(variant.reference === undefined
      ? {}
      : { reference: variant.reference }),
  };
}

function packageElement(element: StoryElement): ElementPackageElement {
  return {
    id: element.id,
    kind: element.kind,
    name: element.name,
    description: element.description,
    main: packageSlot(element.main) ?? { takes: [] },
    ...(element.turnaround === undefined
      ? {}
      : { turnaround: packageSlot(element.turnaround) }),
    ...(element.variants === undefined
      ? {}
      : { variants: element.variants.map(packageVariant) }),
    ...(element.voice === undefined ? {} : { voice: element.voice }),
    ...(element.imageModel === undefined
      ? {}
      : { imageModel: element.imageModel }),
    ...(element.ratio === undefined ? {} : { ratio: element.ratio }),
    ...(element.reference === undefined
      ? {}
      : { reference: element.reference }),
  };
}

function slotAssetIds(
  slot: ElementPackageSlot | undefined,
  into: Set<string>,
): void {
  for (const take of slot?.takes ?? []) {
    for (const id of take.assetIds) into.add(id);
  }
}

/** Every asset id the given elements point at. */
export function referencedAssetIds(
  elements: readonly ElementPackageElement[],
): Set<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    slotAssetIds(element.main, ids);
    slotAssetIds(element.turnaround, ids);
    for (const form of element.variants ?? []) {
      slotAssetIds(form.main, ids);
      slotAssetIds(form.turnaround, ids);
      if (form.reference?.kind === "asset") ids.add(form.reference.assetId);
    }
    if (element.voice?.referenceAssetId !== undefined) {
      ids.add(element.voice.referenceAssetId);
    }
    if (element.reference?.kind === "asset") {
      ids.add(element.reference.assetId);
    }
  }
  return ids;
}

function resourceById(
  moka: MokaFile,
  id: string,
): { entry: ResourceEntry; category: AssetCategory } | undefined {
  for (const category of PROJECT_ASSET_CATEGORIES) {
    const entry = (moka.resources[category] ?? []).find(
      (held) => held.id === id,
    );
    if (entry !== undefined) return { entry, category };
  }
  return undefined;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".weba",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function extensionOf(entry: ResourceEntry): string {
  const named = /\.[A-Za-z0-9]{1,8}$/.exec(entry.name);
  if (named !== null) return named[0].toLowerCase();
  return MIME_EXTENSIONS[entry.mime ?? ""] ?? ".bin";
}

function filePathOf(entry: ResourceEntry, at: number): string {
  const stem = entry.name
    .replace(/\.[^./\\]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const label = stem === "" ? "asset" : stem;
  return `assets/${String(at + 1).padStart(3, "0")}-${label}${extensionOf(entry)}`;
}

/**
 * The cast as one package, before any file is read.
 *
 * Answers with the manifest and the ids whose files are not in this project:
 * an element's words are still worth writing down, but a package that claims a
 * picture it cannot carry is not a package the reader asked for.
 */
export function buildElementPackage(
  elements: readonly StoryElement[],
  moka: MokaFile,
): { manifest: ElementPackageManifest; missing: string[] } {
  const packaged = elements.map(packageElement);
  const assets: ElementPackageAsset[] = [];
  const missing: string[] = [];
  const referenced = referencedAssetIds(packaged);
  let at = 0;
  for (const id of referenced) {
    const found = resourceById(moka, id);
    if (found === undefined) {
      missing.push(id);
      continue;
    }
    assets.push({
      id,
      name: found.entry.name.trim() === "" ? `asset-${id}` : found.entry.name,
      ...(found.entry.mime === undefined ? {} : { mime: found.entry.mime }),
      category: found.category,
      file: filePathOf(found.entry, at),
    });
    at += 1;
  }
  return {
    manifest: {
      format: ELEMENT_PACKAGE_FORMAT,
      version: ELEMENT_PACKAGE_VERSION,
      exportedAt: nowIso(),
      elements: packaged,
      assets,
    },
    missing,
  };
}

/** The package as a zip, every picture and recording beside its manifest. */
export function zipElementPackage(
  manifest: ElementPackageManifest,
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [ELEMENT_PACKAGE_MANIFEST]: strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const asset of manifest.assets) {
    const bytes = files.get(asset.id);
    if (bytes === undefined) {
      throw new ElementPackageError("ASSETS_MISSING", asset.name, {
        count: 1,
      });
    }
    entries[asset.file] = bytes;
  }
  return zipSync(entries, { level: 6 });
}

/** A package read off disk: its manifest, and every file it carries by name. */
export function readElementPackage(bytes: Uint8Array): {
  manifest: ElementPackageManifest;
  files: Record<string, Uint8Array>;
} {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ElementPackageError("INVALID", "the file is not a zip");
  }
  const names = Object.keys(files);
  if (names.length > ELEMENT_PACKAGE_MAX_ENTRIES) {
    throw new ElementPackageError("INVALID", "the package has too many files");
  }
  let total = 0;
  for (const name of names) total += files[name]?.byteLength ?? 0;
  if (total > ELEMENT_PACKAGE_MAX_BYTES) {
    throw new ElementPackageError("INVALID", "the package is too large");
  }
  const manifestBytes = files[ELEMENT_PACKAGE_MANIFEST];
  if (manifestBytes === undefined) {
    throw new ElementPackageError("INVALID", "the package has no manifest");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ElementPackageError("INVALID", "the manifest is not JSON");
  }
  return { manifest: readManifest(raw), files };
}

/** What one package element becomes in the telling it is arriving in. */
interface PlannedElement {
  source: ElementPackageElement;
  /** The element's own id in this telling. */
  id: string;
  /** The source's forms, by the ids they wore coming in. */
  variants: Map<string, string>;
}

export interface ElementImportPlan {
  /** Elements kept as they are because the telling already has the name. */
  skipped: ElementPackageElement[];
  planned: PlannedElement[];
  /** Source element id → this telling's element id. */
  elements: Map<string, string>;
  /** Source element id → source form id → this telling's form id. */
  forms: Map<string, Map<string, string>>;
  /** The files this import will ask for, in package order. */
  assets: ElementPackageAsset[];
  /** Asset ids the package's elements name but its manifest does not carry. */
  missing: string[];
}

/**
 * How a package lands in a telling: what it adds, what it leaves alone.
 *
 * A name the telling already holds is the reader's own element and stays as it
 * is; the package's copy is skipped rather than made a second card of the same
 * name. References and forms are remapped before anything is written, so an
 * imported element still points at the cast it was packaged with.
 */
export function planElementImport(
  story: StoryDocument,
  manifest: ElementPackageManifest,
): ElementImportPlan {
  const claimed = new Map<
    string,
    { id: string; variants: Array<{ id: string; name: string }> }
  >();
  for (const element of story.elements) {
    claimed.set(elementKey(element.kind, element.name), {
      id: element.id,
      variants: (element.variants ?? []).map((form) => ({
        id: form.id,
        name: form.name,
      })),
    });
  }
  const skipped: ElementPackageElement[] = [];
  const planned: PlannedElement[] = [];
  const elements = new Map<string, string>();
  const forms = new Map<string, Map<string, string>>();
  for (const source of manifest.elements) {
    const key = elementKey(source.kind, source.name);
    const held = claimed.get(key);
    if (held !== undefined) {
      skipped.push(source);
      elements.set(source.id, held.id);
      const byName = new Map(
        held.variants.map((form) => [form.name.trim().toLowerCase(), form.id]),
      );
      const mapped = new Map<string, string>();
      for (const form of source.variants ?? []) {
        const match = byName.get(form.name.trim().toLowerCase());
        if (match !== undefined) mapped.set(form.id, match);
      }
      forms.set(source.id, mapped);
      continue;
    }
    const id = newId();
    const mapped = new Map<string, string>();
    for (const form of source.variants ?? []) mapped.set(form.id, newId());
    planned.push({ source, id, variants: mapped });
    elements.set(source.id, id);
    forms.set(source.id, mapped);
    claimed.set(key, {
      id,
      variants: (source.variants ?? []).map((form) => ({
        id: mapped.get(form.id) ?? form.id,
        name: form.name,
      })),
    });
  }
  const adding = planned.reduce(
    (sum, { source }) => sum + 1 + (source.variants?.length ?? 0),
    0,
  );
  const capacity = Math.max(
    0,
    MAX_ELEMENTS_PER_STORY - elementCount(story.elements),
  );
  if (adding > capacity) {
    throw new ElementPackageError(
      "LIMIT",
      `the cast needs ${adding} places and ${capacity} are left`,
      { adding, capacity },
    );
  }
  const referenced = referencedAssetIds(planned.map(({ source }) => source));
  const known = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  return {
    skipped,
    planned,
    elements,
    forms,
    assets: [...referenced].flatMap((id) => {
      const asset = known.get(id);
      return asset === undefined ? [] : [asset];
    }),
    missing: [...referenced].filter((id) => !known.has(id)),
  };
}

function importedSlot(
  slot: ElementPackageSlot | undefined,
  assets: ReadonlyMap<string, string>,
): StorySlot {
  const takes: StoryTake[] = [];
  for (const take of slot?.takes ?? []) {
    const assetIds = take.assetIds.flatMap((id) => {
      const mapped = assets.get(id);
      return mapped === undefined ? [] : [mapped];
    });
    if (assetIds.length === 0) continue;
    takes.push({
      assetIds,
      ...(take.note === undefined ? {} : { note: take.note }),
      ...(take.inMs === undefined ? {} : { inMs: take.inMs }),
      ...(take.outMs === undefined ? {} : { outMs: take.outMs }),
      createdAt: take.createdAt ?? nowIso(),
    });
  }
  return { takes };
}

function importedReference(
  reference: StoryPictureReference | undefined,
  elements: ReadonlyMap<string, string>,
  forms: ReadonlyMap<string, ReadonlyMap<string, string>>,
  assets: ReadonlyMap<string, string>,
): StoryPictureReference | undefined {
  if (reference === undefined) return undefined;
  if (reference.kind === "asset") {
    const assetId = assets.get(reference.assetId);
    return assetId === undefined ? undefined : { kind: "asset", assetId };
  }
  const elementId = elements.get(reference.elementId);
  if (elementId === undefined) return undefined;
  const variantId =
    reference.variantId === undefined
      ? undefined
      : forms.get(reference.elementId)?.get(reference.variantId);
  return {
    kind: "element",
    elementId,
    ...(variantId === undefined ? {} : { variantId }),
  };
}

function importedVoice(
  voice: StoryVoiceProfile | undefined,
  assets: ReadonlyMap<string, string>,
): StoryVoiceProfile | undefined {
  if (voice === undefined) return undefined;
  const profile: StoryVoiceProfile = {
    model: voice.model,
    voice: voice.voice,
  };
  if (voice.rate !== undefined) profile.rate = voice.rate;
  if (voice.pitch !== undefined) profile.pitch = voice.pitch;
  if (voice.instructions !== undefined)
    profile.instructions = voice.instructions;
  const reference = voice.referenceAssetId;
  const mapped = reference === undefined ? undefined : assets.get(reference);
  if (mapped !== undefined) profile.referenceAssetId = mapped;
  return profile;
}

function importedVariant(
  form: ElementPackageVariant,
  id: string,
  character: boolean,
  plan: ElementImportPlan,
  assets: ReadonlyMap<string, string>,
): StoryElementVariant {
  const reference = importedReference(
    form.reference,
    plan.elements,
    plan.forms,
    assets,
  );
  const turnaround =
    form.turnaround === undefined && !character
      ? {}
      : { turnaround: importedSlot(form.turnaround, assets) };
  return {
    id,
    name: form.name,
    description: form.description,
    main: importedSlot(form.main, assets),
    ...turnaround,
    ...(form.imageModel === undefined ? {} : { imageModel: form.imageModel }),
    ...(form.ratio === undefined ? {} : { ratio: form.ratio }),
    ...(reference === undefined ? {} : { reference }),
  };
}

/**
 * The elements an import writes, with every file and reference on this side.
 *
 * The chapters are always empty: the ids a package's cards wore named chapters
 * of another telling, and an element arriving here stands in every chapter
 * until its reader picks the ones it actually appears in.
 */
export function materializeImportedElements(
  plan: ElementImportPlan,
  assets: ReadonlyMap<string, string>,
): StoryElement[] {
  return plan.planned.map(({ source, id, variants }) => {
    const reference = importedReference(
      source.reference,
      plan.elements,
      plan.forms,
      assets,
    );
    const character = source.kind === "character";
    const voice = character ? importedVoice(source.voice, assets) : undefined;
    const turnaround =
      source.turnaround === undefined && !character
        ? {}
        : { turnaround: importedSlot(source.turnaround, assets) };
    return {
      id,
      kind: source.kind,
      name: source.name,
      description: source.description,
      chapterIds: [],
      main: importedSlot(source.main, assets),
      ...turnaround,
      ...(source.variants === undefined
        ? {}
        : {
            variants: source.variants.map((form) =>
              importedVariant(
                form,
                variants.get(form.id) ?? newId(),
                character,
                plan,
                assets,
              ),
            ),
          }),
      ...(voice === undefined ? {} : { voice }),
      ...(source.imageModel === undefined
        ? {}
        : { imageModel: source.imageModel }),
      ...(source.ratio === undefined ? {} : { ratio: source.ratio }),
      ...(reference === undefined ? {} : { reference }),
    };
  });
}
