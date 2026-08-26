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
  const failedIds = outcome.failedSessionIds ?? [];
  const pendingIds = outcome.pendingSessionIds ?? [];
  if (!archivedIds) {
    input.showToast(`Sessions archived from ${input.projectName}. Exact undo is unavailable on this connected control plane.`);
    return null;
  }
  const affectedIds = [...new Set([...archivedIds, ...pendingIds, ...failedIds])];
  input.showUndo(
    failedIds.length > 0
      ? `${failedIds.length} session Stop${failedIds.length === 1 ? " has" : "s have"} failed in ${input.projectName}. Runtime capacity may still be held; use Retry Stop.`
      : pendingIds.length > 0
        ? `${pendingIds.length} session${pendingIds.length === 1 ? " is" : "s are"} waiting for runtime capacity to be released before archiving from ${input.projectName}.`
        : `${archivedIds.length} session${archivedIds.length === 1 ? "" : "s"} archived from ${input.projectName}.`,
    async () => {
      const failures = await setArchivedForSessions(affectedIds, false, input.api.setArchived);
      if (failures > 0) {
        throw new Error(`${failures} session${failures === 1 ? "" : "s"} could not be restored`);
      }
    },
  );
  return affectedIds.length;
}
