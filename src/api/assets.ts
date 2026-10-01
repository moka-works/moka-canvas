import type { AssetCategory, AssetId, ResourceEntry } from "../shared/domain";
import { http, withProject } from "./client";
import type { SaveResult } from "./projects";

/** Asset mutations persist server-side, so they echo the new revision. */
export interface AssetChange {
  entry: ResourceEntry;
  revision: number;
  updatedAt: string;
}

export interface UploadOptions {
  categoryHint?: AssetCategory;
  signal?: AbortSignal;
  onUploadProgress?: (fraction: number) => void;
}

/**
 * Result of filing a node's work. `created` is false when the call answered
 * with the entry an earlier filing of the same node had already made.
 */
export interface FiledAsset extends AssetChange {
  created: boolean;
}

/**
 * What a reader says about an asset, offered on its own.
 *
 * A part left out is a part left as it was, so a note written down cannot
 * quietly clear the words the asset is filed under.
 */
export interface AssetShelfEdit {
  tags?: string[];
  note?: string;
  favorite?: boolean;
  keyword?: string;
}

export const assetsApi = {
  upload(file: File, options: UploadOptions = {}): Promise<AssetChange> {
    const formData = new FormData();
    if (options.categoryHint)
      formData.set("categoryHint", options.categoryHint);
    formData.set("file", file, file.name);
    return http.request<AssetChange>("/api/v1/projects/current/assets", {
      method: "POST",
      formData,
      signal: options.signal,
      onUploadProgress: options.onUploadProgress,
    });
  },

  replace(
    id: AssetId,
    file: File,
    options: UploadOptions = {},
  ): Promise<AssetChange> {
    const formData = new FormData();
    formData.set("file", file, file.name);
    return http.request<AssetChange>(
      `/api/v1/projects/current/assets/${id}/content`,
      { method: "PUT", formData, signal: options.signal },
    );
  },

  /**
   * Writes down what a reader says about an asset. Only the parts given are
   * touched, and the file underneath is left as it was — saying a picture is a
   * keeper costs nothing of the picture's.
   */
  patchShelf(id: AssetId, edit: AssetShelfEdit): Promise<AssetChange> {
    return http.request<AssetChange>(`/api/v1/projects/current/assets/${id}`, {
      method: "PATCH",
      body: edit,
    });
  },

  /**
   * Keeps a node's work to hand. A text node's words are written to the shelf
   * as they stand; anything that already holds a file just gets marked as kept,
   * and the file underneath is not read again.
   */
  fileNode(canvasId: string, nodeId: string): Promise<FiledAsset> {
    return http.request<FiledAsset>(
      "/api/v1/projects/current/assets/from-node",
      { method: "POST", body: { canvasId, nodeId } },
    );
  },

  remove(id: AssetId): Promise<SaveResult> {
    return http.request<SaveResult>(`/api/v1/projects/current/assets/${id}`, {
      method: "DELETE",
    });
  },

  /** Opens the asset file in the OS file manager. */
  reveal(id: AssetId): Promise<void> {
    return http.request<void>(`/api/v1/projects/current/assets/${id}/reveal`, {
      method: "POST",
    });
  },
};

/**
 * Same-origin streaming URL for an asset of the window's own project.
 *
 * A picture or a recording is fetched by the browser itself, which sends no
 * project header with it — so the URL names the project where the request
 * layer would otherwise have named it.
 */
export function assetUrl(id: AssetId): string {
  return withProject(`/api/v1/projects/current/assets/${id}`);
}

/**
 * The same file, drawn by the server at the width a list shows it.
 *
 * For the surfaces that draw a file small — a shelf row, a card, a reference
 * thumbnail — rather than the ones that show it as itself. The server clamps
 * the width and answers with the file itself when it cannot draw one, so a
 * caller has nothing to check.
 */
export function assetThumbUrl(id: AssetId, width: number): string {
  return withProject(`/api/v1/projects/current/assets/${id}?w=${width}`);
}

/**
 * The sound of an asset on its own, for the player that only wants to hear it.
 *
 * A film's sound read from the film itself is a whole picture file streamed
 * for its sound; the server answers this with the sound alone in a small file
 * of its own where it can make one, and with the file itself where it cannot
 * — so a caller has nothing to check, and a voice reads the smallest thing
 * that plays.
 */
export function assetAudioUrl(id: AssetId): string {
  return withProject(`/api/v1/projects/current/assets/${id}/audio`);
}
