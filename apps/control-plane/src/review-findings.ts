import type {
  BundleReviewFindingsRequest,
  CreateReviewFindingRequest,
  ForgeReviewSyncInfo,
  GitHubReviewSyncInfo,
  ReviewFinding,
  UpdateReviewFindingRequest,
} from "@wollipog/protocol";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const SCOPES = new Set(["uncommitted", "all_branch", "last_turn"]);
const SIDES = new Set(["left", "right"]);
const SEVERITIES = new Set(["blocker", "major", "minor", "nit"]);
const UPDATE_STATUSES = new Set(["open", "resolved", "dismissed"]);

function exactObject(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).every((key) => keys.includes(key)));
}

function validFilePath(path: string): boolean {
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** Runner replies cross a process/network boundary. Validate the complete authoritative snapshot
 * again in the control plane before it can persist links, bodies, or completion blockers. */
export function validateGitHubReviewSync(input: unknown): input is GitHubReviewSyncInfo {
  const value = input as Partial<GitHubReviewSyncInfo> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.repository !== "string" || value.repository.length > 200 ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value.repository) ||
      !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber! < 1 ||
      typeof value.pullRequestUrl !== "string" ||
      value.pullRequestUrl.toLowerCase() !== `https://github.com/${value.repository}/pull/${value.pullRequestNumber}` ||
      typeof value.pullRequestHeadOid !== "string" || !/^[a-f0-9]{40}$/.test(value.pullRequestHeadOid) ||
      typeof value.pullRequestBaseOid !== "string" || !/^[a-f0-9]{40}$/.test(value.pullRequestBaseOid) ||
      typeof value.localHeadOid !== "string" || !/^[a-f0-9]{40}$/.test(value.localHeadOid) ||
      typeof value.diffHash !== "string" || !/^[a-f0-9]{64}$/.test(value.diffHash) ||
      !Number.isSafeInteger(value.synchronizedAt) || value.synchronizedAt! < 1 ||
      !Array.isArray(value.threads) || value.threads.length > 500) return false;
  const ids = new Set<string>();
  for (const thread of value.threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread) ||
        typeof thread.threadId !== "string" || !thread.threadId || thread.threadId.length > 512 || ids.has(thread.threadId) ||
        !Number.isSafeInteger(thread.commentId) || thread.commentId < 1 ||
        typeof thread.url !== "string" || !thread.url.startsWith(`${value.pullRequestUrl}#discussion_`) ||
        typeof thread.path !== "string" || !validFilePath(thread.path) ||
        (thread.side !== "left" && thread.side !== "right") ||
        !Number.isSafeInteger(thread.line) || thread.line < 1 || thread.line > 10_000_000 ||
        typeof thread.body !== "string" || !thread.body || thread.body.length > 4_000 ||
        typeof thread.author !== "string" || !thread.author || thread.author.length > 160 || thread.author.includes("\0") ||
        !Number.isSafeInteger(thread.createdAt) || thread.createdAt < 1 ||
        !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt < thread.createdAt ||
        typeof thread.commitId !== "string" || !/^[a-f0-9]{40}$/.test(thread.commitId) ||
        (thread.subjectType !== "line" && thread.subjectType !== "file") ||
        typeof thread.resolved !== "boolean" || typeof thread.outdated !== "boolean") return false;
    ids.add(thread.threadId);
  }
  return true;
}

/** Validate a provider-neutral authoritative snapshot before any remote content becomes durable. */
export function validateForgeReviewSync(input: unknown): input is ForgeReviewSyncInfo {
  const value = input as Partial<ForgeReviewSyncInfo> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.provider !== "github" && value.provider !== "gitlab") ||
      typeof value.host !== "string" || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value.host) ||
      typeof value.project !== "string" || value.project.length > 512 ||
      value.project.split("/").length < 2 || value.project.split("/").some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(value.changeRequestNumber) || value.changeRequestNumber! < 1 ||
      typeof value.changeRequestUrl !== "string" ||
      typeof value.changeRequestHeadOid !== "string" || !/^[a-f0-9]{40}$/.test(value.changeRequestHeadOid) ||
      typeof value.changeRequestBaseOid !== "string" || !/^[a-f0-9]{40}$/.test(value.changeRequestBaseOid) ||
      typeof value.localHeadOid !== "string" || !/^[a-f0-9]{40}$/.test(value.localHeadOid) ||
      typeof value.diffHash !== "string" || !/^[a-f0-9]{64}$/.test(value.diffHash) ||
      !Number.isSafeInteger(value.synchronizedAt) || value.synchronizedAt! < 1 ||
      !Array.isArray(value.threads) || value.threads.length > 500) return false;
  let requestUrl: URL;
  try { requestUrl = new URL(value.changeRequestUrl); } catch { return false; }
  const expectedPath = value.provider === "github"
    ? `/${value.project}/pull/${value.changeRequestNumber}`
    : `/${value.project}/-/merge_requests/${value.changeRequestNumber}`;
  const pathMatches = value.provider === "github"
    ? requestUrl.pathname.toLowerCase() === expectedPath.toLowerCase()
    : requestUrl.pathname === expectedPath;
  if (!new Set(["http:", "https:"]).has(requestUrl.protocol) || requestUrl.username || requestUrl.password ||
      requestUrl.host.toLowerCase() !== value.host ||
      !pathMatches || requestUrl.search || requestUrl.hash ||
      (value.provider === "github" && (value.host !== "github.com" || requestUrl.protocol !== "https:"))) return false;
  const ids = new Set<string>();
  for (const thread of value.threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread) ||
        typeof thread.threadId !== "string" || !thread.threadId || thread.threadId.length > 512 || ids.has(thread.threadId) ||
        !Number.isSafeInteger(thread.commentId) || thread.commentId < 1 ||
        typeof thread.url !== "string" || !thread.url.startsWith(`${value.changeRequestUrl}#${value.provider === "github" ? "discussion_" : "note_"}`) ||
        typeof thread.path !== "string" || !validFilePath(thread.path) ||
        (thread.side !== "left" && thread.side !== "right") ||
        !Number.isSafeInteger(thread.line) || thread.line < 1 || thread.line > 10_000_000 ||
        typeof thread.body !== "string" || !thread.body || thread.body.length > 4_000 ||
        typeof thread.author !== "string" || !thread.author || thread.author.length > 160 || thread.author.includes("\0") ||
        !Number.isSafeInteger(thread.createdAt) || thread.createdAt < 1 ||
        !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt < thread.createdAt ||
        typeof thread.commitId !== "string" || !/^[a-f0-9]{40}$/.test(thread.commitId) ||
        !new Set(["line", "file", "remote"]).has(thread.subjectType) ||
        (thread.subjectType === "remote" && value.provider !== "gitlab") ||
        typeof thread.resolved !== "boolean" || typeof thread.outdated !== "boolean") return false;
    ids.add(thread.threadId);
  }
  return true;
}

export function parseCreateReviewFinding(input: unknown): Parsed<CreateReviewFindingRequest> {
  const keys = ["scope", "diffHash", "filePath", "side", "line", "body", "severity", "required"] as const;
  if (!exactObject(input, keys) || Object.keys(input).length !== keys.length) {
    return { ok: false, error: "review finding request is malformed" };
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!SCOPES.has(input.scope as string) ||
      typeof input.diffHash !== "string" || !/^[a-f0-9]{64}$/.test(input.diffHash) ||
      typeof input.filePath !== "string" || !validFilePath(input.filePath) ||
      !SIDES.has(input.side as string) ||
      !Number.isSafeInteger(input.line) || (input.line as number) < 1 || (input.line as number) > 10_000_000 ||
      !body || body.length > 4_000 ||
      !SEVERITIES.has(input.severity as string) || typeof input.required !== "boolean") {
    return { ok: false, error: "review finding request is invalid" };
  }
  return {
    ok: true,
    value: {
      scope: input.scope as CreateReviewFindingRequest["scope"],
      diffHash: input.diffHash,
      filePath: input.filePath,
      side: input.side as CreateReviewFindingRequest["side"],
      line: input.line as number,
      body,
      severity: input.severity as CreateReviewFindingRequest["severity"],
      required: input.required,
    },
  };
}

export function parseUpdateReviewFinding(input: unknown): Parsed<UpdateReviewFindingRequest> {
  const keys = ["status", "expectedUpdatedAt"] as const;
  if (!exactObject(input, keys) || Object.keys(input).length !== keys.length ||
      !UPDATE_STATUSES.has(input.status as string) ||
      !Number.isSafeInteger(input.expectedUpdatedAt) || (input.expectedUpdatedAt as number) < 0) {
    return { ok: false, error: "review finding update is malformed" };
  }
  return { ok: true, value: input as unknown as UpdateReviewFindingRequest };
}

export function parseBundleReviewFindings(input: unknown): Parsed<BundleReviewFindingsRequest> {
  if (!exactObject(input, ["findings"]) || Object.keys(input).length !== 1 ||
      !Array.isArray(input.findings) || input.findings.length < 1 || input.findings.length > 50) {
    return { ok: false, error: "findings must contain between 1 and 50 identities" };
  }
  const seen = new Set<string>();
  const findings: BundleReviewFindingsRequest["findings"] = [];
  for (const item of input.findings) {
    if (!exactObject(item, ["findingId", "expectedUpdatedAt"]) || Object.keys(item).length !== 2 ||
        typeof item.findingId !== "string" || !/^rf_[A-Za-z0-9_-]{8,64}$/.test(item.findingId) ||
        !Number.isSafeInteger(item.expectedUpdatedAt) || (item.expectedUpdatedAt as number) < 0 ||
        seen.has(item.findingId)) {
      return { ok: false, error: "review finding identities are malformed or duplicated" };
    }
    seen.add(item.findingId);
    findings.push({ findingId: item.findingId, expectedUpdatedAt: item.expectedUpdatedAt as number });
  }
  return { ok: true, value: { findings } };
}

export function formatReviewFindingsPrompt(findings: ReviewFinding[]): string {
  const entries = findings.map((finding, index) => {
    const requirement = finding.required ? "REQUIRED" : "OPTIONAL";
    const location = finding.remote?.subjectType === "remote"
      ? `Remote ${finding.remote.provider === "gitlab" ? "GitLab discussion" : "forge discussion"} (${finding.remote.url})`
      : `${finding.filePath}:${finding.line} (${finding.side}, ${finding.scope})`;
    return [
      `${index + 1}. [${requirement}] [${finding.severity.toUpperCase()}] ${location}`,
      `   Finding: ${finding.body.replace(/\r?\n/g, "\n   ")}`,
      `   Review finding id: ${finding.findingId}`,
    ].join("\n");
  });
  return [
    "Please address the following inline code-review findings in this worktree.",
    "",
    ...entries,
    "",
    "After making the changes, run focused validation and summarize how each finding was addressed. Do not mark findings resolved yourself; the reviewer will verify and resolve them.",
  ].join("\n");
}
