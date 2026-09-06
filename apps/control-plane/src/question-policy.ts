import { validateQuestionAnswers, type AgentQuestion, type GovernancePolicy, type SessionView } from "@wollipog/protocol";
import { scopePatternMatches } from "./policy-engine.js";

export function canMutateQuestionPolicy(
  existing: GovernancePolicy | undefined,
  incoming: Pick<GovernancePolicy, "questionRule" | "ownerUserId" | "scope"> | undefined,
  humanUserId: string | undefined,
  admin?: { organizationId: string; activeMemberUserIds: readonly string[] },
): boolean {
  if (!existing?.questionRule && !incoming?.questionRule) return true;
  if (!humanUserId) return false;
  if ((!existing?.questionRule || existing.ownerUserId === humanUserId) &&
      (!incoming?.questionRule || incoming.ownerUserId === humanUserId)) return true;
  if (!admin || (incoming && !incoming.questionRule)) return false;
  return [existing, incoming].every((policy) => !policy?.questionRule ||
    (policy.scope?.organizationId === admin.organizationId && !!policy.ownerUserId &&
      admin.activeMemberUserIds.includes(policy.ownerUserId)));
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

type StarterCategory = NonNullable<NonNullable<GovernancePolicy["questionRule"]>["starterCategory"]>;
/** Closed action grammar: no wildcard may consume an additional grant ("and land the PR").
 * Unknown context/option prose asks a human instead of guessing its meaning. */
function starterActionMatches(category: StarterCategory, text: string): boolean {
  if (text.length > 256) return false;
  const normalized = text.toLowerCase().trim().replace(/\.$/, "");
  const actions: Record<StarterCategory, RegExp[]> = {
    review: [
      /^(?:send|share) (?:this|the) (?:pr |pull request )?diff (?:to (?:claude|codex|opus) )?for (?:a |an independent |independent |cross-model )?review$/,
      /^retry (?:this|the|a) (?:cross-model |independent )?review(?: (?:round|attempt)(?: [1-4])?)?$/,
    ],
    push: [
      /^push (?:this|the) branch(?: to (?:origin|github))?$/,
      /^open (?:a|this|the) (?:pr|pull request)(?: for (?:this|the) branch)?$/,
    ],
    evidence: [/^upload (?:this |the )?(?:ui )?evidence to (?:the )?private (?:ui )?evidence bucket$/],
  };
  return actions[category].some((pattern) => pattern.test(normalized));
}

function starterQuestionMatches(category: StarterCategory, question: AgentQuestion): boolean {
  const normalized = question.question.toLowerCase();
  const prefix = /^(?:may|can) i /.exec(normalized)?.[0];
  if (!prefix || !normalized.endsWith("?") || !starterActionMatches(category, normalized.slice(prefix.length, -1))) return false;
  if (question.context?.trim() && !starterActionMatches(category, question.context)) return false;
  const inertDescriptions = new Set(["", "proceed", "continue", "do not proceed", "pause", "pause for now", "wait", "wait for now", "keep waiting", "stop"]);
  return question.options.every((option) => {
    const label = option.label.toLowerCase().replace(/ \(recommended\)$/, "");
    if (!["yes", "no", "proceed", "continue", "cancel", "not yet", "approve", "decline", "allow", "deny", "wait"].includes(label)) return false;
    const description = (option.description ?? "").toLowerCase().trim().replace(/\.$/, "");
    return inertDescriptions.has(description) || starterActionMatches(category, description);
  });
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
  for (const question of questions) {
    const policy = eligible.find((p) => {
      const rule = p.questionRule!;
      if (rule.starterCategory && !starterQuestionMatches(rule.starterCategory, question)) return false;
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
