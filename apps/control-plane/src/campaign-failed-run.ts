import { runnerSupportsProtocol, type CampaignFailedRunEvidence, type CampaignRecommendation, type SessionView } from "@wollipog/protocol";
import { randomUUID } from "node:crypto";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { issueEvidenceDigest } from "./campaign-issue-authority.js";

/** Body URLs are bounded lookup hints. Ownership comes from origin work and runner-admitted
 * review snapshots or consumed merge gates. A fresh forge read proves the actual failure. */
export async function failedCampaignRun(db: ControlPlaneDb, hub: Hub, root: SessionView, body: string,
  recommendation: CampaignRecommendation): Promise<CampaignFailedRunEvidence | null> {
  if (!runnerSupportsProtocol(db.getRunner(root.runnerId)?.protocolVersion, "campaignFailedRunEvidence")) return null;
  const hints = [...body.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/([1-9][0-9]*)(?=[\s/#?)\]]|$)/gu)].slice(0, 4);
  if (!hints.length) return null;
  let reads = 0;
  const deadline = Date.now() + 20_000;
  for (const id of recommendation.originWorkItemIds) {
    const item = db.campaignWorkLedger.detail(root.id, id, Date.now());
    if (!item) continue;
    const sessions = item.attempts.flatMap((attempt) => attempt.sessionId ? [attempt.sessionId] : []);
    const heads = sessions.flatMap((session) => db.reviewSessions.forRequester(session).flatMap((review) => {
      const link = db.reviewSessions.link(review);
      // Merely requesting a review records the agent's claimed head before runner validation.
      // Only a valid completed review establishes that the runner proved snapshot ownership.
      const view = db.reviewSessions.view(review);
      return link && view?.state === "completed" && view.verdict?.valid
        ? [{ repository: link.pullRequest.repository, pullRequest: link.pullRequest.number, headSha: link.headSha }] : [];
    }));
    for (const gate of db.consumedPullRequestMerges(sessions)) {
      const value = gate.resourceSnapshot;
      if (value.category === "pr_merge") heads.push(value);
    }
    for (const head of heads) {
      if (!item.stage?.pullRequests.some((pr) => pr.repository.toLowerCase() === head.repository && pr.number === head.pullRequest)) continue;
      for (const hint of hints) {
        if (hint[1]!.toLowerCase() !== head.repository) continue;
        const evidence = { repository: head.repository, pullRequest: head.pullRequest, headSha: head.headSha, runId: Number(hint[2]) };
        if (!Number.isSafeInteger(evidence.runId)) continue;
        if (++reads > 8) return null;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const requestId = `failed_run_${randomUUID()}`;
        try {
          const result = await hub.requestFromRunner(root.runnerId, requestId, { type: "campaign_issue_scope",
            operation: "failed_run_inspect", sessionId: root.id, requestId, evidence }, Math.min(5_000, remaining));
          if (result.type === "campaign_issue_scope_result" && result.requestId === requestId && result.sessionId === root.id &&
              result.ok && result.repository === head.repository && issueEvidenceDigest(result.failedRun) === issueEvidenceDigest(evidence)) return evidence;
        } catch { return null; /* A failed read retains the ordinary model check without more waits. */ }
      }
    }
  }
  return null;
}
