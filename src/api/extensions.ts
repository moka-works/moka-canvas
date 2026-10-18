import type { ExtensionCatalog } from "../shared/domain";
import { http } from "./client";

/**
 * The extension definitions installed on the machine running the server.
 *
 * Read fresh on every call: a directory dropped under `nodes/` appears without
 * a restart, and one taken away disappears. A definition that could not be read
 * arrives under `problems` rather than making the list empty.
 */
export function listExtensionNodes(
  signal?: AbortSignal,
): Promise<ExtensionCatalog> {
  return http.request<ExtensionCatalog>("/api/v1/extensions/nodes", {
    signal,
  });
}
