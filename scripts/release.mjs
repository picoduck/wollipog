import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { FINALIZER_JOB, NATIVE_RELEASE_JOBS, readReleaseTimings } from "./release-timings.mjs";

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VERSION_FILES = ["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock",
  "apps/runner/src/version.ts", "apps/control-plane/src/release-version.ts"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = (condition, message) => { if (!condition) throw new Error(message); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const entry = (path) => { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
export const notesPath = (version) => `docs/release-notes-v${version}.md`;

/** No credentials or persisted authority: grants are supplied anew by the caller on each invocation. */
export function validateCheckpoint(state) {
  const keys = new Set(["schema", "repository", "version", "tag", "branch", "notesPath", "notesSha256", "baseSha", "oldVersion", "stage", "headSha", "prNumber", "mergeSha", "integrationSha", "integrationHistory", "runId", "runAttempt", "releaseId", "timings"]);
  check(state && Object.keys(state).every((key) => keys.has(key)), "Unexpected checkpoint fields; credentials and grants must not be persisted");
  check(state?.schema === 1 && REPOSITORY.test(state.repository ?? "") && VERSION.test(state.version ?? ""), "Invalid release checkpoint identity");
  check(typeof state.branch === "string" && /^[A-Za-z0-9][\w./-]{0,180}$/.test(state.branch) && !state.branch.includes(".."), "Invalid release branch");
  check(state.tag === `v${state.version}` && state.notesPath === notesPath(state.version) && /^[a-f0-9]{64}$/.test(state.notesSha256 ?? ""), "Invalid release notes identity");
  check(SHA.test(state.baseSha ?? ""), "Missing preparation base");
  for (const key of ["headSha", "mergeSha", "integrationSha"]) check(state[key] === undefined || state[key] === null || SHA.test(state[key]), `Invalid ${key}`);
  for (const key of ["prNumber", "releaseId", "runId", "runAttempt"]) check(state[key] === undefined || positive(state[key]), `Invalid ${key}`);
  return state;
}

export function saveCheckpoint(path, state) {
  validateCheckpoint(state);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  check(!entry(path)?.isSymbolicLink(), "Checkpoint must not be a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
}

function command(program, args, options = {}) {
  try { return execFileSync(program, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) {
    // Keep untrusted response bodies, authenticated URLs, and inherited credentials out of logs.
    const failure = new Error(`${program} command failed; inspect its result locally before retrying`);
    failure.notFound = /\(HTTP 404\)/.test(String(error.stderr ?? ""));
    throw failure;
  }
}

export function services(cwd = process.cwd(), cacheDirectory = null) {
  const git = (args) => command("git", args, { cwd }).trim();
  const gh = (args) => command("gh", args, { cwd });
  const api = (path, body, method = body === undefined ? "GET" : "POST") => {
    const args = ["api", path];
    if (body !== undefined) args.push("--method", method, "--input", "-");
    return JSON.parse(command("gh", args, { cwd, ...(body === undefined ? {} : { input: JSON.stringify(body) }) }));
  };
  const optional = (path) => { try { return api(path); } catch (error) { if (error.notFound) return null; throw error; } };
  const pages = (path, key = null) => {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const records = key ? data[key] : data;
      check(Array.isArray(records), "Incomplete GitHub pagination");
      result.push(...records);
      if (key && result.length === data.total_count) return result;
      if (!key && records.length < 100) return result;
      check(records.length > 0, "Incomplete GitHub pagination");
    }
    throw new Error("GitHub pagination exceeded its bound");
  };
  return { cwd, git, gh, api, optional, pages,
    run: (program, args, options) => command(program, args, { cwd, ...options }),
    notes: (state) => command("git", ["show", `${state.headSha}:${state.notesPath}`], { cwd }),
    verify: (state, release) => verifyPublishedAssets(state, release, { cwd, git, api, pages, cacheDirectory }),
    gates: (state) => verifyReleaseJobs(state, pages(`repos/${state.repository}/actions/runs/${state.runId}/jobs?filter=latest`, "jobs")),
    timings: (state) => readReleaseTimings(state.repository, state.runId, (args) => JSON.parse(gh(args))),
  };
}

/** Version edits are constrained to the seven known files; interrupted edits accept old or new. */
export function bumpVersions(files, oldVersion, version) {
  check(VERSION.test(version) && VERSION.test(oldVersion), "Only stable semantic versions are supported");
  const result = {};
  for (const path of VERSION_FILES) {
    const text = files[path];
    check(typeof text === "string", `Missing version source ${path}`);
    if (path.endsWith(".json")) {
      const value = JSON.parse(text);
      check([oldVersion, version].includes(value.version), `Unexpected version in ${path}`);
      value.version = version;
      result[path] = JSON.stringify(value, null, 2) + "\n";
    } else {
      const pattern = path.endsWith("Cargo.lock") ? /(\[\[package\]\]\r?\nname = "wollipog-desktop"\r?\nversion = ")([^"]+)(")/g
        : path.endsWith("Cargo.toml") ? /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/g
          : path.endsWith("release-version.ts") ? /(export const APP_RELEASE_VERSION = ")([^"]+)(")/g
            : /(export const VERSION = ")([^"]+)(")/g;
      let count = 0;
      result[path] = text.replace(pattern, (_, before, current, after) => {
        check([oldVersion, version].includes(current), `Unexpected version in ${path}`);
        count++; return before + version + after;
      });
      check(count === 1, `Ambiguous version source ${path}`);
    }
  }
  return result;
}

/** Prepare an isolated branch and draft PR. Review and enqueue remain explicit operator gates. */
export function prepare(version, checkpoint, io = services()) {
  check(VERSION.test(version ?? ""), "Expected --version X.Y.Z (stable releases only)");
  const branch = io.git(["branch", "--show-current"]);
  check(branch && branch !== "main", "Prepare a release in a dedicated worktree branch");
  check(io.git(["rev-parse", "--path-format=absolute", "--git-dir"]) !==
    io.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "The primary checkout must not be used for release preparation");
  const repo = JSON.parse(io.gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]));
  check(repo.defaultBranchRef?.name === "main", "Expected the protected main release branch");
  const origin = io.git(["remote", "get-url", "origin"]);
  check([`git@github.com:${repo.nameWithOwner}.git`, `https://github.com/${repo.nameWithOwner}.git`, `https://github.com/${repo.nameWithOwner}`].includes(origin), "Origin must identify the release repository without embedded credentials");
  const notes = notesPath(version);
  const notesBytes = readFileSync(join(io.cwd, notes));
  check(notesBytes.length > 0 && notesBytes.at(-1) === 10, "Release notes must be nonempty and end with a newline");
  const rootPackage = JSON.parse(readFileSync(join(io.cwd, "package.json"), "utf8"));
  const state = existsSync(checkpoint) ? validateCheckpoint(JSON.parse(readFileSync(checkpoint, "utf8"))) : {
    schema: 1, repository: repo.nameWithOwner, version, tag: `v${version}`, branch,
    notesPath: notes, notesSha256: digest(notesBytes), baseSha: io.git(["rev-parse", "HEAD"]),
    oldVersion: rootPackage.version, stage: "preparing",
  };
  check(state.repository === repo.nameWithOwner && state.branch === branch && state.version === version && state.notesSha256 === digest(notesBytes), "Preparation differs from checkpoint intent");
  const allowed = new Set([...VERSION_FILES, notes]);
  const tracked = io.git(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const staged = io.git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const untracked = io.git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  check([...tracked, ...staged, ...untracked].every((file) => allowed.has(file)), "Unrelated working-tree changes prevent release preparation");
  const baseline = Object.fromEntries(VERSION_FILES.map((file) => [file, io.run("git", ["show", `${state.baseSha}:${file}`])]));
  check(JSON.parse(baseline["package.json"]).version === state.oldVersion, "Preparation base version differs from checkpoint");
  const intended = bumpVersions(baseline, state.oldVersion, version);
  for (const file of VERSION_FILES) {
    const current = readFileSync(join(io.cwd, file), "utf8");
    check(current === baseline[file] || current === intended[file], `Unrelated edits within ${file} prevent release preparation`);
    if (staged.includes(file)) {
      let indexed;
      try { indexed = io.run("git", ["show", `:${file}`]); }
      catch { throw new Error(`Cannot read staged ${file}; restore or unstage it before preparation`); }
      check(indexed === baseline[file] || indexed === intended[file], `Unrelated staged edits within ${file} prevent release preparation`);
    }
  }
  saveCheckpoint(checkpoint, state);
  const head = io.git(["rev-parse", "HEAD"]);
  if (!state.headSha && head === state.baseSha) {
    const originals = Object.fromEntries(VERSION_FILES.map((file) => [file, readFileSync(join(io.cwd, file), "utf8")]));
    const edits = bumpVersions(originals, state.oldVersion, version);
    for (const [file, text] of Object.entries(edits)) writeFileSync(join(io.cwd, file), text);
    io.run("pnpm", ["typecheck"], { timeout: 20 * 60_000, stdio: "inherit" });
    io.run("pnpm", ["test"], { timeout: 20 * 60_000, stdio: "inherit" });
    io.git(["add", "--", ...allowed]);
    io.git(["commit", "-m", `Prepare Wollipog v${version}`, "--only", "--", ...allowed]);
  }
  const preparedHead = io.git(["rev-parse", "HEAD"]);
  check(preparedHead !== state.baseSha && (!state.headSha || state.headSha === preparedHead), "Prepared head changed unexpectedly");
  const changed = io.git(["diff", "--name-only", state.baseSha, preparedHead]).split("\n").filter(Boolean);
  check(changed.length > 0 && changed.every((file) => allowed.has(file)), "Preparation commit includes unrelated changes");
  // Validate the exact committed files, also recovering a crash between commit and checkpoint.
  const committed = Object.fromEntries(VERSION_FILES.map((file) => [file, io.git(["show", `${preparedHead}:${file}`]) + "\n"]));
  bumpVersions(committed, version, version);
  check(digest(io.run("git", ["show", `${preparedHead}:${notes}`])) === state.notesSha256, "Committed release notes differ");
  check(io.git(["status", "--porcelain"]) === "", "Preparation must leave a clean worktree");
  state.headSha = preparedHead; state.stage = "prepared"; saveCheckpoint(checkpoint, state);
  io.git(["-c", "core.sshCommand=ssh -o ConnectTimeout=20 -o ConnectionAttempts=1 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o BatchMode=yes", "push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  const matches = JSON.parse(io.gh(["pr", "list", "--repo", state.repository, "--head", branch, "--state", "all", "--json", "number,headRefOid,baseRefName"]));
  check(matches.length <= 1, "Multiple release pull requests need operator reconciliation");
  if (matches.length === 0) io.gh(["pr", "create", "--repo", state.repository, "--head", branch, "--base", "main", "--draft", "--title", `Release Wollipog v${version}`, "--body", `Prepare v${version}; release notes: ${notes}. Publication follows review, required CI, and actual merge-group success.`]);
  const pr = JSON.parse(io.gh(["pr", "view", branch, "--repo", state.repository, "--json", "number,headRefOid,baseRefName"]));
  check(pr.headRefOid === state.headSha && pr.baseRefName === "main", "Release PR identity mismatch");
  state.prNumber = pr.number; state.stage = "review"; saveCheckpoint(checkpoint, state);
  return state;
}

export const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){nameWithOwner pullRequest(number:$number){number state isDraft headRefOid headRefName baseRefName headRepository{nameWithOwner} mergeCommit{oid} mergeQueueEntry{state position headCommit{oid}}}}}`;

/** Main may legitimately change dependency-bearing files while a version PR waits in the queue. */
export function verifyMergedPreparation(state, io) {
  const files = Object.fromEntries(VERSION_FILES.map((file) => [file, io.run("git", ["show", `${state.mergeSha}:${file}`])]));
  try { bumpVersions(files, state.version, state.version); }
  catch { throw new Error("Merged release versions differ from the reviewed preparation"); }
  check(digest(io.run("git", ["show", `${state.mergeSha}:${state.notesPath}`])) === state.notesSha256,
    "Merged release notes differ from the reviewed preparation");
}

/** Publication gates depend on job identity and success, independently of timing availability. */
export function verifyReleaseJobs(state, jobs) {
  for (const name of [...NATIVE_RELEASE_JOBS, FINALIZER_JOB]) {
    const matches = jobs.filter((job) => job.name === name);
    check(matches.length === 1, `Missing or ambiguous required release job: ${name}`);
    const job = matches[0];
    check(job.run_id === state.runId && job.head_sha === state.mergeSha && positive(job.run_attempt) &&
      job.run_attempt <= state.runAttempt && job.status === "completed" && job.conclusion === "success",
    `Required release job has not succeeded: ${name}`);
  }
}

function verifyTag(state, ref, io) {
  let object = ref?.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    check(SHA.test(object.sha ?? ""), "Malformed annotated tag identity");
    object = io.api(`repos/${state.repository}/git/tags/${object.sha}`).object;
  }
  check(object?.type === "commit" && object.sha === state.mergeSha, "Existing tag identifies a different commit; it will not be moved");
}

function stableOrder(left, right) {
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return 1; if (a[i] < b[i]) return -1; }
  return 0;
}

/** One reconciled step. Cached stages never grant authority or replace fresh forge evidence. */
export function advance(state, grants, io, save = () => {}) {
  validateCheckpoint(state);
  check(positive(state.prNumber) && SHA.test(state.headSha ?? ""), "Finish preparation before resuming");
  const [owner, repo] = state.repository.split("/");
  const data = io.api("graphql", { query: PR_QUERY, variables: { owner, repo, number: state.prNumber } });
  check(!data.errors?.length && data.data?.repository?.nameWithOwner === state.repository, "Incomplete pull request evidence");
  const pr = data.data.repository.pullRequest;
  check(pr?.number === state.prNumber && pr.headRepository?.nameWithOwner === state.repository && pr.headRefName === state.branch && pr.headRefOid === state.headSha && pr.baseRefName === "main", "Release PR no longer matches its checkpoint");
  const finish = (stage, extra = {}) => { state.stage = stage; save(state); return { stage, ...extra }; };
  if (pr.state !== "MERGED") {
    check(pr.state === "OPEN", "Release PR was closed without merging");
    const integration = pr.mergeQueueEntry?.headCommit?.oid ?? null;
    check(integration === null || SHA.test(integration), "Invalid queue integration");
    if (state.integrationSha !== integration) {
      state.integrationHistory = [...(state.integrationHistory ?? []), { sha: integration, observedAt: new Date().toISOString() }];
      state.integrationSha = integration;
    }
    if (pr.mergeQueueEntry) return finish("merge-queue", { waiting: true, integrationSha: integration, queueState: pr.mergeQueueEntry.state, position: pr.mergeQueueEntry.position });
    const url = `https://github.com/${state.repository}/pull/${state.prNumber}`;
    return finish(pr.isDraft ? "review" : "enqueue-approval", {
      waiting: false, pullRequest: url,
      action: pr.isDraft ? "Complete cross-model review, then mark the exact reviewed head ready and wait for required CI."
        : `Verify review and required CI on ${state.headSha}, obtain the merge approval, then run: gh pr merge ${url} --squash --match-head-commit ${state.headSha}`,
    });
  }
  check(SHA.test(pr.mergeCommit?.oid ?? ""), "Merged PR has no verified merge commit");
  check(!state.mergeSha || state.mergeSha === pr.mergeCommit.oid, "Merged release identity changed");
  state.mergeSha = pr.mergeCommit.oid;
  const comparison = io.api(`repos/${state.repository}/compare/${state.mergeSha}...main`);
  check(["ahead", "identical"].includes(comparison.status), "Release merge is not reachable from main");
  io.git(["fetch", "origin", "main"]);
  verifyMergedPreparation(state, io);
  const ref = io.optional(`repos/${state.repository}/git/ref/tags/${state.tag}`);
  if (!ref) {
    if (grants.reviewedHead !== state.headSha || !grants.allowTag) return finish("tag-approval", { action: "Supply the reviewed head and explicit --allow-tag authority." });
    // The API creates only an absent ref; it cannot force-update an existing tag.
    io.api(`repos/${state.repository}/git/refs`, { ref: `refs/tags/${state.tag}`, sha: state.mergeSha });
    return finish("tag-created", { waiting: true });
  }
  verifyTag(state, ref, io);
  const runs = io.pages(`repos/${state.repository}/actions/workflows/release.yml/runs?head_sha=${state.mergeSha}`, "workflow_runs")
    .filter((run) => run.head_sha === state.mergeSha && run.head_branch === state.tag && ["push", "workflow_dispatch"].includes(run.event));
  check(runs.length <= 1, "Multiple tag workflows require operator reconciliation");
  if (!runs.length) return finish("await-release-workflow", { waiting: true, action: "No tag-push workflow found yet; check workflow admission if this persists." });
  const run = io.api(`repos/${state.repository}/actions/runs/${runs[0].id}`);
  check(run.path === ".github/workflows/release.yml" && run.repository?.full_name === state.repository && run.head_sha === state.mergeSha && run.head_branch === state.tag && run.event === "push", "Release workflow identity mismatch");
  check(!state.runId || state.runId === run.id, "Release workflow changed; reconcile before continuing");
  check(positive(run.id) && positive(run.run_attempt), "Invalid release run identity");
  state.runId = run.id; state.runAttempt = run.run_attempt;
  if (run.status !== "completed") return finish("native-builds-and-verification", { waiting: true, runId: run.id, attempt: run.run_attempt });
  check(run.conclusion === "success", "Release workflow did not succeed; inspect the exact attempt before retrying");
  io.gates(state);
  try {
    const timings = io.timings(state);
    check(timings.runId === state.runId && timings.attempt === state.runAttempt && timings.headSha === state.mergeSha,
      "Timing attempt changed");
    state.timings = timings;
  } catch {
    state.timings = { runId: state.runId, attempt: state.runAttempt, status: "unmeasured", reason: "timing-metadata-unavailable" };
  }
  const releases = io.pages(`repos/${state.repository}/releases`).filter((release) => release.tag_name === state.tag);
  check(releases.length === 1 && positive(releases[0].id), "Expected exactly one release for the intended tag");
  check(!state.releaseId || state.releaseId === releases[0].id, "Release ID changed");
  state.releaseId = releases[0].id;
  const release = io.api(`repos/${state.repository}/releases/${state.releaseId}`);
  check(release.tag_name === state.tag && release.id === state.releaseId && release.prerelease === false, "Release metadata identity mismatch");
  const notes = io.notes(state);
  check(digest(notes) === state.notesSha256, "Release notes differ from the reviewed snapshot");
  // Verify fresh hosted bytes using the helpers from the exact merged release commit.
  const recheckAssets = io.verify(state, release);
  if (release.draft) {
    if (grants.reviewedHead !== state.headSha || !grants.allowPublish) return finish("publish-approval", { action: "Supply the reviewed head and explicit --allow-publish authority." });
    save(state); // Bind immutable IDs before the mutation; reconcile after a crash, never replay blindly.
    const currentRun = io.api(`repos/${state.repository}/actions/runs/${state.runId}`);
    check(currentRun.status === "completed" && currentRun.conclusion === "success" &&
      currentRun.run_attempt === state.runAttempt && currentRun.head_sha === state.mergeSha,
    "Release attempt changed before publication");
    const currentRelease = io.api(`repos/${state.repository}/releases/${state.releaseId}`);
    check(currentRelease.id === state.releaseId && currentRelease.tag_name === state.tag && !currentRelease.prerelease,
      "Release identity changed before publication");
    if (!currentRelease.draft) return finish("publication-requested", { waiting: true });
    verifyTag(state, io.optional(`repos/${state.repository}/git/ref/tags/${state.tag}`), io);
    const previousStable = io.optional(`repos/${state.repository}/releases/latest`);
    if (previousStable && previousStable.id !== state.releaseId) {
      const previousVersion = previousStable.tag_name?.replace(/^v/, "");
      check(VERSION.test(previousVersion ?? "") && stableOrder(state.version, previousVersion) > 0,
        "A newer or unrecognised stable release exists; automatic latest promotion is refused");
    }
    recheckAssets();
    io.api(`repos/${state.repository}/releases/${state.releaseId}`, {
      tag_name: state.tag, target_commitish: state.mergeSha, name: `Wollipog ${state.tag}`,
      body: notes, prerelease: false, draft: false, make_latest: "true",
    }, "PATCH");
    return finish("publication-requested", { waiting: true });
  }
  check(release.body === notes && release.name === `Wollipog ${state.tag}` && release.published_at && release.html_url === `https://github.com/${state.repository}/releases/tag/${state.tag}`, "Published release does not match the reviewed metadata");
  const latest = io.api(`repos/${state.repository}/releases/latest`);
  check(latest.id === state.releaseId && latest.tag_name === state.tag, "Published release is not the latest stable release; no automatic promotion will be attempted");
  recheckAssets();
  return finish("published", { url: release.html_url, commit: state.mergeSha, runId: state.runId });
}

/** Download exact asset IDs, verify publisher hashes and signatures, execute only merged helpers. */
export function verifyPublishedAssets(state, release, io) {
  const execute = io.execute ?? command;
  const directory = mkdtempSync(join(tmpdir(), "wollipog-release-verify-"));
  try {
    const archive = execute("git", ["archive", state.mergeSha, "scripts", "apps/runner/scripts"], { cwd: io.cwd, encoding: null });
    execute("tar", ["-x", "-C", directory], { input: archive, encoding: null });
    const assets = io.pages(`repos/${state.repository}/releases/${release.id}/assets`);
    const inventory = (values) => JSON.stringify(values.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((a, b) => a.name.localeCompare(b.name)));
    const verifiedInventory = inventory(assets);
    check(assets.length > 0 && new Set(assets.map((asset) => asset.name)).size === assets.length, "Empty or ambiguous release assets");
    const assetDirectory = join(directory, "assets"); mkdirSync(assetDirectory);
    for (const asset of assets) {
      check(positive(asset.id) && /^[A-Za-z0-9_.+-]+$/.test(asset.name) && ![".", ".."].includes(asset.name) && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""), "Invalid hosted release asset metadata");
      // Only manifests and update packages/signatures need their bytes rechecked here. The
      // merged hosted verifier checks the exhaustive remaining names, digests and alias pairs.
      if (!["SHA256SUMS", "latest.json"].includes(asset.name) && !/\.(sig|AppImage|msi|deb|rpm)$|\.app\.tar\.gz$|-setup\.exe$/.test(asset.name)) continue;
      const cached = io.cacheDirectory && join(io.cacheDirectory, asset.digest.slice(7));
      if (io.cacheDirectory) mkdirSync(io.cacheDirectory, { recursive: true, mode: 0o700 });
      check(!cached || !entry(cached)?.isSymbolicLink(), "Asset cache must not contain symlinks");
      let bytes = cached && entry(cached)?.isFile() ? readFileSync(cached) : null;
      if (!bytes || bytes.length !== asset.size || `sha256:${digest(bytes)}` !== asset.digest)
        bytes = execute("gh", ["api", `repos/${state.repository}/releases/assets/${asset.id}`, "--header", "Accept: application/octet-stream"], { encoding: null, maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60_000 });
      check(bytes.length === asset.size && `sha256:${digest(bytes)}` === asset.digest, "Downloaded release asset differs from publisher metadata");
      if (cached) {
        check(!entry(cached)?.isSymbolicLink(), "Asset cache must not contain symlinks");
        writeFileSync(cached, bytes, { mode: 0o600 });
      }
      writeFileSync(join(assetDirectory, asset.name), bytes);
    }
    const manifest = join(assetDirectory, "latest.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    check(parsed.version === state.version, "Updater announces the wrong version");
    const key = io.api(`repos/${state.repository}/actions/variables/TAURI_UPDATER_PUBLIC_KEY`).value;
    check(typeof key === "string" && key.length > 0, "Updater public key is unavailable");
    const expected = join(directory, "verified-latest.json");
    execute("node", [join(directory, "scripts/desktop-update-manifest.mjs"), "build", "--assets-dir", assetDirectory,
      "--version", state.version, "--repo", state.repository, "--tag", state.tag, "--output", expected],
    { env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: key } });
    const rebuilt = JSON.parse(readFileSync(expected, "utf8"));
    // pub_date is generated at build time; signed platform identities and URL/signature values
    // must be exact. The published manifest's exact bytes are separately bound to its digest.
    check(JSON.stringify(rebuilt.platforms) === JSON.stringify(parsed.platforms), "Updater URLs or signatures differ from verified packages");
    const metadata = join(directory, "assets.json"); writeFileSync(metadata, JSON.stringify([assets]));
    execute("node", [join(directory, "scripts/verify-runner-release-assets.mjs"), "release", "--assets-json", metadata,
      "--manifest", join(assetDirectory, "SHA256SUMS"), "--update-manifest", manifest, "--desktop-version", state.version]);
    return () => {
      check(inventory(io.pages(`repos/${state.repository}/releases/${release.id}/assets`)) === verifiedInventory,
        "Hosted assets changed after verification");
      check(io.api(`repos/${state.repository}/actions/variables/TAURI_UPDATER_PUBLIC_KEY`).value === key,
        "Updater public key changed after verification");
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function acquireCheckpointLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = path + ".lock";
  // Every acquirer serializes the stale-read/unlink/create sequence, including first acquisition.
  // A crash in this short critical section leaves recovery guarded for operator inspection.
  let guard;
  try { guard = openSync(lockPath + ".recovery", "wx", 0o600); }
  catch { throw new Error("Checkpoint lock recovery may be active; inspect the recovery guard before retrying"); }
  try {
    writeFileSync(guard, String(process.pid));
    if (entry(lockPath)) {
      check(!entry(lockPath).isSymbolicLink(), "Checkpoint lock must not be a symlink");
      const pid = Number(readFileSync(lockPath, "utf8"));
      check(positive(pid), "Malformed checkpoint lock needs operator inspection");
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      check(!alive, "Another release process may own this checkpoint");
      unlinkSync(lockPath);
    }
    const fd = openSync(lockPath, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  } finally {
    closeSync(guard); unlinkSync(lockPath + ".recovery");
  }
  return () => unlinkSync(lockPath);
}

export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    state: { type: "string" }, version: { type: "string" }, "reviewed-head": { type: "string" },
    "allow-tag": { type: "boolean" }, "allow-publish": { type: "boolean" }, watch: { type: "boolean" },
    "timeout-seconds": { type: "string", default: "21600" },
  } });
  check(positionals.length === 1 && ["prepare", "resume", "status"].includes(positionals[0]) && values.state, "Usage: node scripts/release.mjs prepare|resume|status --state /persistent/path.json [--version X.Y.Z] [--reviewed-head SHA --allow-tag --allow-publish --watch]");
  const checkpoint = resolve(values.state);
  const io = services(process.cwd(), checkpoint + ".assets");
  const root = io.git(["rev-parse", "--show-toplevel"]);
  const location = relative(root, checkpoint);
  check(isAbsolute(location) || location === ".." || location.startsWith(".." + (process.platform === "win32" ? "\\" : "/")), "Keep release checkpoints outside the repository");
  const unlock = acquireCheckpointLock(checkpoint);
  try {
    if (positionals[0] === "prepare") { console.log(JSON.stringify(prepare(values.version, checkpoint, io))); return; }
    const state = validateCheckpoint(JSON.parse(readFileSync(checkpoint, "utf8")));
    const remoteRepo = JSON.parse(io.gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
    check(remoteRepo === state.repository, "Checkpoint belongs to another repository");
    const timeout = Number(values["timeout-seconds"]);
    check(Number.isFinite(timeout) && timeout > 0 && timeout <= 86400, "Timeout must be between 1 and 86400 seconds");
    const deadline = Date.now() + timeout * 1000;
    const grants = positionals[0] === "status" ? {} : { reviewedHead: values["reviewed-head"], allowTag: values["allow-tag"], allowPublish: values["allow-publish"] };
    let last;
    do {
      const result = advance(state, grants, io, (next) => saveCheckpoint(checkpoint, next));
      const encoded = JSON.stringify(result);
      if (encoded !== last) console.log(encoded);
      last = encoded;
      if (!values.watch || !result.waiting || Date.now() + 30_000 > deadline) return;
      await sleep(30_000);
    } while (Date.now() < deadline);
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
