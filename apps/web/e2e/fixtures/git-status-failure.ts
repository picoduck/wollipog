import type { Page } from "@playwright/test";
import type { GitStatusInfo } from "@wollipog/protocol";

export const GIT_STATUS_DIAGNOSTIC = "Command failed: git --no-optional-locks status --porcelain=v1 --untracked-files=all\nfatal: .git/index: index file smaller than expected\n";
export const LAST_KNOWN_STATUS: GitStatusInfo = {
  branch: "feature/retry", files: [{ status: "M", path: "src/retry.ts" }],
  hasChanges: true, ahead: 2, remoteUrl: null, stagedCount: 0,
};

/** Controlled HTTP responses, with no runner or Git mutations. */
export async function routeGitStatusFailure(page: Page, initiallyFailing = true) {
  let failing = initiallyFailing;
  let status = LAST_KNOWN_STATUS;
  let statusReads = 0;
  await page.route("**/api/sessions/git-status-failure-e2e/git", async (route) => {
    const body = route.request().postDataJSON() as { action: string };
    if (body.action === "status") {
      statusReads += 1;
      await route.fulfill({ status: failing ? 400 : 200, json: failing
        ? { error: GIT_STATUS_DIAGNOSTIC }
        : { status } });
    } else if (body.action === "diff") {
      await route.fulfill({ json: { diff: {
        scope: "uncommitted", diffHash: "d".repeat(64), files: [],
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
      } } });
    } else {
      throw new Error(`Unexpected Git operation: ${body.action}`);
    }
  });
  await page.route("**/api/sessions/git-status-failure-e2e/review-findings*", (route) => route.fulfill({ json: {
    findings: [], summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0,
      resolved: 0, dismissed: 0, completion: "complete" },
  } }));
  return {
    fail: () => { failing = true; },
    recover: (nextStatus = LAST_KNOWN_STATUS) => { failing = false; status = nextStatus; },
    statusReads: () => statusReads,
  };
}
