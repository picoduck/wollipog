import { useCallback, useEffect, useState } from "react";
import type { ResourceScope, RunnerView, SkillInvocationPolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { describeAgentSelector, describeAssignmentScope, invocationLabel, skillGroupsFromPayload, skillsFromPayload, type SkillGroupView, type SkillGroupAssignmentView, type SkillSummary } from "../skills.js";
import { Modal } from "./common.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";
import { AddAssignmentDialog } from "./SkillAssignmentDialog.js";

function ownership(scope: ResourceScope): string {
  const owner = scope.owner;
  return owner.kind === "organization" ? `Organization ${scope.organizationId}` : owner.kind === "user" ? `Private User ${owner.userId} · Organization ${scope.organizationId}` : `Team ${owner.teamId} · Organization ${scope.organizationId}`;
}

export function SkillGroupsDialog({ runners, machineLabels, onClose, onChanged }: {
  runners: RunnerView[]; machineLabels: Map<string, string>; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const api = useApi();
  const [groups, setGroups] = useState<SkillGroupView[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [creationScope, setCreationScope] = useState<ResourceScope | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [rules, setRules] = useState<SkillGroupAssignmentView[] | null>(null);
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ruleRevision, setRuleRevision] = useState(0);
  const selected = groups.find(group => group.id === selectedId);
  const refresh = useCallback(async () => {
    const [groupPayload, skillPayload] = await Promise.all([api.listSkillGroups(), api.listSkills()]);
    setGroups(skillGroupsFromPayload(groupPayload)); setSkills(skillsFromPayload(skillPayload));
    setCreationScope(!Array.isArray(groupPayload) ? groupPayload.creationScope ?? null : null);
    return skillGroupsFromPayload(groupPayload);
  }, [api]);
  useEffect(() => {
    let active = true;
    refresh().catch(cause => { if (active) setError((cause as Error).message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [refresh]);
  useEffect(() => {
    setAccepted(false); setMemberId(""); setError(null); setNotice(null);
  }, [selectedId]);
  useEffect(() => {
    let active = true;
    setRules(null);
    if (selected?.scope) api.listSkillGroupAssignments(selected.id).then(result => { if (active) setRules(result.assignments); })
      .catch(cause => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, [api, selected?.id, selected?.scope?.organizationId, ruleRevision]);
  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await work(); setAccepted(false); setAdding(false);
      setNotice("Change saved. Existing assignments and machine-wide version pins determine deployment.");
      try {
        await refresh();
        setRuleRevision(revision => revision + 1);
        await onChanged();
      } catch { setError("Change saved, but status could not refresh. Close and reopen this dialog before making another change."); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  if (adding && selected) return <AddAssignmentDialog skill={{ id: selected.id, name: `all current and future members of ${selected.name}` }} runners={runners} machineLabels={machineLabels} busy={busy}
    error={error} onClose={() => { if (!busy) { setAdding(false); setError(null); } }} onCreate={input => mutate(() => api.createSkillGroupAssignment(selected.id, input))} />;
  return <Modal title="Manage Skill Groups" wide onClose={() => { if (!busy) onClose(); }} footer={<button className="btn" type="button" disabled={busy} onClick={onClose}>Close</button>}>
    <div className="form skills-machine-import skill-groups-dialog">
      <p>Group assignments apply dynamically to every current and future member. Direct skill rules win at equal targeting specificity. Machine-wide pins still apply.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Loading…</p>}
      <label className="field"><span>New Group Name</span><input value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      {creationScope && <p className="skills-hint">New group ownership: {ownership(creationScope)}.</p>}
      <button className="btn" type="button" disabled={busy || !creationScope || !name.trim()} onClick={() => void mutate(async () => {
        const result = await api.createSkillGroup({ name: name.trim() }); setName(""); setSelectedId(result.group.id);
      })}>Create Group</button>
      <label className="field"><span>Group</span><Select label="Group" value={selectedId} disabled={busy} options={[{ value: "", label: "Choose a Group" }, ...groups.map(group => ({ value: group.id, label: group.name }))]} onChange={setSelectedId} /></label>
      {!groups.length && !busy && <p>No groups yet. Create one to organize and assign skills together.</p>}
      {selected && <>
        <h3>{selected.name}</h3>
        <p className="skills-hint">Ownership: {selected.scope ? ownership(selected.scope) : "Legacy Metadata Only"}.</p>
        {!selected.scope && <section className="skills-section"><h4>Convert Legacy Group</h4>
          <p>Conversion permanently assigns ownership and may remove other users’ access to this group. It cannot be undone here. Every member must already have the same ownership; no skill ownership is transferred.</p>
          <p>Resulting ownership: {creationScope ? ownership(creationScope) : "Unavailable — a human identity is required"}.</p>
          <button className="btn" type="button" disabled={busy || !accepted || !creationScope} onClick={() => void mutate(() => api.convertSkillGroup(selected.id))}>Convert Group</button>
        </section>}
        <label className="field"><span><Checkbox label="Accept Group-Wide Deployment and Ownership Impact" checked={accepted} disabled={busy} onChange={setAccepted} /> Accept Group-Wide Deployment and Ownership Impact</span></label>
        <p className="skills-hint">Membership changes can add or remove deployment on every targeted machine. Removing a member or deleting the group preserves library content, direct assignments, and version pins.</p>
        <section className="skills-section"><h4>Members</h4>
          {skills.filter(skill => skill.groupId === selected.id).map(skill => <div className="skills-section-heading" key={skill.id}><span>{skill.name}</span>
            <button className="btn sm" type="button" aria-label={`Remove ${skill.name} from Group`} disabled={busy || !accepted} onClick={() => void mutate(() => api.updateSkill(skill.id, { groupId: null }))}>Remove</button></div>)}
          {!skills.some(skill => skill.groupId === selected.id) && <p>No visible members.</p>}
          <label className="field"><span>Skill to Add</span><Select label="Skill to Add" value={memberId} disabled={busy} options={[{ value: "", label: "Choose a Skill" }, ...skills.filter(skill => !skill.groupId).map(skill => ({ value: skill.id, label: skill.name }))]} onChange={setMemberId} /></label>
          <p className="skills-hint">Only ungrouped skills are offered. Owned groups require identical skill ownership; the server checks this before saving.</p>
          <button className="btn" type="button" disabled={busy || !accepted || !memberId} onClick={() => void mutate(async () => { await api.updateSkill(memberId, { groupId: selected.id }); setMemberId(""); })}>Add Member</button>
        </section>
        {selected.scope && <section className="skills-section"><h4>Group Assignments</h4>
          <button className="btn" type="button" disabled={busy || rules === null} onClick={() => { setError(null); setAdding(true); }}>Add Group Assignment</button>
          {rules === null ? <p>Assignments are unavailable until loading succeeds.</p> : !rules.length ? <p>No group assignments.</p> : rules.map(rule => <article className="skills-section" key={rule.id}>
            <p>{describeAssignmentScope(rule, id => machineLabels.get(id))} · {describeAgentSelector(rule.agentSelector, runners.find(runner => runner.runnerId === rule.runnerId)?.agents ?? [])}</p>
            <label className="field"><span>Invocation</span><Select<SkillInvocationPolicy> label="Group Invocation" value={rule.invocation} disabled={busy || !accepted} options={[{ value: "agent", label: invocationLabel("agent") }, { value: "manual", label: invocationLabel("manual") }]} onChange={invocation => void mutate(() => api.updateSkillGroupAssignment(selected.id, rule.id, { invocation }))} /></label>
            <div className="skills-section-heading"><button className="btn sm" type="button" disabled={busy || !accepted} onClick={() => void mutate(() => api.updateSkillGroupAssignment(selected.id, rule.id, { enabled: !rule.enabled }))}>{rule.enabled ? "Disable Assignment" : "Enable Assignment"}</button>
              <button className="btn danger sm" type="button" disabled={busy || !accepted} onClick={() => void mutate(() => api.deleteSkillGroupAssignment(selected.id, rule.id))}>Delete Assignment</button></div>
          </article>)}
        </section>}
        <button className="btn danger" type="button" disabled={busy || !accepted} onClick={() => void mutate(async () => { await api.deleteSkillGroup(selected.id); setSelectedId(""); })}>Delete Group and Its Assignments</button>
      </>}
    </div>
  </Modal>;
}
