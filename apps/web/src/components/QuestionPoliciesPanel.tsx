import React, { useEffect, useState } from "react";
import type { GovernancePolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { SettingsGroup } from "./SettingsView.js";
import { SwitchRow } from "./ui/SettingsRows.js";

export const QUESTION_POLICY_STARTERS = [
  { id: "review", title: "Review Sharing and Retries", description: "Approve sending a diff for review or retrying a review." },
  { id: "push", title: "Push and Open PR", description: "Approve pushing a branch or opening a pull request." },
  { id: "evidence", title: "Evidence Upload", description: "Approve uploading UI evidence to the private evidence bucket." },
] as const;

export function starterQuestionPolicy(category: typeof QUESTION_POLICY_STARTERS[number], userId: string, organizationId: string, enabled: boolean): Omit<GovernancePolicy, "createdAt" | "updatedAt"> {
  return {
    policyId: `questions:${category.id}:${userId}`, name: category.title, enabled, effect: "allow", priority: 0,
    ownerUserId: userId, scope: { organizationId },
    questionRule: {
      starterCategory: category.id, questionPattern: "*?",
      answer: { text: "Yes. Proceed with this routine workflow step." },
    },
  };
}

export function QuestionPoliciesPanel() {
  const api = useApi();
  const [policies, setPolicies] = useState<GovernancePolicy[]>([]);
  const [owner, setOwner] = useState<{ userId: string; organizationId: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void Promise.all([api.governancePolicies(), api.getIdentity()]).then(([result, identity]) => {
      if (active) { setPolicies(result.policies); setOwner(identity.context); }
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [api]);
  async function toggle(category: typeof QUESTION_POLICY_STARTERS[number]) {
    if (!owner || busy) return;
    const current = policies.find((p) => p.policyId === `questions:${category.id}:${owner.userId}`);
    setBusy(category.id); setError(undefined);
    try {
      const { createdAt: _created, updatedAt: _updated, builtin: _builtin, ...existing } = current ?? {} as GovernancePolicy;
      const saved = await api.putGovernancePolicy(current
        ? { ...existing, enabled: !current.enabled }
        : starterQuestionPolicy(category, owner.userId, owner.organizationId, true));
      setPolicies((old) => [...old.filter((p) => p.policyId !== saved.policyId), saved]);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(undefined); }
  }
  return <SettingsGroup title="Routine Question Policies">
    <p>Automatically answer routine questions in sessions you own. Each category starts off. Replies use the form’s free-text option; other forms still ask you.</p>
    <p>Starters recognize simple “May I” or “Can I” permission questions. Additional actions or unrecognized context still ask you, including merge, deletion, issue publication, and deployment.</p>
    {error && <p role="alert">{error}</p>}
    {QUESTION_POLICY_STARTERS.map((category) => <SwitchRow key={category.id} title={category.title}
      description={category.description} checked={policies.some((p) => p.policyId === `questions:${category.id}:${owner?.userId}` && p.enabled)}
      disabled={!owner || !!busy} busy={busy === category.id} onClick={() => void toggle(category)} />)}
  </SettingsGroup>;
}
