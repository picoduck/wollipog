/**
 * GitLab merge preflight (#3602, protocol v239): before a GitLab `pr_merge` decision is armed, read
 * GitLab through the child session's own `glab` login and check the exact approved snapshot against
 * it. Read-only, always naming the host. Every failure is a fixed sentence, never `glab` output.
 *
 * The canonical merge call pins the approved head itself (`sha=`), so a later move still fails at
 * GitLab. This check adds what that call cannot: a direct merge is refused on a project that runs
 * merge trains (GitLab would merge it straight past the train), a train merge on a project without
 * them or on an instance older than the merge-train API (15.11), squash outside the project's
 * squash option, and a train whose merge request deletes its source branch differently from what
 * was approved. A stale head is reported as such, so the control plane can revoke the approval.
 */
import type { GitLabMergePreflightMessage, GitLabMergePreflightResultMessage } from "@wollipog/protocol";
import { campaignRepositoryLocation } from "@wollipog/protocol";
import { classifyGlabFailure, type GlabRunner } from "./campaign-gitlab-status.js";

export type GitLabMergePreflight =
  | { ok: true }
  | { ok: false; refusal: NonNullable<GitLabMergePreflightResultMessage["refusal"]>; reason: string };

/** The first GitLab release with `POST /projects/:id/merge_trains/merge_requests/:iid`. */
const MERGE_TRAIN_API = { major: 15, minor: 11 };
/** GitLab's project `squash_option` values. */
const SQUASH_OPTIONS = new Set(["never", "always", "default_on", "default_off"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const refuse = (refusal: "stale_head" | "mismatch" | "unavailable", reason: string): GitLabMergePreflight =>
  ({ ok: false, refusal, reason });

export async function gitlabMergePreflight(
  request: Pick<GitLabMergePreflightMessage, "repository" | "pullRequest" | "headSha" | "mergeMethod" | "squash" | "removeSourceBranch">,
  glab: GlabRunner,
): Promise<GitLabMergePreflight> {
  const location = campaignRepositoryLocation(request.repository);
  if (location?.forge !== "gitlab" || !Number.isSafeInteger(request.pullRequest) || request.pullRequest < 1 ||
      !/^[0-9a-f]{40}$/u.test(request.headSha) || !["merge_train", "merge"].includes(request.mergeMethod)) {
    return refuse("mismatch", "The decision does not name a GitLab merge request this runner can check.");
  }
  const host = location.host.toLowerCase();
  const project = encodeURIComponent(location.project);
  const read = async (path: string): Promise<{ ok: true; value: Record<string, unknown> } | GitLabMergePreflight> => {
    const outcome = await glab(["api", path, "--hostname", host]);
    if (outcome.code !== null) {
      const failure = classifyGlabFailure(outcome);
      const words: Record<string, string> = {
        forge_cli_missing: "glab is not installed in this session's context.",
        forge_unauthenticated: `glab in this session's context is not signed in to ${host}.`,
        forge_unreachable: `${host} could not be reached.`,
        forge_rate_limited: `${host} rate-limited this glab login.`,
        forge_not_found: "GitLab has no such merge request or project, or this glab login cannot see it.",
      };
      return refuse("unavailable", words[failure] ?? "GitLab returned an error.");
    }
    try {
      const value = record(JSON.parse(outcome.stdout));
      return value ? { ok: true, value } : refuse("unavailable", "GitLab returned an unexpected answer.");
    } catch {
      return refuse("unavailable", "GitLab returned an unexpected answer.");
    }
  };

  if (request.mergeMethod === "merge_train") {
    const version = await read("version");
    if (!("value" in version)) return version;
    const match = typeof version.value.version === "string" ? /^(\d+)\.(\d+)/u.exec(version.value.version) : null;
    if (!match) return refuse("unavailable", "GitLab did not report its version.");
    const [major, minor] = [Number(match[1]), Number(match[2])];
    if (major < MERGE_TRAIN_API.major || (major === MERGE_TRAIN_API.major && minor < MERGE_TRAIN_API.minor)) {
      return refuse("mismatch", `GitLab ${major}.${minor} predates the merge-train API (15.11), so this runner will not guess a merge call.`);
    }
  }

  const settings = await read(`projects/${project}`);
  if (!("value" in settings)) return settings;
  // Only a genuine answer for this project proves its settings: an unexpected one is unreadable,
  // never "no trains". `merge_trains_enabled` exists only on tiers that have merge trains, so its
  // absence from a genuine answer means none; any other value is unreadable too.
  const squashOption = settings.value.squash_option;
  if (typeof settings.value.path_with_namespace !== "string" ||
      settings.value.path_with_namespace.toLowerCase() !== location.project.toLowerCase() ||
      !SQUASH_OPTIONS.has(squashOption as string) ||
      (settings.value.merge_trains_enabled !== undefined && typeof settings.value.merge_trains_enabled !== "boolean")) {
    return refuse("unavailable", "GitLab returned an unexpected answer for the project's settings.");
  }
  const trains = settings.value.merge_trains_enabled === true;
  if (request.mergeMethod === "merge" && trains) {
    return refuse("mismatch", "The project runs merge trains, so a direct merge would go around the train. Approve a merge-train merge instead.");
  }
  if (request.mergeMethod === "merge_train" && !trains) {
    return refuse("mismatch", "The project does not run merge trains. Approve a direct merge instead.");
  }
  if (request.squash && squashOption === "never") return refuse("mismatch", "The project never squashes, so a squash merge would be refused.");
  if (!request.squash && squashOption === "always") return refuse("mismatch", "The project always squashes, so approve a squash merge.");

  const mr = await read(`projects/${project}/merge_requests/${request.pullRequest}`);
  if (!("value" in mr)) return mr;
  if (mr.value.iid !== request.pullRequest || typeof mr.value.sha !== "string") {
    return refuse("unavailable", "GitLab returned an unexpected answer.");
  }
  // Known states get fixed sentences; anything else is an unexpected answer, which proves nothing.
  const closedState: Record<string, string> = {
    merged: "The merge request is already merged.",
    closed: "The merge request is closed.",
    locked: "The merge request is being merged already.",
  };
  if (mr.value.state !== "opened") {
    return typeof mr.value.state === "string" && Object.hasOwn(closedState, mr.value.state)
      ? refuse("mismatch", closedState[mr.value.state]!)
      : refuse("unavailable", "GitLab returned an unexpected answer for the merge request.");
  }
  if (mr.value.sha.toLowerCase() !== request.headSha) {
    return refuse("stale_head", "The merge request's head moved since this merge was approved.");
  }
  if (mr.value.draft === true || mr.value.work_in_progress === true) return refuse("mismatch", "The merge request is a draft.");
  if (request.mergeMethod === "merge_train") {
    // A train merge sends no deletion override, so GitLab applies the merge request's effective
    // setting: `should_remove_source_branch` when set, else `force_remove_source_branch`.
    const should = mr.value.should_remove_source_branch;
    const force = mr.value.force_remove_source_branch;
    if ((should !== null && should !== undefined && typeof should !== "boolean") ||
        (force !== null && force !== undefined && typeof force !== "boolean")) {
      return refuse("unavailable", "GitLab returned an unexpected answer for the merge request.");
    }
    const effective = typeof should === "boolean" ? should : force === true;
    if (effective !== request.removeSourceBranch) {
      return refuse("mismatch", "The merge request's own delete-source-branch setting differs from the approval, and a train merge uses it.");
    }
  }
  return { ok: true };
}
