import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { CampaignLaunchInspectionMessage, CampaignLaunchInspectionResult } from "@wollipog/protocol";
import { inspectCampaignIssueScope } from "./campaign-issue-scope.js";

/** Runner-side ceiling, independent of whether the caller's cancellation ever arrives. */
export const CAMPAIGN_LAUNCH_INSPECTION_LIFETIME_MS = 60_000;

type Run = (cwd: string, command: string, args: string[], signal: AbortSignal) => Promise<string>;
const nativeRead: Run = (cwd, command, args, signal) => new Promise((resolve, reject) => {
  // `signal` terminates only this inspection's own child process.
  execFile(command, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
    if (error) reject(new Error("registered workspace inspection failed"));
    else resolve(stdout);
  });
});

class InspectionCancelled extends Error {}

/** Only this closed command plan runs: callers cannot supply a path, command or environment.
 * Once `signal` aborts, no further command starts and running ones are terminated. */
export async function inspectCampaignLaunch(
  message: CampaignLaunchInspectionMessage, workspaces: readonly { id: string; path: string }[],
  run: Run = nativeRead, signal: AbortSignal = new AbortController().signal,
): Promise<CampaignLaunchInspectionResult> {
  const base = { type: "campaign_launch_inspection_result" as const, requestId: message.requestId, workspaceId: message.workspaceId };
  const owned = (cwd: string, command: string, args: string[]) => {
    if (signal.aborted) return Promise.reject(new InspectionCancelled());
    return run(cwd, command, args, signal).then((output) => {
      if (signal.aborted) throw new InspectionCancelled();
      return output;
    });
  };
  try {
    if (Object.keys(message).some((key) => !["type", "requestId", "workspaceId", "issueNumbers"].includes(key)) ||
        typeof message.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.requestId) ||
        typeof message.workspaceId !== "string" || !message.workspaceId || message.workspaceId.length > 256 ||
        !Array.isArray(message.issueNumbers) || message.issueNumbers.length > 100 ||
        message.issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        new Set(message.issueNumbers).size !== message.issueNumbers.length) throw new Error("invalid inspection");
    const workspace = workspaces.find((candidate) => candidate.id === message.workspaceId);
    if (!workspace) throw new Error("unregistered workspace");
    const cwd = await realpath(workspace.path);
    const issueNumbers = [...message.issueNumbers].sort((a, b) => a - b);
    const { repository, candidates } = await inspectCampaignIssueScope((command, args) => owned(cwd, command, args), undefined, issueNumbers);
    if (JSON.stringify(candidates.map((c) => c.issue.number).sort((a, b) => a - b)) !== JSON.stringify(issueNumbers)) throw new Error("issue mismatch");
    const head = (await owned(cwd, "git", ["rev-parse", "HEAD"])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("invalid repository head");
    if (signal.aborted) throw new InspectionCancelled();
    // No origin URL, issue body/title, local path, command output or environment leaves this helper.
    const digest = createHash("sha256").update(JSON.stringify([cwd, repository, head, issueNumbers])).digest("hex");
    return { ...base, ok: true, repository, issueNumbers, digest };
  } catch {
    if (signal.aborted) return { ...base, ok: false, cancelled: true, error: "Inspection was cancelled before it completed; no launch was admitted." };
    return { ...base, ok: false, error: "Registered workspace origin and exact issues could not be verified; no launch was admitted." };
  }
}

/** Live inspections by request id. A cancel names one exact inspection and can reach no other
 * runner command; ids that are unknown or already finished are ignored. */
export class CampaignLaunchInspections {
  private readonly live = new Map<string, AbortController>();

  constructor(private readonly lifetimeMs = CAMPAIGN_LAUNCH_INSPECTION_LIFETIME_MS) {}

  async run(message: CampaignLaunchInspectionMessage, workspaces: readonly { id: string; path: string }[],
    run?: Run): Promise<CampaignLaunchInspectionResult> {
    const controller = new AbortController();
    const key = typeof message.requestId === "string" ? message.requestId : "";
    // A duplicate id never shares or replaces another inspection's controller.
    if (!key || this.live.has(key)) {
      controller.abort();
      return inspectCampaignLaunch(message, workspaces, run, controller.signal);
    }
    this.live.set(key, controller);
    const timer = setTimeout(() => controller.abort(), this.lifetimeMs);
    timer.unref?.();
    try {
      return await inspectCampaignLaunch(message, workspaces, run, controller.signal);
    } finally {
      clearTimeout(timer);
      if (this.live.get(key) === controller) this.live.delete(key);
    }
  }

  cancel(requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const controller = this.live.get(requestId);
    controller?.abort();
    return Boolean(controller);
  }

  get size(): number { return this.live.size; }
}
