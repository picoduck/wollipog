import { runnerSupportsProtocol, type RunnerView, type SessionView } from "@wollipog/protocol";

function activeWorktree(session: SessionView) {
  if (!session.worktreePath) return undefined;
  return session.worktrees?.find((worktree) => worktree.path === session.worktreePath);
}

/** Choose once per Project from the complete session inventory. Archived/legacy/unknown first
 * sessions do not silently transfer the notice to a later session. */
export function worktreeSetupNoticeSessionIds(
  sessions: Iterable<SessionView>,
  runners: ReadonlyMap<string, RunnerView>,
  dismissedProjectIds: ReadonlySet<string>,
  controlPlaneSupported = true,
): Set<string> {
  if (!controlPlaneSupported) return new Set();
  const firstByProject = new Map<string, SessionView>();
  for (const session of sessions) {
    if (!session.projectId || !session.worktreePath) continue;
    const prior = firstByProject.get(session.projectId);
    if (!prior || session.createdAt < prior.createdAt ||
        (session.createdAt === prior.createdAt && session.id.localeCompare(prior.id) < 0)) {
      firstByProject.set(session.projectId, session);
    }
  }
  const result = new Set<string>();
  for (const [projectId, session] of firstByProject) {
    if (dismissedProjectIds.has(projectId) || session.archived) continue;
    const runner = runners.get(session.runnerId);
    if (!runnerSupportsProtocol(runner?.protocolVersion, "worktreeSetupConfig")) continue;
    const worktree = activeWorktree(session);
    // setupConfig itself is the authority marker. Old/attached legacy views omit it, while a
    // newly verified automatic worktree may retain the historic `source: legacy` wire value.
    if (worktree?.setupConfig?.status === "absent") result.add(session.id);
  }
  return result;
}
