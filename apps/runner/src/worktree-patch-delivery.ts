import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { parseForgeRemote } from "./git-ops.js";
import { CONTAINMENT_FETCH_GIT_CONFIG, CONTAINMENT_FETCH_GIT_ENV } from "./worktree-forge-fetch.js";

export interface WorktreePatchDeliveryProof {
  tipOid: string;
  mergedHeadOid: string;
  defaultHeadOid: string;
  repository: string;
  pullRequest: number;
}
export type CampaignDeliveredPullRequest = { repository: string; number: number; headSha: string };
export type WorktreePatchDeliveryResult =
  | { state: "matched"; proof: WorktreePatchDeliveryProof }
  | { state: "not_matched" | "unavailable" | "ineligible" };
const OID = /^[a-f0-9]{40,64}$/u;
const LOCAL_LIMIT = 128;
const MERGED_LIMIT = 512;
const SAFE_GIT = ["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null"];
const ENV = { GIT_GRAFT_FILE: "/dev/null" };

/** Whitespace-preserving Git patch IDs, with bounded real commit walks. Empty/merge commits and
 * undecodable text refuse proof rather than silently omitting work. No diff driver can execute.
 * --verbatim is essential: stable patch IDs alone erase whitespace, including Python indentation. */
async function patchIds(cwd: string, context: AgentContext, base: string, tip: string, limit: number,
  signal: AbortSignal): Promise<Set<string> | null> {
  const git = (args: string[], stdin?: string) => runContextCommand(context, "git", [...SAFE_GIT, ...args],
    { cwd, env: ENV, stdin, signal, timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const rows = (await git(["rev-list", "--parents", `--max-count=${limit + 1}`, `${base}..${tip}`]))
    .stdout.trim().split("\n").filter(Boolean);
  if (!rows.length || rows.length > limit) return null;
  const commits = new Set<string>();
  for (const row of rows) {
    const parents = row.split(" ");
    if (parents.length !== 2 || !parents.every((value) => OID.test(value))) return null;
    commits.add(parents[0]!);
  }
  // Git's stdin format preserves a commit boundary for patch-id. Verify one result for every
  // input commit: an empty patch must not silently disappear from the proof.
  const patch = (await git(["diff-tree", "--stdin", "-r", "-p", "--binary", "--full-index",
    "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=3",
    "--ignore-submodules=none", "--submodule=short", "--no-relative", "--diff-algorithm=myers",
    "--src-prefix=a/", "--dst-prefix=b/", "--"], [...commits].join("\n") + "\n")).stdout;
  if (!patch || patch.includes("\uFFFD")) return null;
  const output = (await git(["patch-id", "--verbatim"], patch)).stdout.trim().split("\n");
  const ids = new Set<string>();
  for (const line of output) {
    const parsed = /^([a-f0-9]{40,64}) ([a-f0-9]{40,64})$/u.exec(line);
    if (!parsed || !commits.delete(parsed[2]!)) return null;
    ids.add(parsed[1]!);
  }
  if (commits.size) return null;
  return ids;
}

/** Reprove against immutable fetched objects at the deletion boundary and on journal replay. */
export async function patchDeliveryContains(cwd: string, context: AgentContext, proof: WorktreePatchDeliveryProof,
  tip: string, signal = AbortSignal.timeout(90_000)): Promise<boolean> {
  if (tip !== proof.tipOid || ![tip, proof.mergedHeadOid, proof.defaultHeadOid].every((oid) => OID.test(oid))) return false;
  try {
    const local = await patchIds(cwd, context, proof.defaultHeadOid, tip, LOCAL_LIMIT, signal);
    const merged = await patchIds(cwd, context, proof.defaultHeadOid, proof.mergedHeadOid, MERGED_LIMIT, signal);
    return !!local && !!merged && [...local].every((id) => merged.has(id));
  } catch { return false; }
}

/** Candidates come only from the authenticated CP frame, never from a search for similar work.
 * The forge must freshly attest the exact admitted head as merged into its current default.
 * Fetch both histories anonymously using the same transport boundary as ancestry retirement. */
export async function proveWorktreePatchDelivery(
  cwd: string, branch: string, candidates: readonly CampaignDeliveredPullRequest[],
  options: { context: AgentContext; runForgeCommand?: typeof runContextCommand; forgeFetchRepository?: string },
): Promise<WorktreePatchDeliveryResult> {
  if (!candidates.length) return { state: "ineligible" };
  const { context } = options;
  const signal = AbortSignal.timeout(90_000);
  const git = (args: string[], env = ENV) => runContextCommand(context, "git", [...SAFE_GIT, ...args],
    { cwd, signal, env, timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
  let unavailable = false;
  const localSets = new Map<string, Set<string> | null>();
  try {
    // This proof never relaxes publication checks for a branch with a live upstream.
    try { await git(["rev-parse", "--verify", `${branch}@{upstream}`]); return { state: "ineligible" }; } catch { /* no live upstream */ }
    const tipOid = (await git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    const remote = parseForgeRemote((await git(["config", "--get", "remote.origin.url"])).stdout.trim());
    if (!OID.test(tipOid) || remote?.provider !== "github" || remote.host !== "github.com" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(remote.project)) return { state: "ineligible" };
    const [owner, name] = remote.project.split("/");
    for (const candidate of candidates.slice(0, 5)) {
      if (candidate.repository.toLowerCase() !== remote.project.toLowerCase() ||
          !Number.isSafeInteger(candidate.number) || candidate.number <= 0 || !OID.test(candidate.headSha)) continue;
      try {
        const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){" +
          "defaultBranchRef{name target{oid}} pullRequest(number:$number){state headRefOid baseRefName}}}";
        const response = await (options.runForgeCommand ?? runContextCommand)(context, "gh", ["api", "graphql", "--hostname", "github.com",
          "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${candidate.number}`],
        { cwd, signal, timeoutMs: 15_000, maxBuffer: 1024 * 1024 });
        const data = JSON.parse(response.stdout);
        const repo = data?.data?.repository;
        const pr = repo?.pullRequest;
        const defaultBranch = repo?.defaultBranchRef?.name;
        const defaultHeadOid = repo?.defaultBranchRef?.target?.oid;
        if (data.errors || !repo || !pr || !repo.defaultBranchRef ||
            !["MERGED", "OPEN", "CLOSED"].includes(pr.state) ||
            typeof pr.headRefOid !== "string" || !OID.test(pr.headRefOid) ||
            typeof pr.baseRefName !== "string" || typeof defaultBranch !== "string" ||
            typeof defaultHeadOid !== "string" || !OID.test(defaultHeadOid)) { unavailable = true; continue; }
        if (pr.state !== "MERGED" || pr.headRefOid !== candidate.headSha || pr.baseRefName !== defaultBranch) continue;
        await git(["check-ref-format", `refs/heads/${defaultBranch}`]);
        await git([...CONTAINMENT_FETCH_GIT_CONFIG,
          ...(options.forgeFetchRepository ? ["-c", "protocol.file.allow=always"] : []),
          "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--quiet", "--",
          options.forgeFetchRepository ?? `https://github.com/${remote.project}.git`,
          // Named refs force a remote read even when both observed objects are cached locally.
          // Fetching raw OIDs can succeed without contacting an unavailable endpoint.
          `refs/pull/${candidate.number}/head`, `refs/heads/${defaultBranch}`], { ...ENV, ...CONTAINMENT_FETCH_GIT_ENV });
        const proof = { tipOid, mergedHeadOid: candidate.headSha, defaultHeadOid,
          repository: candidate.repository, pullRequest: candidate.number };
        if (!localSets.has(defaultHeadOid)) {
          localSets.set(defaultHeadOid, await patchIds(cwd, context, defaultHeadOid, tipOid, LOCAL_LIMIT, signal));
        }
        const local = localSets.get(defaultHeadOid);
        const merged = await patchIds(cwd, context, defaultHeadOid, candidate.headSha, MERGED_LIMIT, signal);
        if (local && merged && [...local].every((id) => merged.has(id))) return { state: "matched", proof };
      } catch { unavailable = true; }
    }
  } catch { unavailable = true; }
  return { state: unavailable ? "unavailable" : "not_matched" };
}
