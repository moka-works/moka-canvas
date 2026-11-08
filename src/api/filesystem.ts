import { http, toApiError } from "./client";

/** One row of a listing: a name, where it leads, and which of the two it is. */
export interface FilesystemEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

/** What one directory holds, as the server answered it. */
export interface FilesystemListing {
  /** The directory listed, resolved — not necessarily the one asked for. */
  path: string;
  /** Where up leads, and null at the top of a filesystem. */
  parent: string | null;
  entries: FilesystemEntry[];
  /** Whether the listing stopped before the directory was exhausted. */
  truncated: boolean;
}

/** Where a save landed, as the server answered it. */
export interface FilesystemWriteReport {
  path: string;
  bytes: number;
}

/**
 * What a directory holds, for a runtime with no file dialog of its own.
 *
 * A desktop asks the operating system which folder is meant; a browser cannot
 * ask anything, and this is what stands in for the question there. It is served
 * only in the web runtime, so a caller has to be ready for the route to say it
 * is not there — which is the same answer the desktop's own dialog gives when
 * it is not offered at all.
 *
 * A listing carries the folders in a directory and the files whose extension
 * was asked for, and nothing about what any of them holds. Asking for no
 * extensions at all asks for the folders alone, which is the question a place
 * to put a new project is.
 */
export const filesystemApi = {
  list(path?: string, extensions?: string[]): Promise<FilesystemListing> {
    const asked = new URLSearchParams();
    const where = path?.trim();
    if (where) asked.set("path", where);
    if (extensions && extensions.length > 0) {
      asked.set("extensions", extensions.join(","));
    }
    const query = asked.toString();
    return http.request<FilesystemListing>(
      `/api/v1/filesystem${query === "" ? "" : `?${query}`}`,
    );
  },

  /**
   * Writes bytes where a save dialog said, whole or not at all.
   *
   * The listing above is the web runtime's question, because it has no dialog
   * of its own; a write is the other half of that question in both runtimes,
   * since the window holding the bytes is not the one holding the disk. A file
   * already at the path is replaced — the dialog that produced the path is what
   * asked about that.
   */
  async write(path: string, bytes: Blob): Promise<FilesystemWriteReport> {
    const asked = new URLSearchParams({ path });
    const response = await fetch(`/api/v1/filesystem/file?${asked}`, {
      method: "PUT",
      body: bytes,
    });
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as FilesystemWriteReport;
  },

  /** Shows a file this machine wrote in the platform's own file manager. */
  reveal(path: string): Promise<void> {
    return http.request<void>("/api/v1/filesystem/reveal", {
      method: "POST",
      body: { path },
    });
  },

  /**
   * Opens this machine's Moka data folder — where the logs, metadata, models
   * and node extensions live — in the platform's own file manager.
   */
  openDataDirectory(): Promise<void> {
    return http.request<void>("/api/v1/filesystem/data-directory", {
      method: "POST",
    });
  },
};
