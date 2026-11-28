/**
 * Taking a cast out of one project and into another.
 *
 * The files travel beside the words: every picture of a card, every form's
 * pictures, and every voice recording a character is read from are read out of
 * this project, packed with the words, and filed into the receiving project
 * before the cards that name them are written. A file that cannot be read stops
 * the export rather than leaving a package that claims pictures it does not
 * carry.
 */

import { assetUrl, assetsApi } from "../../../api/assets";
import { errorText } from "../../../api/client";
import { filesystemApi } from "../../../api/filesystem";
import type { StoryDocument, StoryElement } from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import {
  saveTrouble,
  settleBeforeFiling,
  useProjectStore,
} from "../../editor/stores/projectStore";
import {
  ElementPackageError,
  buildElementPackage,
  materializeImportedElements,
  planElementImport,
  readElementPackage,
  zipElementPackage,
} from "./elementPackage";

export interface ElementExportReport {
  elements: number;
  assets: number;
  bytes: number;
}

export interface ElementImportReport {
  imported: number;
  /** Elements kept as they were because the telling already had the name. */
  skipped: string[];
  /** Pictures or recordings the package named but did not carry. */
  missingAssets: string[];
}

/** Writes every element of a telling and the files they name to a zip. */
export async function exportElementPackage(
  story: StoryDocument,
  destination: string,
): Promise<ElementExportReport> {
  const moka = useProjectStore.getState().moka;
  if (moka === null) {
    throw new Error("No project is open");
  }
  const { manifest, missing } = buildElementPackage(story.elements, moka);
  if (missing.length > 0) {
    throw new ElementPackageError("ASSETS_MISSING", missing.join("、"), {
      count: missing.length,
    });
  }
  const files = new Map<string, Uint8Array>();
  const unread: string[] = [];
  for (const asset of manifest.assets) {
    const response = await fetch(assetUrl(asset.id));
    if (!response.ok) {
      unread.push(asset.name);
      continue;
    }
    files.set(asset.id, new Uint8Array(await response.arrayBuffer()));
  }
  if (unread.length > 0) {
    throw new ElementPackageError("ASSETS_MISSING", unread.join("、"), {
      count: unread.length,
    });
  }
  const bytes = zipElementPackage(manifest, files);
  await filesystemApi.write(
    destination,
    new Blob([bytes], { type: "application/zip" }),
  );
  return {
    elements: manifest.elements.length,
    assets: manifest.assets.length,
    bytes: bytes.byteLength,
  };
}

/** Files a package's pictures and recordings, then writes its elements. */
export async function importElementPackage(
  story: StoryDocument,
  file: File,
): Promise<ElementImportReport> {
  const { manifest, files } = readElementPackage(
    new Uint8Array(await file.arrayBuffer()),
  );
  const opening = planElementImport(story, manifest);
  if (opening.planned.length === 0) {
    return {
      imported: 0,
      skipped: opening.skipped.map((element) => element.name),
      missingAssets: [],
    };
  }

  // Filing a file writes the stored document from the server's side, so what
  // the reader changed is settled first: an upload that raced it would make a
  // conflict out of the import's own steps.
  const settled = await settleBeforeFiling();
  const state = useProjectStore.getState();
  if (
    !settled ||
    state.pending.length > 0 ||
    state.saveStatus === "conflicted" ||
    state.saveStatus === "error"
  ) {
    const trouble = saveTrouble();
    throw new ElementPackageError(
      "SAVE_BLOCKED",
      [trouble.message, trouble.detail].filter(Boolean).join(" — "),
    );
  }
  // The settled document is the one the cards land in: a change that arrived
  // while the package was read may have taken a name or a place already.
  const live =
    state.moka?.stories?.find((held) => held.id === story.id) ?? story;
  const plan = planElementImport(live, manifest);
  const skipped = plan.skipped.map((element) => element.name);
  if (plan.planned.length === 0) {
    return { imported: 0, skipped, missingAssets: [] };
  }

  const assets = new Map<string, string>();
  const missingAssets = [...plan.missing];
  for (const asset of plan.assets) {
    const bytes = files[asset.file];
    if (bytes === undefined) {
      missingAssets.push(asset.name);
      continue;
    }
    const name =
      asset.name.trim() === "" ? `element-asset-${asset.id}` : asset.name;
    const picture = new File([bytes], name, {
      type: asset.mime ?? "application/octet-stream",
    });
    let uploaded;
    try {
      uploaded = await assetsApi.upload(picture, {
        ...(asset.category === "voice"
          ? { categoryHint: "voice" as const }
          : {}),
      });
    } catch (problem) {
      const trouble = errorText(problem);
      throw new ElementPackageError(
        "UPLOAD",
        `${name}: ${trouble.detail ?? trouble.message}`,
      );
    }
    useProjectStore.getState().integrateAssetEntry(uploaded.entry, {
      revision: uploaded.revision,
      updatedAt: uploaded.updatedAt,
    });
    assets.set(asset.id, uploaded.entry.id);
  }

  const imported: StoryElement[] = materializeImportedElements(plan, assets);
  const done = execute(i18n.t("story:history.importElements"), [
    {
      type: "setStoryElements",
      storyId: live.id,
      elements: [...live.elements, ...imported],
    },
  ]);
  if (done === null) {
    throw new ElementPackageError("WRITE");
  }
  return { imported: imported.length, skipped, missingAssets };
}
