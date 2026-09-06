import { validateQuestionAnswers, type AgentQuestion, type GovernancePolicy, type SessionView } from "@wollipog/protocol";
import { scopePatternMatches } from "./policy-engine.js";

export function canMutateQuestionPolicy(existing: GovernancePolicy | undefined, incoming: Pick<GovernancePolicy, "questionRule" | "ownerUserId"> | undefined, humanUserId: string | undefined): boolean {
  if (!existing?.questionRule && !incoming?.questionRule) return true;
  return !!humanUserId && (!existing?.questionRule || existing.ownerUserId === humanUserId) &&
    (!incoming?.questionRule || incoming.ownerUserId === humanUserId);
}

/** Literal segments avoid regex backtracking for adversarial near-misses. */
export function questionPatternMatches(value: string | undefined, pattern: string): boolean {
  if (value === undefined || value.length > 32768) return false;
  value = value.toLowerCase();
  const segments = pattern.toLowerCase().split("*");
  if (segments.length === 1) return value === segments[0];
  const first = segments.shift()!;
  const last = segments.pop()!;
  if (!value.startsWith(first) || !value.endsWith(last) || first.length + last.length > value.length) return false;
  let cursor = first.length;
  const end = value.length - last.length;
  for (const segment of segments) {
    const index = value.indexOf(segment, cursor);
    if (index < 0 || index + segment.length > end) return false;
    cursor = index + segment.length;
  }
  return true;
}

/** Resolve the entire form or leave it to a person. Never manufacture an answer for an
 * unmatched sibling, secret field, or provider form that rejects the configured response. */
export function questionPolicyAnswers(
  questions: AgentQuestion[], policies: GovernancePolicy[],
  owner: { userId: string; organizationId: string } | null, session: SessionView,
): { answers: Record<string, string | string[]>; policies: GovernancePolicy[] } | null {
  if (!owner || !questions.length || questions.some((q) => q.secret)) return null;
  const eligible = policies.filter((p) => p.enabled && p.effect === "allow" && p.questionRule && p.ownerUserId === owner.userId &&
    Object.entries(p.scope).every(([key, pattern]) => scopePatternMatches(
      key === "organizationId" ? owner.organizationId : key === "runnerId" ? session.runnerId :
        key === "workspaceId" ? session.workspaceId ?? undefined : key === "agentId" ? session.agentId ?? undefined : undefined,
      pattern,
    ))).sort((a, b) => b.priority - a.priority || a.policyId.localeCompare(b.policyId));
  const answers: Record<string, string | string[]> = Object.create(null);
  const used: GovernancePolicy[] = [];
  const formText = JSON.stringify(questions).toLowerCase();
  for (const question of questions) {
    const policy = eligible.find((p) => {
      const rule = p.questionRule!;
      if (rule.starterCategory) {
        const patterns = {
          review: ["may i send *diff* for *review?", "may i retry *review*?", "can i send *diff* for *review?", "can i retry *review*?"],
          push: ["may i push *branch*?", "may i open *pull request*?", "can i push *branch*?", "can i open *pull request*?"],
          evidence: ["may i upload *evidence*private*bucket*?", "can i upload *evidence*private*bucket*?"],
        };
        if (!patterns[rule.starterCategory].some((pattern) => questionPatternMatches(question.question, pattern))) return false;
      }
      if (rule.starterCategory && /\b(merg\w*|delet\w*|remov\w*|publish\w*|deploy\w*|releas\w*)\b|\b(file|create|open)\b.{0,32}\bissue\b/.test(formText)) return false;
      return (rule.headerPattern === undefined || questionPatternMatches(question.header, rule.headerPattern)) &&
        (rule.questionPattern === undefined || questionPatternMatches(question.question, rule.questionPattern));
    });
    if (!policy) return null;
    const answer = policy.questionRule!.answer;
    answers[question.id] = "option" in answer
      ? question.multiSelect ? [answer.option] : answer.option
      : answer.text;
    if ("option" in answer && !question.options.some((option) => option.label === answer.option)) return null;
    if ("text" in answer && !question.allowOther) return null;
    if (!used.some((p) => p.policyId === policy.policyId)) used.push(policy);
  }
  if (validateQuestionAnswers(questions, answers, "submit")) return null;
  return { answers, policies: used };
}
