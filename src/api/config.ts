import { http } from "./client";

export interface PublicCapabilities {
  mode: "web" | "tauri";
  executors: string[];
  assetCategories: string[];
}

export interface PublicLimits {
  maxNodesPerCanvas: number;
  maxEdgesPerCanvas: number;
  maxCanvasesPerProject: number;
  maxPackageBytes: number;
  maxPackageEntries: number;
}

export interface PublicConfig {
  productName: string;
  maxUploadBytes: number;
  allowedMediaTypes: string[];
  limits: PublicLimits;
  /** The most the story room may ask one model to serve at once. */
  storyMaxParallelItems?: number;
  capabilities: PublicCapabilities;
}

export function fetchPublicConfig(signal?: AbortSignal): Promise<PublicConfig> {
  return http.request<PublicConfig>("/api/v1/config", { signal });
}

export function fetchHealth(signal?: AbortSignal): Promise<{ status: string }> {
  return http.request<{ status: string }>("/api/health", { signal });
}
