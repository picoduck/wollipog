import { expect, type Page } from "@playwright/test";
export async function installSkillMatrixFixture(page: Page, options: { wslUnsupportedDetail?: string } = {}) {
  let pin: string | null = "v0";
  const old = { id: "v0", digest: "old", files: [{ path: "SKILL.md", encoding: "utf8", content: "Pinned review instructions" }] };
  const latest = { id: "v1", digest: "new", files: [{ path: "SKILL.md", encoding: "utf8", content: "Latest review instructions" }] };
  await page.route("**/api/runners/*/skills", route => route.fulfill({ json: {
    desired: [{ name: "code-review", versionDigest: "old", targets: [
      { agentId: "claude", invocation: "manual" },
      ...(options.wslUnsupportedDetail ? [{ agentId: "wsl", invocation: "agent" }] : []),
    ] }],
    reported: { updatedAt: 1700000000000, deployed: [{ name: "code-review", digest: "old", links: [
      { agentId: "claude", status: "linked" },
      { agentId: "codex", status: "linked" },
      ...(options.wslUnsupportedDetail
        ? [{ agentId: "wsl", status: "unsupported", detail: options.wslUnsupportedDetail }]
        : []),
    ] }] }, removalReporting: "supported",
  } }));
  await page.route("**/api/skills/skill-1/versions", route => route.fulfill({ json: { versions: [latest], nextCursor: null } }));
  await page.route("**/api/skills/skill-1/machines/*/version*", async route => {
    const url = new URL(route.request().url()); const first = url.pathname.includes("runner-1");
    const policy = first && pin ? { versionId: pin, revision: "r1" } : null;
    if (url.pathname.endsWith("version-policy")) return route.fulfill({ json: { policy } });
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON(); expect(body.expectedRevision).toBe("r1"); pin = body.versionId;
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: { policy, currentVersion: policy ? old : latest, proposedVersion: url.searchParams.get("versionId") === "v0" ? old : latest, expectedLatestVersionId: "v1" } });
  });
}
