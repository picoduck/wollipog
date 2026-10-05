import React, { useState } from "react";
import type { GovernancePolicy } from "@wollipog/protocol";
import {
  POLICY_EFFECT_LABELS,
  formatAskTimeout,
  policyConditionPhrases,
  toolPolicies,
  toolPolicyMeta,
} from "../governance-policies.js";
import { approvalsPolicyAnchorId } from "../navigation.js";
import { LockIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { SkeletonRows } from "./QuestionPoliciesPanel.js";
import { SettingsGroup } from "./SettingsView.js";
import { StatusBadge } from "./StatusBadge.js";
import { NavRow } from "./ui/SettingsRows.js";

/**
 * Settings › Approvals › Tool Policies (#2158): the policies that allow, ask about or deny tool
 * calls, in the order the control plane weighs them. Read-only by design — tool policies are
 * shared guardrails rather than personal preferences, and any signed-in person could change one
 * through the same route, so nothing here sends a write. Editing stays with the command line and
 * agent tools. A row opens Policy Details.
 *
 * Every row carries `approvalsPolicyAnchorId(policyId)`, which is what a policy link in a Decision
 * Record, a request card or Decision History scrolls to.
 */
export function ToolPoliciesList({ policies }: { policies: readonly GovernancePolicy[] | null }) {
  const [details, setDetails] = useState<GovernancePolicy | null>(null);
  const rows = policies === null ? null : toolPolicies(policies);
  return (
    <SettingsGroup
      title="Tool Policies"
      intro="The first policy that matches a tool call, highest priority first, allows it, asks you or denies it. Change them from the command line or agent tools."
    >
      {rows === null ? <SkeletonRows count={3} announce="Loading tool policies…" />
        : rows.length === 0 ? (
          <p className="approvals-empty">No tool policies. Every tool call follows the session's permission mode.</p>
        ) : rows.map((policy) => (
          <NavRow
            key={policy.policyId}
            id={approvalsPolicyAnchorId(policy.policyId)}
            hasPopup="dialog"
            title={policy.name.trim() || policy.policyId}
            badge={<StatusBadge tone="neutral" noDot label={POLICY_EFFECT_LABELS[policy.effect]} />}
            description={<PolicyMeta policy={policy} />}
            onClick={() => setDetails(policy)}
          />
        ))}
      {details && <PolicyDetails policy={details} onClose={() => setDetails(null)} />}
    </SettingsGroup>
  );
}

/** Label-prefixed meta, 12px apart and never separated by dots (§5.2, §11.3). */
function PolicyMeta({ policy }: { policy: GovernancePolicy }) {
  return (
    <span className="policy-meta">
      {policy.builtin && <span className="policy-meta-item"><LockIcon size={14} aria-hidden="true" />Built In</span>}
      {toolPolicyMeta(policy).map((item) => (
        <span className="policy-meta-item" key={item.label}>{item.label}: {item.value}</span>
      ))}
    </span>
  );
}

/** Read-only facts for one policy (§5.4) in a close-only dialog with a single Done (§7.3). */
function PolicyDetails({ policy, onClose }: { policy: GovernancePolicy; onClose: () => void }) {
  const conditions = policyConditionPhrases(policy.conditions);
  const scope = policy.scope;
  const updated = policy.updatedAt > 0 ? new Date(policy.updatedAt) : null;
  const facts: [string, React.ReactNode][] = [
    ["Name", policy.name.trim() || policy.policyId],
    ["Effect", POLICY_EFFECT_LABELS[policy.effect]],
    ["Priority", policy.priority.toLocaleString()],
    ["State", policy.enabled ? "On" : "Off"],
    ["Source", policy.builtin ? "Built in to Wollipog. It cannot be changed." : "Saved on this control plane."],
    ["Tool", scope.toolName ? <code>{scope.toolName}</code> : "Every tool"],
    ["Organization", scope.organizationId ? <code>{scope.organizationId}</code> : "Every organization"],
    ["Machine", scope.runnerId ? <code>{scope.runnerId}</code> : "Every machine"],
    ["Workspace", scope.workspaceId ? <code>{scope.workspaceId}</code> : "Every workspace"],
    ["Agent", scope.agentId ? <code>{scope.agentId}</code> : "Every agent"],
  ];
  if (scope.path) facts.push(["Path", <code>{scope.path}</code>]);
  if (scope.branch) facts.push(["Branch", <code>{scope.branch}</code>]);
  if (scope.network) facts.push(["Network", <code>{scope.network}</code>]);
  facts.push(["Conditions", conditions.length > 0 ? sentence(conditions.join(", ")) : "None"]);
  if (policy.effect === "ask") {
    facts.push(["Ask Timeout", policy.askTimeout === undefined ? "Waits until answered" : formatAskTimeout(policy.askTimeout)]);
  }
  facts.push(["Policy ID", <code>{policy.policyId}</code>]);
  if (updated && !Number.isNaN(updated.getTime())) {
    facts.push(["Updated", <time dateTime={updated.toISOString()}>{UPDATED.format(updated)}</time>]);
  }
  return (
    <Modal
      title="Policy Details"
      size="sm"
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </Modal>
  );
}

const UPDATED = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
