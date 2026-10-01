/**
 * Import from Git (#1983): the source fields' rules, the review rows' copy and the primary's label.
 * Pure, so they unit-test with `node:test`; `SkillGitImportDialog` renders them.
 *
 * The field rules mirror `parseSkillGitSource` in the control plane, so an address it would refuse
 * is caught when the person leaves the field. The server's check stays authoritative: a refusal it
 * returns is mapped back onto the same field by `gitSourceFieldError`.
 */
import { isSkillScriptFile } from "@wollipog/protocol";
import { skillVersionLabel, type SkillGitAutoUpdate, type SkillGitPreview, type SkillVersionSummary } from "./skills.js";

export type SkillGitCandidate = SkillGitPreview["candidates"][number];
export type SkillGitField = "url" | "ref" | "folder";

export const GIT_REPOSITORY_REQUIRED = "Enter a repository, such as org/skills or an HTTPS or SSH address.";
export const GIT_REPOSITORY_CREDENTIALS = "Remove the password from the address, or use an SSH address such as git@host:org/repo.git.";
export const GIT_REPOSITORY_FORMAT = "Use an HTTPS or SSH address, or owner/repository.";
export const GIT_REF_FORMAT = "Use a branch or tag name, such as main or v1.2.";
export const GIT_FOLDER_FORMAT = "Use a folder inside the repository, such as skills, without a leading slash or “..”.";
export const GIT_FOLDER_TOO_MANY = "More than 32 skills are in this folder. Choose a folder that holds fewer.";

/** The Repository field's error, or null when the server would accept it (`parseSkillGitSource`). */
export function gitRepositoryError(value: string): string | null {
  let remote = value.trim();
  if (!remote) return GIT_REPOSITORY_REQUIRED;
  if (remote.length > 2048) return GIT_REPOSITORY_FORMAT;
  if (/^[\w.-]+\/[\w.-]+$/.test(remote)) return null;
  if (/^git@[\w.-]+:[\w./-]+$/.test(remote)) remote = remote.replace(/^git@([^:]+):/, "ssh://git@$1/");
  let url: URL;
  try { url = new URL(remote); } catch { return GIT_REPOSITORY_FORMAT; }
  if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname) return GIT_REPOSITORY_FORMAT;
  // Anything in the user part of an HTTPS address is a credential (a token is often the user
  // name); SSH allows only the git user.
  if (url.password || (url.username && !(url.protocol === "ssh:" && url.username === "git"))) return GIT_REPOSITORY_CREDENTIALS;
  if (url.search || url.hash || /[\x00-\x20\x7f]/.test(remote)) return GIT_REPOSITORY_FORMAT;
  return null;
}

/** The Branch or Tag field's error. Empty means the repository's default branch. Like the
 * server, it takes the value as written: only the address is trimmed. */
export function gitRefError(ref: string): string | null {
  if (!ref) return null;
  return ref.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")
    ? GIT_REF_FORMAT : null;
}

/** The Folder field's error. Empty searches the whole repository. A folder is a literal path, so
 * spaces at either end are part of it, as they are to the server. */
export function gitFolderError(folder: string): string | null {
  if (!folder) return null;
  return folder.length > 512 || folder.startsWith("/") ||
    folder.split("/").some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))
    ? GIT_FOLDER_FORMAT : null;
}

/**
 * A preview the server refused because of one field, as that field's error; null for any other
 * failure, which the dialog shows above its footer. The server's words name Git terms ("ref",
 * "subdirectory"), so each is rewritten; `url` lets the Repository message say what is wrong.
 */
export function gitSourceFieldError(message: string, url: string): { field: SkillGitField; message: string } | null {
  if (/^(A Git repository URL is required|Use an HTTPS or SSH Git URL|Use a credential-free HTTPS URL)/.test(message)) {
    return { field: "url", message: gitRepositoryError(url) ?? (/credential/.test(message) ? GIT_REPOSITORY_CREDENTIALS : GIT_REPOSITORY_FORMAT) };
  }
  if (/^Use a branch, tag, or commit for the Git ref/.test(message)) return { field: "ref", message: GIT_REF_FORMAT };
  if (/^Use a relative repository subdirectory/.test(message)) return { field: "folder", message: GIT_FOLDER_FORMAT };
  if (/^More than 32 skills found/.test(message)) return { field: "folder", message: GIT_FOLDER_TOO_MANY };
  return null;
}

/** A failed preview's sentence for the notice above the footer, without Git's terms. */
export function gitPreviewFailure(message: string): string {
  if (/^Could not read the Git source/.test(message)) {
    return "Wollipog couldn't read the repository. Check the address, the branch or tag, and your access, then try again.";
  }
  const held = /^Could not read held commit ([a-f0-9]+)/.exec(message);
  if (held) return gitHeldCommitFailure(held[1]!);
  return message;
}

/** A held commit the repository no longer serves: a force-push removed it, or the server can't
 * send one commit by its hash. Only the branch's latest commit can be reviewed then. */
export function gitHeldCommitFailure(commit: string): string {
  return `Wollipog couldn't read commit ${shortCommit(commit)}. It may have been removed from the branch, or the server can't send a single commit.`;
}

/**
 * The notice over the review of a held commit when its branch has moved on since the hold: both
 * commits, and that the newer one is a review of its own (`newer`). When the branch's head couldn't
 * be read, it says so instead. Null when the branch is still at the held commit.
 */
export function gitHeldBranchNotice(ref: string, held: string, refCommit: string | null | undefined):
  { title: string; body: string; newer: boolean } | null {
  const named = !ref || ref === "HEAD" ? null : ref;
  if (refCommit === null) {
    return { title: "Couldn't Check for Newer Commits", newer: false,
      body: `Wollipog couldn't read ${named ?? "the default branch"}, so it may have newer commits. This review imports commit ${shortCommit(held)} only.` };
  }
  if (!refCommit || refCommit === held) return null;
  return { title: named ? `Newer Commit on ${named}` : "Newer Commit on the Default Branch", newer: true,
    body: `${named ?? "The default branch"} is now at commit ${shortCommit(refCommit)}. This review imports commit ${shortCommit(held)} only; review the newer commit on its own before importing it.` };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What importing the candidate does, for its row: "New skill", "Updates v3 · 2 assignments" or
 * "Same as the library". `current` is the library's latest version of a skill with that name.
 */
export function gitCandidateConsequence(candidate: SkillGitCandidate, current: SkillVersionSummary | null | undefined): string {
  if (candidate.disposition === "new") return "New skill";
  if (candidate.disposition === "identical") return "Same as the library";
  const version = skillVersionLabel(current);
  return `Updates ${version && !version.mono ? version.text : "the library's version"} · ${plural(candidate.assignmentCount, "assignment")}`;
}

/** "3 files · 1 script": the candidate's size, and how many of its files would be scripts. */
export function gitCandidateCounts(candidate: SkillGitCandidate): string {
  const executable = new Set(candidate.executablePaths);
  const scripts = candidate.files.filter((file) => isSkillScriptFile(file, executable.has(file.path))).length;
  return [plural(candidate.files.length, "file"), scripts ? plural(scripts, "script") : null].filter(Boolean).join(" · ");
}

/** The review step's primary: "Import 2 Skills", or "Import Update" when checking one skill. */
export function gitImportLabel(count: number, checkingUpdates: boolean): string {
  if (checkingUpdates) return count > 1 ? `Import ${count} Updates` : "Import Update";
  return count === 0 ? "Import Skills" : count === 1 ? "Import 1 Skill" : `Import ${count} Skills`;
}

/** The branch the strip and the Up to Date state name; the server records the default as HEAD. */
export function gitRefLabel(ref: string): string {
  return !ref || ref === "HEAD" ? "Default branch" : ref;
}

/** When automatic updates next check, for the Up to Date state; null while they are off. */
export function gitNextCheckText(status: SkillGitAutoUpdate | undefined, now: number): string | null {
  if (status?.enabled !== true) return null;
  if (!status.checkedAt) return "Automatic updates check for the first time soon.";
  const minutes = Math.round((status.checkedAt + (status.intervalMs ?? 60 * 60_000) - now) / 60_000);
  if (minutes <= 1) return "Automatic updates check again within a minute.";
  if (minutes < 90) return `Automatic updates check again in ${minutes} minutes.`;
  return `Automatic updates check again in ${plural(Math.round(minutes / 60), "hour")}.`;
}

/** A commit as the strip shows it (§11.3): the first 12 characters. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}
