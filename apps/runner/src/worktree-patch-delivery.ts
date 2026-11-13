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
  const ids = new Set<string>();
  for (const row of rows) {
    const commits = row.split(" ");
    if (commits.length !== 2 || !commits.every((value) => OID.test(value))) return null;
    const patch = (await git(["diff-tree", "--no-commit-id", "-r", "-p", "--binary", "--full-index",
      "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=3",
      "--ignore-submodules=none", "--submodule=short", "--no-relative", "--diff-algorithm=myers",
      "--src-prefix=a/", "--dst-prefix=b/", commits[1]!, commits[0]!, "--"])).stdout;
    if (!patch || patch.includes("\uFFFD")) return null;
    const output = (await git(["patch-id", "--verbatim"], patch)).stdout.trim();
    const id = /^([a-f0-9]{40,64}) [a-f0-9]{40,64}$/u.exec(output)?.[1];
    if (!id) return null;
    ids.add(id);
  }
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
): Promise<WorktreePatchDeliveryProof | undefined> {
  const { context } = options;
  const signal = AbortSignal.timeout(90_000);
  const git = (args: string[], env = ENV) => runContextCommand(context, "git", [...SAFE_GIT, ...args],
    { cwd, signal, env, timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
  try {
    // This proof never relaxes publication checks for a branch with a live upstream.
    try { await git(["rev-parse", "--verify", `${branch}@{upstream}`]); return undefined; } catch { /* no live upstream */ }
    const tipOid = (await git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    const remote = parseForgeRemote((await git(["config", "--get", "remote.origin.url"])).stdout.trim());
    if (!OID.test(tipOid) || remote?.provider !== "github" || remote.host !== "github.com" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(remote.project)) return undefined;
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
        if (data.errors || pr?.state !== "MERGED" || pr.headRefOid !== candidate.headSha ||
            typeof defaultBranch !== "string" || pr.baseRefName !== defaultBranch ||
            typeof defaultHeadOid !== "string" || !OID.test(defaultHeadOid)) continue;
        await git(["check-ref-format", `refs/heads/${defaultBranch}`]);
        await git([...CONTAINMENT_FETCH_GIT_CONFIG,
          ...(options.forgeFetchRepository ? ["-c", "protocol.file.allow=always"] : []),
          "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--quiet", "--",
          options.forgeFetchRepository ?? `https://github.com/${remote.project}.git`,
          candidate.headSha, defaultHeadOid], { ...ENV, ...CONTAINMENT_FETCH_GIT_ENV });
        const proof = { tipOid, mergedHeadOid: candidate.headSha, defaultHeadOid,
          repository: candidate.repository, pullRequest: candidate.number };
        if (await patchDeliveryContains(cwd, context, proof, tipOid, signal)) return proof;
      } catch { /* Missing/moved/unreadable forge objects never constitute delivery. */ }
    }
  } catch { /* Unavailable Git or unsupported forge retains the worktree. */ }
  return undefined;
}
