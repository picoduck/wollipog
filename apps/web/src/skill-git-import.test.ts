import assert from "node:assert/strict";
import test from "node:test";
import {
  GIT_FOLDER_FORMAT,
  GIT_FOLDER_TOO_MANY,
  GIT_REF_FORMAT,
  GIT_REPOSITORY_CREDENTIALS,
  GIT_REPOSITORY_FORMAT,
  GIT_REPOSITORY_REQUIRED,
  gitCandidateConsequence,
  gitCandidateCounts,
  gitFolderError,
  gitImportLabel,
  gitNextCheckText,
  gitPreviewFailure,
  gitRefError,
  gitRefLabel,
  gitRepositoryError,
  gitSourceFieldError,
  shortCommit,
  type SkillGitCandidate,
} from "./skill-git-import.js";

test("the Repository rule accepts what the server accepts", () => {
  for (const value of [
    "org/skills",
    " org/skills ",
    "https://github.com/org/skills.git",
    "ssh://git@github.com/org/skills.git",
    "git@github.com:org/skills.git",
  ]) assert.equal(gitRepositoryError(value), null, value);
});

test("the Repository rule refuses credentials with the fix, and other shapes with the format", () => {
  assert.equal(gitRepositoryError(""), GIT_REPOSITORY_REQUIRED);
  assert.equal(gitRepositoryError("   "), GIT_REPOSITORY_REQUIRED);
  for (const value of [
    "https://user:secret@github.com/org/skills.git",
    "https://token@github.com/org/skills.git",
    "ssh://deploy@github.com/org/skills.git",
  ]) assert.equal(gitRepositoryError(value), GIT_REPOSITORY_CREDENTIALS, value);
  for (const value of [
    "http://github.com/org/skills.git",
    "file:///tmp/skills",
    "github.com/org/skills",
    "https://github.com/org/skills.git?ref=main",
    "https://github.com/org/skills.git#main",
    "https://github.com/org/my skills.git",
    `https://github.com/${"a".repeat(2048)}`,
  ]) assert.equal(gitRepositoryError(value), GIT_REPOSITORY_FORMAT, value);
});

test("Branch or Tag and Folder follow the server's ref and subdirectory rules", () => {
  for (const value of ["", "main", "v1.2", "release/2026-10", "a".repeat(256)]) assert.equal(gitRefError(value), null, value);
  for (const value of ["-main", "main..dev", "a//b", "main/", "main.lock", "a b", "a".repeat(257)]) {
    assert.equal(gitRefError(value), GIT_REF_FORMAT, value);
  }
  for (const value of ["", "skills", ".agents/skills", "skills/code-review"]) assert.equal(gitFolderError(value), null, value);
  for (const value of ["/skills", "skills/", "a//b", "./skills", "skills/../x", "a\\b", "a".repeat(513)]) {
    assert.equal(gitFolderError(value), GIT_FOLDER_FORMAT, value);
  }
});

test("a server refusal maps back onto its field, rewritten without Git terms", () => {
  assert.deepEqual(gitSourceFieldError("Use a credential-free HTTPS URL or an SSH URL with the git user.", "https://u:p@host/r.git"),
    { field: "url", message: GIT_REPOSITORY_CREDENTIALS });
  // The server's rule is authoritative: a refusal the local rule did not predict still lands on the field.
  assert.deepEqual(gitSourceFieldError("Use a credential-free HTTPS URL or an SSH URL with the git user.", "org/skills"),
    { field: "url", message: GIT_REPOSITORY_CREDENTIALS });
  assert.deepEqual(gitSourceFieldError("Use an HTTPS or SSH Git URL, or owner/repository shorthand.", "org/skills"),
    { field: "url", message: GIT_REPOSITORY_FORMAT });
  assert.deepEqual(gitSourceFieldError("A Git repository URL is required.", ""), { field: "url", message: GIT_REPOSITORY_REQUIRED });
  assert.deepEqual(gitSourceFieldError("Use a branch, tag, or commit for the Git ref.", "org/skills"), { field: "ref", message: GIT_REF_FORMAT });
  assert.deepEqual(gitSourceFieldError("Use a relative repository subdirectory without traversal.", "org/skills"),
    { field: "folder", message: GIT_FOLDER_FORMAT });
  assert.deepEqual(gitSourceFieldError("More than 32 skills found. Choose a narrower subdirectory.", "org/skills"),
    { field: "folder", message: GIT_FOLDER_TOO_MANY });
  assert.equal(gitSourceFieldError("Another import is in progress. Finish or cancel a preview first.", "org/skills"), null);
  assert.match(gitPreviewFailure("Could not read the Git source within its limits. Check the URL, ref, access, and repository size."),
    /^Wollipog couldn't read the repository\./);
  assert.equal(gitPreviewFailure("Another import is in progress."), "Another import is in progress.");
});

const candidate = (overrides: Partial<SkillGitCandidate>): SkillGitCandidate => ({
  name: "code-review", path: "skills/code-review", commit: "a".repeat(40), digest: "d", files: [], previousFiles: [],
  source: { url: "https://github.com/org/skills.git", ref: "HEAD", subdirectory: "" },
  disposition: "new", assignmentCount: 0, executablePaths: [], ...overrides,
});

test("each row says what importing does, and counts files and scripts", () => {
  assert.equal(gitCandidateConsequence(candidate({}), null), "New skill");
  assert.equal(gitCandidateConsequence(candidate({ disposition: "identical" }), { versionNumber: 3 }), "Same as the library");
  assert.equal(gitCandidateConsequence(candidate({ disposition: "update", assignmentCount: 2 }), { versionNumber: 3 }),
    "Updates v3 · 2 assignments");
  assert.equal(gitCandidateConsequence(candidate({ disposition: "update", assignmentCount: 1 }), { digest: "abcdef0123456789" }),
    "Updates the library's version · 1 assignment");
  const file = (path: string, content = "text") => ({ path, encoding: "utf8" as const, content });
  assert.equal(gitCandidateCounts(candidate({ files: [file("SKILL.md")] })), "1 file");
  assert.equal(gitCandidateCounts(candidate({
    files: [file("SKILL.md"), file("scripts/check.sh", "#!/bin/sh\n"), file("bin/tool")],
    executablePaths: ["bin/tool"],
  })), "3 files · 2 scripts");
});

test("the primary names how many it imports, and an update check imports an update", () => {
  assert.equal(gitImportLabel(0, false), "Import Skills");
  assert.equal(gitImportLabel(1, false), "Import 1 Skill");
  assert.equal(gitImportLabel(2, false), "Import 2 Skills");
  assert.equal(gitImportLabel(0, true), "Import Update");
  assert.equal(gitImportLabel(1, true), "Import Update");
  assert.equal(gitImportLabel(2, true), "Import 2 Updates");
});

test("the strip names the default branch and a 12-character commit", () => {
  assert.equal(gitRefLabel(""), "Default branch");
  assert.equal(gitRefLabel("HEAD"), "Default branch");
  assert.equal(gitRefLabel("stable"), "stable");
  assert.equal(shortCommit("0123456789abcdef0123"), "0123456789ab");
});

test("Up to Date names the next automatic check only while automatic updates are on", () => {
  const now = 1_700_000_000_000;
  assert.equal(gitNextCheckText(undefined, now), null);
  assert.equal(gitNextCheckText({ enabled: false }, now), null);
  assert.equal(gitNextCheckText({ enabled: true }, now), "Automatic updates check for the first time soon.");
  assert.equal(gitNextCheckText({ enabled: true, checkedAt: now - 15 * 60_000 }, now), "Automatic updates check again in 45 minutes.");
  assert.equal(gitNextCheckText({ enabled: true, checkedAt: now - 60 * 60_000 }, now), "Automatic updates check again within a minute.");
  assert.equal(gitNextCheckText({ enabled: true, checkedAt: now, intervalMs: 6 * 60 * 60_000 }, now), "Automatic updates check again in 6 hours.");
});
