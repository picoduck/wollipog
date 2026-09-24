/** Shared transcript identity for agent skill invocations, independent of the provider that ran
 * them. Every driver that recognizes a skill emits this kind and title shape so the timeline can
 * style skill rows consistently. */
export const SKILL_TOOL_KIND = "skill";

const SKILL_NAME_MAX = 80;
const SKILL_ARGS_MAX = 60;

/** Collapse control, bidi-override, and whitespace runs so a provider-supplied label renders as
 * one inert line; returns undefined for non-strings and blank values. */
function singleLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** `Skill: <name>` followed by at most a truncated one-line argument preview, matching how other
 * tool titles clip their command or path. A missing name degrades to the bare `Skill` label. */
export function skillToolTitle(name: unknown, args?: unknown): string {
  const skill = singleLine(name, SKILL_NAME_MAX);
  if (!skill) return "Skill";
  const preview = singleLine(args, SKILL_ARGS_MAX);
  return preview ? `Skill: ${skill} ${preview}` : `Skill: ${skill}`;
}
