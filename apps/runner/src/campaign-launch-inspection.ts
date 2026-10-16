import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { CampaignLaunchInspectionMessage, CampaignLaunchInspectionResult } from "@wollipog/protocol";
import { inspectCampaignIssueScope } from "./campaign-issue-scope.js";

type Run = (cwd: string, command: string, args: string[]) => Promise<string>;
const nativeRead: Run = (cwd, command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error("registered workspace inspection failed"));
    else resolve(stdout);
  });
});

/** Only this closed command plan runs: callers cannot supply a path, command or environment. */
export async function inspectCampaignLaunch(
  message: CampaignLaunchInspectionMessage, workspaces: readonly { id: string; path: string }[],
  run: Run = nativeRead,
): Promise<CampaignLaunchInspectionResult> {
  const base = { type: "campaign_launch_inspection_result" as const, requestId: message.requestId, workspaceId: message.workspaceId };
  try {
    if (Object.keys(message).some((key) => !["type", "requestId", "workspaceId", "issueNumbers"].includes(key)) ||
        typeof message.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.requestId) ||
        typeof message.workspaceId !== "string" || !message.workspaceId || message.workspaceId.length > 256 ||
        !Array.isArray(message.issueNumbers) || message.issueNumbers.length < 1 || message.issueNumbers.length > 100 ||
        message.issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        new Set(message.issueNumbers).size !== message.issueNumbers.length) throw new Error("invalid inspection");
    const workspace = workspaces.find((candidate) => candidate.id === message.workspaceId);
    if (!workspace) throw new Error("unregistered workspace");
    const cwd = await realpath(workspace.path);
    const issueNumbers = [...message.issueNumbers].sort((a, b) => a - b);
    const { repository, candidates } = await inspectCampaignIssueScope((command, args) => run(cwd, command, args), undefined, issueNumbers);
    if (JSON.stringify(candidates.map((c) => c.issue.number).sort((a, b) => a - b)) !== JSON.stringify(issueNumbers)) throw new Error("issue mismatch");
    const head = (await run(cwd, "git", ["rev-parse", "HEAD"])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("invalid repository head");
    // No origin URL, issue body/title, local path, command output or environment leaves this helper.
    const digest = createHash("sha256").update(JSON.stringify([cwd, repository, head, issueNumbers])).digest("hex");
    return { ...base, ok: true, repository, issueNumbers, digest };
  } catch {
    return { ...base, ok: false, error: "Registered workspace origin and exact issues could not be verified; no launch was admitted." };
  }
}
