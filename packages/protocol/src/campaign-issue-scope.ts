import type { CampaignIssueScopeSnapshot } from "./index.js";
import { campaignRepositoryLocation } from "./campaign-work-ledger.js";

export function boundedIssueNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 100 && value.every((n) => Number.isSafeInteger(n) && n > 0) && new Set(value).size === value.length;
}

/** Whether `url` is the exact web address of issue (or pull/merge request) `number` in a campaign
 * repository (#3539). GitHub: `https://github.com/<repository>/issues/<n>` (`/pull/<n>`), exactly.
 * GitLab: `http(s)://<host>/<project>/-/issues/<n>` (`/-/merge_requests/<n>`), with the host (and
 * port) exactly as the repository names it in lower case and the project compared case-insensitively. */
export function campaignIssueForgeUrl(url: unknown, repository: string, kind: "issue" | "change", number: number): boolean {
  const location = campaignRepositoryLocation(repository);
  if (!location || typeof url !== "string" || !Number.isSafeInteger(number) || number < 1) return false;
  if (location.forge === "github") return url === `https://github.com/${repository}/${kind === "issue" ? "issues" : "pull"}/${number}`;
  const match = /^https?:\/\/([^/?#@\s]+)\/([^?#\s]+)\/-\/(issues|merge_requests)\/([1-9][0-9]*)$/u.exec(url);
  return Boolean(match && match[1] === location.host.toLowerCase() && match[2]!.toLowerCase() === location.project.toLowerCase() &&
    match[3] === (kind === "issue" ? "issues" : "merge_requests") && match[4] === String(number));
}

/** Only a leading issue in an explicitly named member checklist is a candidate. Nothing here grants authority.
 * On GitLab (#3539) a member is `#N` or `http(s)://<host>/<project>/-/issues/N` of the same project;
 * GitLab epics, issue links and work-item children are never read. */
export function epicChecklistMembers(body: string, repository: string): number[] {
  if (body.length > 65536) throw new Error("Epic body exceeds the bounded membership inspection limit");
  const location = campaignRepositoryLocation(repository);
  const gitlab = location?.forge === "gitlab" ? location : null;
  const members = new Set<number>();
  let memberSection = false;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line);
    if (heading) memberSection = /^(?:units|members|child issues|sub-issues|implementation issues)$/iu.test(heading[1]!.trim());
    if (!memberSection) continue;
    let number: number;
    if (gitlab) {
      const row = /^\s*[-*]\s+\[[ xX]\]\s+(?:#([1-9][0-9]*)\b|https?:\/\/([^\s/?#@]+)\/([^\s?#]+?)\/-\/issues\/([1-9][0-9]*)\b)/u.exec(line);
      if (!row || (row[2] !== undefined && (row[2].toLowerCase() !== gitlab.host.toLowerCase() || row[3]!.toLowerCase() !== gitlab.project.toLowerCase()))) continue;
      number = Number(row[1] ?? row[4]);
    } else {
      const row = /^\s*[-*]\s+\[[ xX]\]\s+(?:#([1-9][0-9]*)\b|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]*)\b)/u.exec(line);
      if (!row || (row[2] && row[2].toLowerCase() !== repository.toLowerCase())) continue;
      number = Number(row[1] ?? row[3]);
    }
    if (!Number.isSafeInteger(number)) throw new Error("Epic contains an invalid member issue number");
    members.add(number);
    if (members.size > 99) throw new Error("Epic scope exceeds 100 issues; select a smaller explicit scope");
  }
  return [...members].sort((a, b) => a - b);
}

export function normalizeCampaignIssueScopeSnapshot(input: Record<string, unknown>): CampaignIssueScopeSnapshot | null {
  if (!validIssueAdmission(input.issueAdmission) || !validIssueLineage(input.lineage)) return null;
  if (input.verifiedPublications !== undefined && (!Array.isArray(input.verifiedPublications) || input.verifiedPublications.length > 100 ||
      input.verifiedPublications.some((p) => !p || typeof p !== "object" || Object.keys(p).length !== 2 || typeof p.publicationOccurrenceId !== "string" ||
        !p.publicationOccurrenceId || p.publicationOccurrenceId.length > 256 || !Number.isSafeInteger(p.issue) || p.issue < 1 ||
        !Array.isArray(input.additions) || !input.additions.includes(p.issue)) ||
      new Set(input.verifiedPublications.map((p) => p.publicationOccurrenceId)).size !== input.verifiedPublications.length)) return null;
  if (typeof input.repository !== "string" || !campaignRepositoryLocation(input.repository) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 ||
      !boundedIssueNumbers(input.before) || !boundedIssueNumbers(input.additions) || !boundedIssueNumbers(input.removals) ||
      (!input.additions.length && !input.removals.length) ||
      input.additions.some((n) => (input.before as number[]).includes(n)) || input.removals.some((n) => !(input.before as number[]).includes(n)) ||
      input.before.length + input.additions.length - input.removals.length > 100 ||
      typeof input.explanation !== "string" || !input.explanation.trim() || input.explanation.length > 4000 ||
      !Array.isArray(input.affectedAssignments) || input.affectedAssignments.length > 100 ||
      !Array.isArray(input.affectedDecisions) || input.affectedDecisions.length > 1000 ||
      input.affectedDecisions.some((id) => typeof id !== "string" || !id || id.length > 256)) return null;
  const activeChildren: CampaignIssueScopeSnapshot["activeChildren"] = [];
  if (input.activeChildren !== undefined) {
    if (!Array.isArray(input.activeChildren) || input.activeChildren.length > 100) return null;
    for (const raw of input.activeChildren) {
      if (!raw || typeof raw !== "object" || typeof raw.sessionId !== "string" || !raw.sessionId || raw.sessionId.length > 256 ||
          typeof raw.title !== "string" || !raw.title || raw.title.length > 1024 || typeof raw.assignmentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(raw.assignmentDigest)) return null;
      activeChildren.push({sessionId:raw.sessionId,title:raw.title,assignmentDigest:raw.assignmentDigest});
    }
  }
  const affectedAssignments: CampaignIssueScopeSnapshot["affectedAssignments"] = [];
  for (const raw of input.affectedAssignments) {
    if (!raw || typeof raw !== "object" || typeof raw.sessionId !== "string" || !raw.sessionId || raw.sessionId.length > 256 ||
        !Number.isSafeInteger(raw.issue) || raw.issue < 1) return null;
    affectedAssignments.push({ sessionId: raw.sessionId, issue: raw.issue });
  }
  return { category: "campaign_issue_scope", repository: input.repository.toLowerCase(), expectedRevision: input.expectedRevision as number,
    before: [...input.before].sort((a,b) => a-b), additions: [...input.additions].sort((a,b) => a-b), removals: [...input.removals].sort((a,b) => a-b),
    explanation: input.explanation, affectedAssignments, activeChildren, affectedDecisions: [...input.affectedDecisions] as string[],
    ...(input.lineage === undefined ? {} : { lineage: structuredClone(input.lineage) as CampaignIssueScopeSnapshot["lineage"] }),
    ...(input.issueAdmission === undefined ? {} : { issueAdmission: structuredClone(input.issueAdmission) as CampaignIssueScopeSnapshot["issueAdmission"] }),
    ...(input.verifiedPublications === undefined ? {} : { verifiedPublications: structuredClone(input.verifiedPublications) as CampaignIssueScopeSnapshot["verifiedPublications"] }) };
}

export function validIssueAdmission(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const p = v.publicationAuthority as Record<string, unknown> | undefined;
  return Object.keys(v).every((key) => ["boundaryRevision", "evidenceDigest", "publicationAuthority"].includes(key)) &&
    (p === undefined || Boolean(p && typeof p === "object" && Object.keys(p).length === 2 &&
      typeof p.authorizedByUserId === "string" && p.authorizedByUserId.length > 0 && p.authorizedByUserId.length <= 256 &&
      typeof p.objectiveDigest === "string" && /^[0-9a-f]{64}$/u.test(p.objectiveDigest))) &&
    Number.isSafeInteger(v.boundaryRevision) && (v.boundaryRevision as number) > 0 &&
    typeof v.evidenceDigest === "string" && /^[0-9a-f]{64}$/u.test(v.evidenceDigest);
}

export function validIssueLineage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 2 && (v.kind === "epic" && Number.isSafeInteger(v.epic) && (v.epic as number) > 0 ||
    v.kind === "follow_up" && typeof v.publicationOccurrenceId === "string" && v.publicationOccurrenceId.length > 0 && v.publicationOccurrenceId.length <= 256);
}
