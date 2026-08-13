import type { ApiClient } from "./api.js";
import { setArchivedForSessions } from "./archive-actions.js";

type ArchiveApi = Pick<ApiClient, "archiveProjectSessions" | "setArchived">;

export async function archiveProjectWithFeedback(input: {
  projectId: string;
  projectName: string;
  api: ArchiveApi;
  showToast: (message: string) => number;
  showUndo: (message: string, undo: () => void | Promise<void>) => number;
}): Promise<number | null> {
  const outcome = await input.api.archiveProjectSessions(input.projectId);
  const archivedIds = outcome.archivedSessionIds;
  if (!archivedIds) {
    input.showToast(`Sessions archived from ${input.projectName}. Exact undo is unavailable on this connected control plane.`);
    return null;
  }
  input.showUndo(
    `${archivedIds.length} session${archivedIds.length === 1 ? "" : "s"} archived from ${input.projectName}.`,
    async () => {
      const failures = await setArchivedForSessions(archivedIds, false, input.api.setArchived);
      if (failures > 0) {
        throw new Error(`${failures} session${failures === 1 ? "" : "s"} could not be restored`);
      }
    },
  );
  return archivedIds.length;
}
