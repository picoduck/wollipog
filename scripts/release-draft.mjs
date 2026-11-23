import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, statSync } from "node:fs";
import { basename, join, matchesGlob } from "node:path";

const numericId = (value) => /^[1-9][0-9]*$/u.test(String(value)) && Number.isSafeInteger(Number(value));
const safeAssetName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/u.test(name);
const releaseBody = [
  "Desktop bundles for Wollipog. Each installer includes a control-plane sidecar.",
  "",
  "Tag builds are signed and notarized on macOS and Authenticode signed on Windows. Desktop",
  "updates carry a separate signature that the app verifies before installing them.",
].join("\n");

function ghJson(...args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
}

function list(path) {
  return ghJson("--paginate", "--slurp", path).flat();
}

export function releaseDraft(repo, { tag, commit, prerelease, refType }, read = ghJson, pages = list) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo ?? "") ||
      !/^v[\w.+-]+$/u.test(tag ?? "") ||
      !/^[a-f0-9]{40}$/u.test(commit ?? "") || typeof prerelease !== "boolean" ||
      !["branch", "tag"].includes(refType)) {
    throw new Error("Release repository, tag, commit, ref type, and prerelease state are required");
  }
  const repository = `repos/${repo}`;
  const collection = `${repository}/releases`;

  function assertTagTarget() {
    if (refType !== "tag") return;
    // The commit endpoint resolves both lightweight and annotated tag refs to commits.
    const ref = encodeURIComponent(`refs/tags/${tag}`);
    if (read(`${repository}/commits/${ref}?per_page=1`).sha !== commit) {
      throw new Error(`Tag ${tag} does not resolve to ${commit}`);
    }
  }

  function assertDraft(release) {
    // GitHub ignores target_commitish when the tag already exists.
    if (!numericId(release?.id) || release.tag_name !== tag || release.draft !== true ||
        release.prerelease !== prerelease || (refType === "branch" && release.target_commitish !== commit)) {
      throw new Error(`Release ${release?.id ?? "(unknown)"} is not the expected draft for ${tag} at ${commit}`);
    }
    return release.id;
  }

  return {
    prepare() {
      assertTagTarget();
      const matches = pages(`${collection}?per_page=100`).filter((release) => release.tag_name === tag);
      if (matches.length > 1) throw new Error(`Found multiple releases for ${tag}`);
      if (matches.length === 1) return assertDraft(matches[0]);
      // A lost response fails this attempt. A rerun lists existing drafts before creating one.
      return assertDraft(read(collection, "--method", "POST",
        "-f", `tag_name=${tag}`, "-f", `target_commitish=${commit}`,
        "-f", `name=Wollipog ${tag}`, "-f", `body=${releaseBody}`,
        "-F", "draft=true", "-F", `prerelease=${prerelease}`, "-f", "make_latest=false"));
    },
    assets(id) {
      if (!numericId(id) || String(assertDraft(read(`${collection}/${id}`))) !== String(id)) {
        throw new Error("Release ID does not identify the expected draft");
      }
      assertTagTarget();
      return pages(`${collection}/${id}/assets?per_page=100`);
    },
  };
}

function main([operation, ...args]) {
  const { GITHUB_REPOSITORY: repo, RELEASE_TAG: tag, GITHUB_SHA: commit, GITHUB_REF_TYPE: refType, RELEASE_PRERELEASE } = process.env;
  const prerelease = RELEASE_PRERELEASE === "true" ? true : RELEASE_PRERELEASE === "false" ? false : undefined;
  const draft = releaseDraft(repo, { tag, commit, prerelease, refType });
  if (operation === "prepare") {
    console.log(draft.prepare());
    return;
  }
  if (!["upload", "download"].includes(operation) || !args.length) {
    throw new Error("Usage: release-draft.mjs <prepare|upload files...|download directory patterns...>");
  }
  const id = process.env.RELEASE_ID;
  const assets = draft.assets(id);
  if (operation === "upload") {
    for (const file of args) {
      const name = basename(file);
      if (!safeAssetName(name)) throw new Error(`Invalid asset name: ${name}`);
      const local = statSync(file);
      if (!local.isFile() || local.size <= 0) throw new Error(`Expected a non-empty asset file: ${file}`);
      const existing = assets.filter((asset) => asset.name === name);
      if (existing.length > 1 || (existing.length === 1 && !numericId(existing[0].id))) {
        throw new Error(`Ambiguous asset identity: ${name}`);
      }
      if (existing.length === 1) {
        execFileSync("gh", ["api", `repos/${repo}/releases/assets/${existing[0].id}`, "--method", "DELETE"]);
      }
      const uploaded = ghJson(`https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
        "--method", "POST", "--header", "Content-Type: application/octet-stream", "--input", file);
      if (uploaded.name !== name || uploaded.state !== "uploaded" || uploaded.size !== local.size) {
        throw new Error(`GitHub did not confirm asset upload: ${name}`);
      }
    }
    return;
  }

  const [directory, ...patterns] = args;
  const selected = assets.filter(({ name }) => patterns.some((pattern) => matchesGlob(name, pattern)));
  if (!selected.length) throw new Error("No assets match the requested download");
  for (const { id: assetId, name, size } of selected) {
    if (!safeAssetName(name) || !numericId(assetId)) throw new Error(`Invalid asset identity: ${name}`);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Invalid hosted asset size: ${name}`);
    const file = openSync(join(directory, name), "wx");
    try {
      execFileSync("gh", ["api", `repos/${repo}/releases/assets/${assetId}`, "--header", "Accept: application/octet-stream"],
        { stdio: ["ignore", file, "inherit"] });
      if (fstatSync(file).size !== size) throw new Error(`Downloaded size differs for ${name}`);
    } finally {
      closeSync(file);
    }
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
