import { useEffect, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { skillAgentMatrixCell } from "../skill-assignment-matrix.js";
import type { MachineSkillVersionPolicy, RunnerSkillsResponse } from "../skills.js";

export function SkillAssignmentMatrix({ skillId, skillName, runners, machineLabels, machineSkills, onManageVersion }: {
  skillId: string; skillName: string; runners: RunnerView[]; machineLabels: Map<string, string>;
  machineSkills: Record<string, RunnerSkillsResponse>; onManageVersion: (runnerId: string) => void;
}) {
  const api = useApi();
  const [policies, setPolicies] = useState<Record<string, MachineSkillVersionPolicy | "error">>({});
  useEffect(() => {
    let active = true; setPolicies({});
    void Promise.all(runners.map(async runner => {
      try { return [runner.runnerId, await api.getMachineSkillVersionPolicy(skillId, runner.runnerId)] as const; }
      catch { return [runner.runnerId, "error"] as const; }
    })).then(results => { if (active) setPolicies(Object.fromEntries(results)); });
    return () => { active = false; };
  }, [api, skillId, runners, machineSkills]);
  return <section className="skills-section skill-assignment-matrix" aria-label="Machine × Agents"><h4>Machine × Agents</h4>
    <p className="skills-hint">Desired invocation is configuration; reported links are the last machine inventory, not proof of a live harness reload. Offline reports may be stale. Shared harness directories can expose a skill to an untargeted agent.</p>
    {!runners.length && <p>Connect a machine to see its agents and deployment state.</p>}
    {runners.map(runner => {
      const policy = policies[runner.runnerId]; const state = machineSkills[runner.runnerId];
      return <article className="skills-section" key={runner.runnerId} aria-label={`Assignments on ${machineLabels.get(runner.runnerId) ?? runner.runnerId}`}>
        <h5>{machineLabels.get(runner.runnerId) ?? runner.runnerId} · {runner.status === "online" ? "Online" : "Offline"}</h5>
        <p className="skills-hint">Version policy: {!policy ? "Loading…" : policy === "error" ? "Unavailable" : policy.policy?.versionId ? `Pinned · ${policy.policy.versionId}` : "Track Latest"}. All assigned agents share this version.</p>
        <button className="btn sm" type="button" disabled={!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")} onClick={() => onManageVersion(runner.runnerId)}>Manage Machine Version</button>
        <p className="skills-hint">Reported: {!state || state.loadError ? "Unknown" : state.reported?.updatedAt === undefined ? "Never" : new Date(state.reported.updatedAt).toLocaleString()}.</p>
        {state?.loadError && <p role="alert" className="form-error">{state.loadError}</p>}
        {!runner.agents.length ? <p>No agents reported.</p> : <div className="skill-matrix-table-scroll" tabIndex={0} role="region" aria-label={`${machineLabels.get(runner.runnerId) ?? runner.runnerId} Agent States`}><table className="skills-table"><thead><tr><th scope="col">Agent</th><th scope="col">Desired Invocation</th><th scope="col">Reported Link</th></tr></thead>
          <tbody>{runner.agents.map(agent => { const cell = skillAgentMatrixCell(runner, agent, skillName, state); return <tr key={agent.id}><th scope="row">{agent.name}</th><td><span className="skill-matrix-cell-label" aria-hidden="true">Desired Invocation</span>{cell.desired}</td><td><span className="skill-matrix-cell-label" aria-hidden="true">Reported Link</span>{cell.reported}{cell.detail && <p className="skills-hint">{cell.detail}</p>}</td></tr>; })}</tbody>
        </table></div>}
      </article>;
    })}
  </section>;
}
