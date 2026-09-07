import { useEffect, useState } from "react";
import type { RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { describeAgentSelector, describeAssignmentScope, invocationLabel, type SkillGroupAssignmentView, type SkillGroupView } from "../skills.js";

export function SkillInheritedAssignments({ groupId, groups, runners, machineLabels, onManage }: {
  groupId: string; groups: SkillGroupView[]; runners: RunnerView[]; machineLabels: Map<string, string>; onManage: () => void;
}) {
  const api = useApi();
  const group = groups.find(item => item.id === groupId);
  const [rules, setRules] = useState<SkillGroupAssignmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setRules(null); setError(null);
    if (group?.scope) api.listSkillGroupAssignments(groupId).then(result => { if (active) setRules(result.assignments); })
      .catch(cause => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, [api, groupId, groups]);
  return <section className="skills-section" aria-label="Inherited Assignments"><h4>Inherited Assignments</h4>
    <p>Group: {group?.name ?? "Unavailable"}. Direct rules win at equal targeting specificity; machine-wide pins still select the deployed version.</p>
    <button className="btn sm" type="button" onClick={onManage}>Manage Group Assignments</button>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!group ? <p>Group information is unavailable.</p> : !group.scope ? <p>This legacy group is organizational metadata only and has no deployable assignments.</p> : rules === null ? <p>Group assignments have not loaded.</p> : rules.length === 0 ? <p>No visible group assignments.</p> : rules.map(rule => <p key={rule.id}>
      {describeAssignmentScope(rule, id => machineLabels.get(id))} · {describeAgentSelector(rule.agentSelector, runners.find(runner => runner.runnerId === rule.runnerId)?.agents ?? [])} · {invocationLabel(rule.invocation)} · {rule.enabled ? "Enabled" : "Disabled"}
    </p>)}
  </section>;
}
