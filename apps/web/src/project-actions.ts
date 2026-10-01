import type { ApiClient } from "./api.js";
import { setArchivedForSessions } from "./archive-actions.js";

type ArchiveApi = Pick<ApiClient, "archiveProjectSessions" | "setArchived">;

/** The body of a Project's Archive and Stop Sessions confirmation, in the plain terms of
 * archiveAndStopMessage() (#2162). `onProjectPage` adds that the Project and its Locations remain;
 * there, only the unarchived sessions are archived. */
export function projectArchiveMessage(input: {
  projectName: string;
  count: number;
  stops: boolean;
  onProjectPage: boolean;
}): string {
  const { count, onProjectPage } = input;
  const project = `“${input.projectName}”`;
  const sessions = onProjectPage ? "unarchived session" : "session";
  if (input.stops) {
    const outcome = count === 1
      ? `The ${sessions} in ${project} stops, its queued messages are canceled, and it moves to Archived Sessions.`
      : `All ${count} ${sessions}s in ${project} stop, their queued messages are canceled, and they move to Archived Sessions.`;
    if (!onProjectPage) return `${outcome} You can restore ${count === 1 ? "it" : "them"} later.`;
    return `${outcome} The Project and its Locations remain, and you can restore the ${count === 1 ? "session" : "sessions"}.`;
  }
  if (onProjectPage) {
    return count === 1
      ? `The ${sessions} in ${project} moves to Archived Sessions. The Project and its Locations remain.`
      : `All ${count} ${sessions}s in ${project} move to Archived Sessions. The Project and its Locations remain.`;
  }
  return count === 1
    ? `The session in ${project} moves to Archived Sessions. If it is still running, it is stopped first.`
    : `All ${count} sessions in ${project} move to Archived Sessions. Any that are still running are stopped first.`;
}

/** The result of archiving a Project's sessions, in archiveResultMessage()'s words for a count: a
 * stop that failed and may have left sessions running comes first, then sessions still stopping. */
export function projectArchiveResultMessage(
  projectName: string,
  counts: { archived: number; pending: number; failed: number },
): string {
  const sessions = (count: number) => `${count} session${count === 1 ? "" : "s"}`;
  if (counts.failed > 0) {
    return `The stop failed for ${sessions(counts.failed)} in ${projectName}, so ${counts.failed === 1 ? "it" : "they"} may still be running. Use Retry Stop to try again.`;
  }
  if (counts.pending > 0) {
    return `Archiving from ${projectName}. ${sessions(counts.pending)} ${counts.pending === 1 ? "is" : "are"} still stopping.`;
  }
  return `${sessions(counts.archived)} archived from ${projectName}.`;
}

/** An older server archives a Project's sessions without naming them, so there is nothing exact to undo. */
export function projectArchiveWithoutUndoMessage(projectName: string): string {
  return `Sessions archived from ${projectName}. Undo isn't available for this archive.`;
}

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
    input.showToast(projectArchiveWithoutUndoMessage(input.projectName));
    return null;
  }
  const affectedIds = [...new Set([...archivedIds, ...pendingIds, ...failedIds])];
  input.showUndo(
    projectArchiveResultMessage(input.projectName, {
      archived: archivedIds.length,
      pending: pendingIds.length,
      failed: failedIds.length,
    }),
    async () => {
      const failures = await setArchivedForSessions(affectedIds, false, input.api.setArchived);
      if (failures > 0) {
        throw new Error(`${failures} session${failures === 1 ? "" : "s"} could not be restored`);
      }
    },
  );
  return affectedIds.length;
}
