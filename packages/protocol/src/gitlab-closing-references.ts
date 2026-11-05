/**
 * GitLab closing-pattern references (#3762).
 *
 * GitLab closes an issue when a merge request lands on the project's default branch and its title,
 * description or a commit message matches the instance's issue closing pattern, whatever the
 * sentence around it says: "This MR does not close #12" closes #12. GitLab's default pattern
 * (https://docs.gitlab.com/user/project/issues/managing_issues/#default-closing-pattern) is
 *
 *   \b((?:[Cc]los(?:e[sd]?|ing)|\b[Ff]ix(?:e[sd]|ing)?|\b[Rr]esolv(?:e[sd]?|ing)|\b[Ii]mplement(?:s|ed|ing)?)(:?) +
 *     (?:(?:issues? +)?%{issue_ref}(?:(?: *,? +and +| *,? *)?)|([A-Z][A-Z0-9_]+-\d+))+)
 *
 * so, unlike GitHub, it also accepts "-ing" forms ("Closing #12"), "Implements", and a list after one
 * keyword ("Closes #11, #12 and group/project#13" closes all three, as does "Closes ABC-1, #12",
 * where an external tracker's key only continues the list). GitLab scans the raw text, so code
 * spans, code blocks and HTML comments hide nothing.
 *
 * This matcher reads the default pattern generously, never more narrowly: any letter case, tabs as
 * well as spaces, and no word boundary after a reference. A false report costs a reworded sentence,
 * while a missed one closes an issue that must stay open. An instance can configure a different
 * pattern, which no client can read, so the merge gate also asks GitLab itself which issues the
 * merge request closes (its `closes_issues` list, which covers the title and commits too) and
 * reports both: where the two disagree, GitLab's own list is what decides.
 *
 * References: `#12` (this project), `project#12` (a project in this project's namespace),
 * `group/sub/project#12`, and an `http(s)` issue or work item URL on this instance. A URL on any
 * other host is not a reference GitLab resolves, and an external tracker's key names no GitLab
 * issue, so neither is reported.
 */
import { campaignRepositoryLocation } from "./campaign-work-ledger.js";
import { closingReferenceExcerpt, type ClosingReference } from "./closing-references.js";

const SEGMENT = String.raw`[A-Za-z0-9_][A-Za-z0-9_.-]*`;
const PATH = String.raw`${SEGMENT}(?:\/${SEGMENT})*`;
const NUMBER = String.raw`[0-9]{1,10}`;
const URL = String.raw`https?:\/\/([^\s\/?#]+)\/(${PATH})\/(?:-\/)?(?:issues(?:\/incident)?|work_items)\/(${NUMBER})`;
/** A keyword that starts an ASCII word (so `auto-close` counts and `disclose` does not), an optional
 * colon, then spaces or tabs. */
const KEYWORD = /(?<![A-Za-z0-9_])(clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?):?[ \t]+/giu;
/** One list item: an issue reference, optionally after "issue"/"issues", or an external key. */
const ITEM = new RegExp(String.raw`(?:issues?[ \t]+)?(?:${URL}|(?:(${PATH}))?#(${NUMBER})|[A-Z][A-Z0-9_]+-[0-9]+)`, "iuy");
/** What may join two list items; it may be empty (`#11#12`). */
const SEPARATOR = /(?:[ \t]*,?[ \t]+and[ \t]+|[ \t]*,?[ \t]*)/iuy;
const REFERENCE = new RegExp(String.raw`^(?:${URL}|(?:(${PATH}))?#(${NUMBER}))$`, "iu");

type GitLabProject = { host: string; project: string };

function gitlabProject(repository: string): GitLabProject | null {
  const location = campaignRepositoryLocation(repository);
  return location?.forge === "gitlab" ? { host: location.host.toLowerCase(), project: location.project } : null;
}

/** `host/path#N`, lowercased, or null when it names no GitLab issue. */
function issue(host: string, path: string, number: string): string | null {
  const value = Number(number);
  const repository = `${host}/${path}`.toLowerCase();
  return Number.isSafeInteger(value) && value > 0 && campaignRepositoryLocation(repository)?.forge === "gitlab"
    ? `${repository}#${value}` : null;
}

/** The issue a matched reference names in `base`'s instance. `groups` are a URL's host, path and
 * number, then a plain reference's path and number. */
function resolve(base: GitLabProject, groups: ReadonlyArray<string | undefined>): string | null {
  const [urlHost, urlPath, urlNumber, path, number] = groups;
  if (urlNumber !== undefined) return urlHost!.toLowerCase() === base.host ? issue(base.host, urlPath!, urlNumber) : null;
  if (number === undefined) return null;
  if (!path) return issue(base.host, base.project, number);
  // A path without a slash is a project in this project's namespace, as GitLab resolves it.
  return issue(base.host, path.includes("/") ? path : `${base.project.slice(0, base.project.lastIndexOf("/"))}/${path}`, number);
}

/** `host/group/project#N` for `#N`, `project#N` or `group/project#N` (in `repository`'s instance),
 * `host/group/project#N`, or an issue URL on that instance; else null. `repository` is a GitLab
 * project named by its host and full namespace. */
export function canonicalGitLabIssueReference(value: string, repository: string): string | null {
  const base = gitlabProject(repository);
  if (!base) return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith(`${base.host}/`)) {
    const qualified = new RegExp(String.raw`^(${PATH})#(${NUMBER})$`, "u").exec(trimmed.slice(base.host.length + 1));
    return qualified && qualified[1]!.includes("/") ? issue(base.host, qualified[1]!, qualified[2]!) : null;
  }
  const match = REFERENCE.exec(trimmed);
  return match ? resolve(base, match.slice(1)) : null;
}

/** Every closing reference GitLab's default pattern finds in `text`, in order, each with the line
 * it is on. `repository` is the merge request's GitLab project, named by host and full namespace. */
export function findGitLabClosingReferences(text: string, repository: string): ClosingReference[] {
  const base = gitlabProject(repository);
  if (!base) throw new Error("repository must be a GitLab project named by host and namespace");
  const found = new Map<string, ClosingReference>();
  for (const match of text.matchAll(KEYWORD)) {
    let at = match.index + match[0].length;
    for (;;) {
      ITEM.lastIndex = at;
      const item = ITEM.exec(text);
      if (!item) break;
      const end = item.index + item[0].length;
      const named = resolve(base, item.slice(1));
      if (named && !found.has(`${match.index}:${named}`)) {
        found.set(`${match.index}:${named}`, { issue: named, keyword: match[1]!, index: match.index,
          excerpt: closingReferenceExcerpt(text, match.index, end) });
      }
      SEPARATOR.lastIndex = end;
      SEPARATOR.exec(text);
      at = SEPARATOR.lastIndex;
    }
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}
