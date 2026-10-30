/**
 * GitLab merge preflight (#3602): the exact approved snapshot checked against GitLab, read-only,
 * before a GitLab `pr_merge` is armed. `glab` is faked by path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome } from "./campaign-forge-status.js";
import type { GlabRunner } from "./campaign-gitlab-status.js";
import { gitlabMergePreflight } from "./gitlab-merge-preflight.js";
import { forgeProofOptions } from "./session-manager.js";
import type { SessionMeta } from "./session-store.js";

test("a GitLab merge's forge proof reads with the child agent's environment; GitHub keeps the runner's (#3608 review)", () => {
  const meta = { context: { kind: "native" } } as SessionMeta;
  const agentEnv = () => ({ GITLAB_TOKEN: "from-agent", GLAB_CONFIG_DIR: "/agent/glab" });
  assert.deepEqual(forgeProofOptions(meta, "https://gitlab.example.com/group/project/-/merge_requests/7", agentEnv),
    { context: { kind: "native" }, provider: "gitlab", env: agentEnv() });
  assert.deepEqual(forgeProofOptions(meta, "https://github.com/picoduck/wollipog/pull/7", agentEnv),
    { context: { kind: "native" }, provider: "github" });
  assert.deepEqual(forgeProofOptions(meta, "https://gitlab.example.com/group/project/-/merge_requests/7"),
    { context: { kind: "native" }, provider: "gitlab" });
});

const HOST = "gitlab.example.com";
const ENCODED = encodeURIComponent("platform/agents/wollipog");
const HEAD = "5c1e0b7a90f2c3d4e5f60718293a4b5c6d7e8f90";
const REQUEST = {
  repository: `${HOST}/platform/agents/wollipog`, pullRequest: 7, headSha: HEAD,
  mergeMethod: "merge_train" as const, squash: false, removeSourceBranch: false,
};
const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });

function fake(overrides: { version?: GhOutcome; project?: Record<string, unknown> | GhOutcome; mr?: Record<string, unknown> | GhOutcome } = {}) {
  const calls: string[][] = [];
  const answer = (value: Record<string, unknown> | GhOutcome | undefined, fallback: Record<string, unknown>) =>
    value && "code" in value ? value as GhOutcome : ok({ ...fallback, ...(value ?? {}) });
  const glab: GlabRunner = async (args) => {
    calls.push(args);
    if (args[1] === "version") return overrides.version ?? ok({ version: "17.7.1-ee", revision: "abc" });
    if (args[1] === `projects/${ENCODED}`) {
      return answer(overrides.project, { path_with_namespace: "platform/agents/wollipog", merge_trains_enabled: true, squash_option: "default_off" });
    }
    if (args[1] === `projects/${ENCODED}/merge_requests/7`) {
      return answer(overrides.mr, { iid: 7, state: "opened", draft: false, sha: HEAD, force_remove_source_branch: false });
    }
    throw new Error(`unexpected glab ${args.join(" ")}`);
  };
  return { glab, calls };
}

test("a train merge that fits the project and the open merge request at its approved head passes", async () => {
  const { glab, calls } = fake();
  assert.deepEqual(await gitlabMergePreflight(REQUEST, glab), { ok: true });
  assert.deepEqual(calls, [
    ["api", "version", "--hostname", HOST],
    ["api", `projects/${ENCODED}`, "--hostname", HOST],
    ["api", `projects/${ENCODED}/merge_requests/7`, "--hostname", HOST],
  ], "read-only GETs, always naming the host");
  const direct = fake({ project: { merge_trains_enabled: false } });
  assert.deepEqual(await gitlabMergePreflight({ ...REQUEST, mergeMethod: "merge", removeSourceBranch: true }, direct.glab), { ok: true });
  assert.equal(direct.calls.some((call) => call[1] === "version"), false, "a direct merge needs no merge-train API");
});

test("a merge never goes around an enabled train, and a train merge needs a project and version that run trains", async () => {
  const around = await gitlabMergePreflight({ ...REQUEST, mergeMethod: "merge" }, fake().glab);
  assert.equal(around.ok === false && around.refusal, "mismatch");
  assert.match(around.ok ? "" : around.reason, /go around the train/u);
  const noTrains = await gitlabMergePreflight(REQUEST, fake({ project: { merge_trains_enabled: false } }).glab);
  assert.match(noTrains.ok ? "" : noTrains.reason, /does not run merge trains/u);
  const absent = await gitlabMergePreflight(REQUEST, fake({ project: { merge_trains_enabled: undefined } }).glab);
  assert.equal(absent.ok, false, "a tier that does not report trains does not run them");
  for (const version of ["15.10.3", "14.9.0-ee"]) {
    const old = await gitlabMergePreflight(REQUEST, fake({ version: ok({ version }) }).glab);
    assert.equal(old.ok === false && old.refusal, "mismatch", version);
    assert.match(old.ok ? "" : old.reason, /predates the merge-train API/u);
  }
  assert.deepEqual(await gitlabMergePreflight(REQUEST, fake({ version: ok({ version: "15.11.0" }) }).glab), { ok: true });
  const unknown = await gitlabMergePreflight(REQUEST, fake({ version: ok({ revision: "x" }) }).glab);
  assert.equal(unknown.ok === false && unknown.refusal, "unavailable", "an unreported version is never guessed");
});

test("a moved head is stale; a closed, merged, or draft merge request and settings outside the project are mismatches", async () => {
  const stale = await gitlabMergePreflight(REQUEST, fake({ mr: { sha: "a".repeat(40) } }).glab);
  assert.deepEqual(stale, { ok: false, refusal: "stale_head", reason: "The merge request's head moved since this merge was approved." });
  for (const mr of [{ state: "merged" }, { state: "closed" }, { draft: true }, { force_remove_source_branch: true }]) {
    const result = await gitlabMergePreflight(REQUEST, fake({ mr }).glab);
    assert.equal(result.ok === false && result.refusal, "mismatch", JSON.stringify(mr));
  }
  assert.deepEqual(await gitlabMergePreflight({ ...REQUEST, removeSourceBranch: true },
    fake({ mr: { force_remove_source_branch: true } }).glab), { ok: true }, "a train merge uses the merge request's own setting");
  const never = await gitlabMergePreflight({ ...REQUEST, squash: true }, fake({ project: { squash_option: "never" } }).glab);
  assert.match(never.ok ? "" : never.reason, /never squashes/u);
  const always = await gitlabMergePreflight(REQUEST, fake({ project: { squash_option: "always" } }).glab);
  assert.match(always.ok ? "" : always.reason, /always squashes/u);
});

test("a train merge checks the merge request's effective source-branch deletion (#3608 review)", async () => {
  // should_remove_source_branch, when set, is what GitLab applies; force_remove_source_branch otherwise.
  const keep = { ...REQUEST, removeSourceBranch: false };
  const deletes = await gitlabMergePreflight(keep,
    fake({ mr: { should_remove_source_branch: true, force_remove_source_branch: false } }).glab);
  assert.equal(deletes.ok === false && deletes.refusal, "mismatch", "an approved keep never deletes the branch");
  assert.deepEqual(await gitlabMergePreflight(keep,
    fake({ mr: { should_remove_source_branch: false, force_remove_source_branch: true } }).glab), { ok: true });
  assert.deepEqual(await gitlabMergePreflight({ ...REQUEST, removeSourceBranch: true },
    fake({ mr: { should_remove_source_branch: null, force_remove_source_branch: true } }).glab), { ok: true });
  const odd = await gitlabMergePreflight(keep, fake({ mr: { should_remove_source_branch: "yes" } }).glab);
  assert.equal(odd.ok === false && odd.refusal, "unavailable");
});

test("an unexpected project or merge request answer is unreadable, never no trains, and is never echoed (#3608 review)", async () => {
  for (const project of [
    { path_with_namespace: undefined },
    { path_with_namespace: "someone/else" },
    { squash_option: undefined },
    { squash_option: "sometimes" },
    { merge_trains_enabled: "true" },
  ]) {
    const result = await gitlabMergePreflight({ ...REQUEST, mergeMethod: "merge" }, fake({ project }).glab);
    assert.equal(result.ok === false && result.refusal, "unavailable", `${JSON.stringify(project)} proves nothing about trains`);
  }
  assert.deepEqual(await gitlabMergePreflight({ ...REQUEST, mergeMethod: "merge" },
    fake({ project: { merge_trains_enabled: undefined } }).glab), { ok: true }, "a genuine answer without trains has none");
  const strange = await gitlabMergePreflight(REQUEST, fake({ mr: { state: "<script>reopened</script>" } }).glab);
  assert.deepEqual(strange, { ok: false, refusal: "unavailable", reason: "GitLab returned an unexpected answer for the merge request." });
  const locked = await gitlabMergePreflight(REQUEST, fake({ mr: { state: "locked" } }).glab);
  assert.deepEqual(locked, { ok: false, refusal: "mismatch", reason: "The merge request is being merged already." });
});

test("GitLab being unreadable proves nothing, and nothing glab prints crosses", async () => {
  const unauthenticated = await gitlabMergePreflight(REQUEST,
    fake({ version: { stdout: "", stderr: "glab: 401 Unauthorized (HTTP 401) token=glpat-secret", code: 1, timedOut: false } }).glab);
  assert.deepEqual(unauthenticated, { ok: false, refusal: "unavailable", reason: `glab in this session's context is not signed in to ${HOST}.` });
  const missing = await gitlabMergePreflight(REQUEST,
    fake({ mr: { stdout: "", stderr: "glab: 404 Not Found (HTTP 404)", code: 1, timedOut: false } }).glab);
  assert.equal(missing.ok === false && missing.refusal, "unavailable");
  const garbage = await gitlabMergePreflight(REQUEST, fake({ project: { stdout: "<html>", stderr: "", code: null, timedOut: false } }).glab);
  assert.equal(garbage.ok === false && garbage.refusal, "unavailable");
  for (const bad of [{ repository: "group/sub/project" }, { repository: "picoduck/wollipog" }, { headSha: "nope" }, { pullRequest: 0 }]) {
    const result = await gitlabMergePreflight({ ...REQUEST, ...bad }, fake().glab);
    assert.equal(result.ok === false && result.refusal, "mismatch", JSON.stringify(bad));
  }
});
