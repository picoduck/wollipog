import type { CampaignIssueScopeSnapshot } from "./index.js";

export function boundedIssueNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 100 && value.every((n) => Number.isSafeInteger(n) && n > 0) && new Set(value).size === value.length;
}

/** Only a leading issue in an explicitly named member checklist is a candidate. Nothing here grants authority. */
export function epicChecklistMembers(body: string, repository: string): number[] {
  if (body.length > 65536) throw new Error("Epic body exceeds the bounded membership inspection limit");
  const members = new Set<number>();
  let memberSection = false;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line);
    if (heading) memberSection = /^(?:units|members|child issues|sub-issues|implementation issues)$/iu.test(heading[1]!.trim());
    if (!memberSection) continue;
    const row = /^\s*[-*]\s+\[[ xX]\]\s+(?:#([1-9][0-9]*)\b|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]*)\b)/u.exec(line);
    if (!row || (row[2] && row[2].toLowerCase() !== repository.toLowerCase())) continue;
    const number = Number(row[1] ?? row[3]);
    if (!Number.isSafeInteger(number)) throw new Error("Epic contains an invalid member issue number");
    members.add(number);
    if (members.size > 99) throw new Error("Epic scope exceeds 100 issues; select a smaller explicit scope");
  }
  return [...members].sort((a, b) => a - b);
}

export function normalizeCampaignIssueScopeSnapshot(input: Record<string, unknown>): CampaignIssueScopeSnapshot | null {
  if (typeof input.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(input.repository) || input.repository.length > 256 ||
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
    explanation: input.explanation, affectedAssignments, activeChildren, affectedDecisions: [...input.affectedDecisions] as string[] };
}
