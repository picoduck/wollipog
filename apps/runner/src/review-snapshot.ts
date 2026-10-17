/**
 * The reviewed snapshot of a session's pull request (#3306, #561): which pull request a session
 * may have reviewed, and a runner-owned checkout of its exact pushed head.
 *
 * Scope: the session's own created native worktree, an open pull request from the same repository
 * whose head branch is that worktree's branch, at a head equal to the pull request's pushed head.
 * The repository is read from the runner-recorded project checkout, never through the worktree's
 * own `.git` pointer, which the session can rewrite.
 *
 * Integrity: the snapshot comes from a runner-owned mirror filled over the pack protocol, which
 * names every object by the hash it computes, so a session that rewrites its own object store
 * cannot change what is reviewed. Every fetch URL is built by the runner from the verified
 * repository name; no remote string from session-writable configuration reaches git. Nothing is
 * written to the session's worktree or its git metadata, and the session may keep working.
 */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { githubSlug } from "./git-ops.js";
import type { ReviewTools } from "./review-trust.js";
import type { SessionMeta } from "./session-store.js";

/** A GitHub `owner/name`; the only form a review request may name. */
export const GITHUB_REPOSITORY = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;
export const SESSION_IDENTITY = /^[A-Za-z0-9_-]{1,128}$/u;
export const PUSHED_HEAD = /^[0-9a-f]{40}$/u;

/** Flags for every git command the runner runs against a session's repository. The session can
 * write its worktree's git config, and these commands run outside its sandbox. */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;
/** Transports a mirror fetch may use, and full object checks on everything it receives. SSH is
 * allowed only with a verified `ssh`, which every fetch then runs by its absolute path. */
function fetchGit(ssh: boolean): string[] {
  return [
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "protocol.https.allow=always",
    "-c", `protocol.ssh.allow=${ssh ? "always" : "never"}`, "-c", "transfer.fsckObjects=true",
  ];
}
/** Names the bridge's controller process (and the reviewer it starts) so a restarted runner can
 * find a controller it spawned but never recorded. Never passed on to helpers. */
export const SESSION_REVIEW_JOB_VARIABLE = "WOLLIPOG_SESSION_REVIEW_JOB";
const MIRROR_FETCH_TIMEOUT_MS = 600_000;
const CHECKOUT_TIMEOUT_MS = 120_000;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A case-insensitive directory name for a validated `owner/name` (`_` cannot occur in an owner). */
export function repositoryKey(repository: string): string {
  return repository.toLowerCase().replace("/", "__");
}

export const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;

/** The runner's environment without anything that can make git or ssh run another program or
 * read another repository; the callers set PATH and the SSH command themselves. */
export function helperEnvironmentBase(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("GIT_") || name.endsWith("ASKPASS") || name === SESSION_REVIEW_JOB_VARIABLE) continue;
    env[name] = value;
  }
  return env;
}

/** A review the runner refuses; the message is one of the fixed reasons the protocol allows. */
export class ReviewScopeRefusal extends Error {}
export const refuseReview = (reason: string): never => { throw new ReviewScopeRefusal(reason); };

export interface PullRequestFacts {
  state: string;
  baseRepository: string;
  headRepository: string;
  headRef: string;
  headSha: string;
  baseSha: string;
}

export type ReviewExec = (
  command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<string>;

export interface ReviewScopeRequest {
  repository: string;
  number: number;
  headSha: string;
}

/** What `bindPullRequestScope` proved about a request. */
export interface BoundPullRequestScope {
  /** The runner-recorded project checkout, resolved. */
  repoPath: string;
  /** Its own `.git` directory, read over the pack protocol. */
  commonDir: string;
  /** The session worktree's branch, which is the pull request's head branch. */
  branch: string;
  pullRequest: PullRequestFacts;
  /** Built from the verified repository name; the origin's spelling only chooses SSH or HTTPS. */
  forgeUrl: string;
}

/**
 * Prove that `request` names the session's own open, same-repository pull request at its pushed
 * head, from the session's own created native worktree. Throws `ReviewScopeRefusal` otherwise.
 */
export async function bindPullRequestScope(input: {
  meta: SessionMeta | null | undefined;
  request: ReviewScopeRequest;
  tools: ReviewTools;
  env: NodeJS.ProcessEnv;
  exec: ReviewExec;
  pullRequest: (gh: string, repository: string, number: number, env?: NodeJS.ProcessEnv) => Promise<PullRequestFacts>;
  /** Further refusals that apply once the worktree is proven to be the session's own. */
  beforeRepository?: () => void;
}): Promise<BoundPullRequestScope> {
  const { meta, request, tools, env, exec } = input;
  if (!GITHUB_REPOSITORY.test(request.repository) || !Number.isSafeInteger(request.number) || request.number <= 0) {
    refuseReview("the pull request is not this session's open, same-repository pull request");
  }
  const worktree = meta?.worktreePath ? meta.worktrees?.find((candidate) => candidate.path === meta.worktreePath) : undefined;
  if (!meta || !worktree || worktree.source !== "created" || meta.context?.kind !== "native" ||
      (meta.executionTarget?.adapter && meta.executionTarget.adapter !== "host")) {
    refuseReview("the review must cover the session's own native managed worktree");
  }
  input.beforeRepository?.();
  const repoPath = realpathSync(meta!.repoPath);
  const origin = (await exec(tools.git, [...SAFE_GIT, "-C", repoPath, "remote", "get-url", "origin"], { env })).trim();
  const repository = request.repository;
  if (githubSlug(origin)?.toLowerCase() !== repository.toLowerCase()) {
    refuseReview("the pull request is not this session's open, same-repository pull request");
  }
  const pr = await input.pullRequest(tools.gh, repository, request.number, env);
  if (pr.state !== "open" || pr.baseRepository.toLowerCase() !== repository.toLowerCase() ||
      pr.headRepository.toLowerCase() !== repository.toLowerCase() || pr.headRef !== worktree!.branch) {
    refuseReview("the pull request is not this session's open, same-repository pull request");
  }
  if (!PUSHED_HEAD.test(request.headSha) || pr.headSha !== request.headSha) {
    refuseReview("the requested head is not the pull request's pushed head");
  }
  // The checkout's own `.git` directory, never a gitdir file or link that could name another
  // repository; and no `commondir` indirection inside it.
  const commonDir = join(repoPath, ".git");
  if (!lstatSync(commonDir, { throwIfNoEntry: false })?.isDirectory() || existsSync(join(commonDir, "commondir"))) {
    refuseReview("the review snapshot could not be prepared");
  }
  const forgeUrl = /^https:\/\//iu.test(origin) || !tools.ssh
    ? `https://github.com/${pr.baseRepository}.git` : `git@github.com:${pr.baseRepository}.git`;
  return { repoPath, commonDir, branch: worktree!.branch, pullRequest: pr, forgeUrl };
}

/**
 * Runner-owned mirrors of reviewed repositories and private checkouts of them. One instance per
 * runner: every fetch into a mirror is serialized through it.
 */
export class ReviewSnapshotter {
  /** One mirror fetch at a time per repository. */
  private readonly mirrorQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly exec: ReviewExec,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * The environment for every git and gh command the runner runs for a review. PATH holds only a
   * runner-private directory of links to the verified git, gh and ssh, then the system
   * directories, so no program that git or a credential helper looks up by name (`ssh` for an SSH
   * fetch above all) can come from a directory a session can write; SSH runs by its verified path.
   * HOME stays, so the user's own git and gh configuration and credentials keep working.
   */
  helperEnvironment(tools: ReviewTools): NodeJS.ProcessEnv {
    const links: Record<string, string> = {
      git: tools.git, ...(tools.gh ? { gh: tools.gh } : {}), ...(tools.ssh ? { ssh: tools.ssh } : {}),
    };
    const bin = join(this.root, "tools", sha256(JSON.stringify(links)).slice(0, 24));
    if (!existsSync(bin)) {
      // Built aside and renamed into place, so a directory that exists is always complete.
      const staging = `${bin}.${process.pid}.${randomBytes(6).toString("hex")}`;
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const [name, target] of Object.entries(links)) symlinkSync(target, join(staging, name));
      try { renameSync(staging, bin); } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        if (!existsSync(bin)) throw error;
      }
    }
    return {
      ...helperEnvironmentBase(),
      PATH: `${bin}:/usr/bin:/bin`,
      GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
      // Overrides any `core.sshCommand`; without a verified ssh no fetch is allowed SSH at all.
      GIT_SSH_COMMAND: tools.ssh ? shellQuote(tools.ssh) : "/bin/false",
    };
  }

  /** The bare mirror of `repository` (case-insensitive). */
  mirrorPath(repository: string): string {
    return join(this.root, "mirrors", `${repositoryKey(repository)}.git`);
  }

  /**
   * Bring `commits` into the runner-owned mirror. The session's object store is read over the pack
   * protocol, which hashes everything it receives, so rewritten objects there are refused rather
   * than reviewed; anything still missing comes from the forge.
   */
  async syncMirror(
    git: string, env: NodeJS.ProcessEnv, ssh: boolean, mirror: string, commonDir: string, branch: string, forgeUrl: string, commits: string[],
  ): Promise<void> {
    const previous = this.mirrorQueues.get(mirror) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (!existsSync(join(mirror, "HEAD"))) {
        mkdirSync(dirname(mirror), { recursive: true, mode: 0o700 });
        await this.exec(git, [...SAFE_GIT, "init", "--quiet", "--bare", "--end-of-options", mirror], { env });
      }
      const has = (sha: string) => this.exec(git, [...SAFE_GIT, "--git-dir", mirror, "cat-file", "-e", `${sha}^{commit}`], { env })
        .then(() => true, () => false);
      const missing = async () => (await Promise.all(commits.map(async (sha) => (await has(sha)) ? null : sha)))
        .filter((sha): sha is string => sha !== null);
      if ((await missing()).length) {
        await this.exec(git, [
          ...SAFE_GIT, ...fetchGit(ssh), "--git-dir", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
          // Only the session's own branch: nothing else in the checkout reaches the reviewer.
          "--end-of-options", `file://${commonDir}`, `+refs/heads/${branch}:refs/session/heads/${branch}`,
        ], { timeoutMs: MIRROR_FETCH_TIMEOUT_MS, env }).catch((error: Error) => this.log(`review mirror could not read the project repository: ${error.message}`));
      }
      const still = await missing();
      if (still.length) {
        await this.exec(git, [
          ...SAFE_GIT, ...fetchGit(ssh), "--git-dir", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
          "--end-of-options", forgeUrl, ...still,
        ], { timeoutMs: MIRROR_FETCH_TIMEOUT_MS, env });
      }
    });
    const settledRun = run.then(() => {}, () => {});
    this.mirrorQueues.set(mirror, settledRun);
    try {
      await run;
    } finally {
      if (this.mirrorQueues.get(mirror) === settledRun) this.mirrorQueues.delete(mirror);
    }
  }

  /** Fill the mirror for `scope` with its base and `headSha`, and return the mirror's path. */
  async syncScope(tools: ReviewTools, env: NodeJS.ProcessEnv, repository: string, scope: BoundPullRequestScope, headSha: string): Promise<string> {
    const mirror = this.mirrorPath(repository);
    await this.syncMirror(tools.git, env, Boolean(tools.ssh), mirror, scope.commonDir, scope.branch, scope.forgeUrl,
      [scope.pullRequest.baseSha, headSha]);
    return mirror;
  }

  /** A private checkout of the mirror at exactly `headSha`, detached. */
  async checkout(git: string, env: NodeJS.ProcessEnv, mirror: string, destination: string, headSha: string): Promise<void> {
    await this.exec(git, [...SAFE_GIT, "clone", "--quiet", "--shared", "--no-checkout", "--end-of-options", mirror, destination], { timeoutMs: CHECKOUT_TIMEOUT_MS, env });
    await this.exec(git, [...SAFE_GIT, "-C", destination, "checkout", "--quiet", "--detach", headSha], { timeoutMs: CHECKOUT_TIMEOUT_MS, env });
  }
}
