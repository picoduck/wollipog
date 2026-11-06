import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkflowDecisionOwnerRule, sameWorkflowDecisionOwnerRule,
  WORKFLOW_DECISION_OWNER_RULE_QUOTE_MAX_CHARS, WORKFLOW_DECISION_OWNER_RULE_SOURCE_MAX_CHARS,
} from "./workflow-decision-owner-rule.js";

const RULE = { source: "~/.claude/skills/issue-workflow/SKILL.md", quote: "Merging requires per-PR user authorization." };

test("an owner rule is accepted exactly as given, up to its limits (#4137)", () => {
  assert.deepEqual(normalizeWorkflowDecisionOwnerRule(undefined), { ok: true, rule: undefined });
  assert.deepEqual(normalizeWorkflowDecisionOwnerRule(RULE), { ok: true, rule: RULE });
  for (const source of ["AGENTS.md", "/home/user/.claude/CLAUDE.md", "C:\\Users\\me\\AGENTS.md", "skills/a_b-c+d@1:2/SKILL.md"]) {
    assert.equal(normalizeWorkflowDecisionOwnerRule({ ...RULE, source }).ok, true, source);
  }
  const atLimit = { source: "s".repeat(WORKFLOW_DECISION_OWNER_RULE_SOURCE_MAX_CHARS), quote: "q".repeat(WORKFLOW_DECISION_OWNER_RULE_QUOTE_MAX_CHARS) };
  assert.deepEqual(normalizeWorkflowDecisionOwnerRule(atLimit), { ok: true, rule: atLimit });
  // Ordinary punctuation, quotes and markup stay as text; nothing is escaped or repaired here.
  const markup = { ...RULE, quote: "Ask \"through the structured question tool\" <b>before</b> `gh pr merge` — always." };
  assert.deepEqual(normalizeWorkflowDecisionOwnerRule(markup), { ok: true, rule: markup });
});

test("an owner rule outside its bounds is refused, never truncated (#4137)", () => {
  const refused = (value: unknown) => {
    const result = normalizeWorkflowDecisionOwnerRule(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    return result.ok ? "" : result.message;
  };
  assert.match(refused({ ...RULE, source: "s".repeat(WORKFLOW_DECISION_OWNER_RULE_SOURCE_MAX_CHARS + 1) }), /at most 256/u);
  assert.match(refused({ ...RULE, quote: "q".repeat(WORKFLOW_DECISION_OWNER_RULE_QUOTE_MAX_CHARS + 1) }), /at most 1000/u);
  for (const value of [null, "AGENTS.md", [RULE], 7, { source: RULE.source }, { quote: RULE.quote },
    { ...RULE, extra: true }, { ...RULE, source: "" }, { ...RULE, source: 7 }, { ...RULE, quote: "" }, { ...RULE, quote: "  " }]) {
    refused(value);
  }
  for (const source of ["my skills/SKILL.md", "a\tb", "a\nb", "skills/<script>", "skills/é.md", "\"quoted\"", "a;b"]) {
    refused({ ...RULE, source });
  }
  for (const quote of ["line one\nline two", "tab\there", "nul\u0000", "del\u007f", "c1\u0085", "rtl \u202e override",
    "isolate \u2066x\u2069", "zero\u200bwidth", "bom\ufeff", "separator\u2028", " leading", "trailing "]) {
    refused({ ...RULE, quote });
  }
});

test("owner rules compare by both fields (#4137)", () => {
  assert.equal(sameWorkflowDecisionOwnerRule(undefined, undefined), true);
  assert.equal(sameWorkflowDecisionOwnerRule(RULE, { ...RULE }), true);
  assert.equal(sameWorkflowDecisionOwnerRule(RULE, undefined), false);
  assert.equal(sameWorkflowDecisionOwnerRule(RULE, { ...RULE, quote: "Other." }), false);
  assert.equal(sameWorkflowDecisionOwnerRule(RULE, { ...RULE, source: "AGENTS.md" }), false);
});
