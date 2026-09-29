import type {
  DocumentCommand,
  MokaFile,
  SelfCheckReport,
} from "../shared/domain";
import { http } from "./client";

export interface OpenProjectResult {
  root: string;
  moka: MokaFile;
  selfCheck: SelfCheckReport;
  /**
   * Whether the server has finished reading the files whose sizes could not
   * speak for them. False means the report may still grow — what a same-length
   * change looks like — and `selfCheck()` is how the rest arrives.
   */
  selfCheckVerified: boolean;
}

/** The open project's file check on its own, and whether it is finished. */
export interface SelfCheckStatus {
  report: SelfCheckReport;
  verified: boolean;
}

export interface SaveResult {
  revision: number;
  updatedAt: string;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
}

export interface PackageReport {
  destination: string;
  entries: number;
  bytes: number;
  incomplete: boolean;
}

export interface ExportOptions {
  /** Where the package goes: the path a save dialog answered. */
  destination: string;
  allowIncomplete?: boolean;
  /** Carry this machine's own record of past runs along with the work. */
  includePersonalHistory?: boolean;
  /** Leave out assets no node points at. */
  onlyReferencedAssets?: boolean;
}

export const projectsApi = {
  /**
   * Makes a project in `directory`. `useSubdirectory` carries a reader's
   * agreement that a folder already holding something gets a subfolder named
   * after the project; without it, such a folder is refused rather than
   * written into, and an empty one holds the project itself.
   */
  create(
    directory: string,
    name: string,
    firstCanvasName?: string,
    useSubdirectory = false,
  ): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects", {
      method: "POST",
      body: { directory, name, firstCanvasName, useSubdirectory },
    });
  },

  open(path: string): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects/open", {
      method: "POST",
      body: { path },
    });
  },

  current(signal?: AbortSignal): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects/current", {
      signal,
    });
  },

  selfCheck(signal?: AbortSignal): Promise<SelfCheckStatus> {
    return http.request<SelfCheckStatus>(
      "/api/v1/projects/current/self-check",
      {
        signal,
      },
    );
  },

  applyCommands(
    expectedRevision: number,
    commands: DocumentCommand[],
    signal?: AbortSignal,
  ): Promise<SaveResult> {
    return http.request<SaveResult>("/api/v1/projects/current/commands", {
      method: "POST",
      body: { expectedRevision, commands },
      signal,
    });
  },

  exportPackage(options: ExportOptions): Promise<PackageReport> {
    return http.request<PackageReport>("/api/v1/projects/current/export", {
      method: "POST",
      body: options,
    });
  },

  importFromPath(
    archivePath: string,
    directory: string,
    name?: string,
  ): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects/import", {
      method: "POST",
      body: { archivePath, directory, name },
    });
  },

  importUpload(
    file: File,
    directory: string,
    name?: string,
    onUploadProgress?: (fraction: number) => void,
  ): Promise<OpenProjectResult> {
    const formData = new FormData();
    formData.set("directory", directory);
    if (name) formData.set("name", name);
    formData.set("file", file, file.name);
    return http.request<OpenProjectResult>("/api/v1/projects/import", {
      method: "POST",
      formData,
      onUploadProgress,
    });
  },
};

export const recentApi = {
  list(signal?: AbortSignal): Promise<RecentProject[]> {
    return http.request<RecentProject[]>("/api/v1/recent-projects", { signal });
  },

  remove(id: string): Promise<void> {
    return http.request<void>(`/api/v1/recent-projects/${id}`, {
      method: "DELETE",
    });
  },
};
