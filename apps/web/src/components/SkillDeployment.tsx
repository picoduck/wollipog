import React, { useEffect, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { statusMeta } from "../status-meta.js";
import {
  skillAssignedBy,
  skillMachineDeployment,
  type SkillAgentDeployment,
  type SkillMachineDeployment,
  type SkillRule,
} from "../skill-assignment-matrix.js";
import { accountLabelText } from "../personal-identifiers.js";
import {
  invocationLabel,
  reportedSkillLinkRemovals,
  skillVersionLabel,
  type MachineSkillVersionPolicy,
  type RunnerSkillsResponse,
  type SkillSummary,
  type SkillVersionSummary,
} from "../skills.js";
import { ChevronRightIcon, RefreshIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { targetsWithoutManagedSkills } from "./SkillsUnavailableNotice.js";
import { BusyButton } from "./ui/BusyButton.js";

/** "A", "A or B", "A, B or C": the targets a machine's skills don't reach. */
const orList = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

/** The machine row's count of its agents' statuses, or why there is none. */
function machineSummary(state: RunnerSkillsResponse | undefined, deployment: SkillMachineDeployment): string | null {
  if (!state) return "Loading…";
  if (state.loadError) return null;
  return deployment.total === 0 ? "Not Assigned" : `${deployment.linked} of ${deployment.total} Linked`;
}

export interface SkillDeploymentProps<T extends SkillRule> {
  skill: Pick<SkillSummary, "id" | "name" | "builtIn" | "latestVersion">;
  runners: ReadonlyArray<RunnerView>;
  machineLabels: ReadonlyMap<string, string>;
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>;
  /** The skill's own assignments and its group's, which name the rule behind each agent. */
  rules: ReadonlyArray<T>;
  /** False while a rule that could win is unread (the group's, loading or unreadable). */
  rulesComplete: boolean;
  groupName: (groupId: string) => string | undefined;
  syncingRunnerId: string | null;
  onSync: (runnerId: string) => void;
  onManageVersion: (runnerId: string) => void;
}

/**
 * The skill detail's Deployment section (#1981): one table, one row group per machine, so every
 * agent's row lines up from one machine to the next. A machine row carries the machine's state,
 * version policy, a Linked count and its actions; each agent row has one status (§11.2) and, when
 * there is more to say, one reason. Agents that can't receive managed skills fold into one row.
 */
export function SkillDeployment<T extends SkillRule>(props: SkillDeploymentProps<T>) {
  const { skill, runners, machineLabels, machineSkills } = props;
  const api = useApi();
  const [policies, setPolicies] = useState<Record<string, MachineSkillVersionPolicy | "error">>({});
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    setPolicies({});
    void Promise.all(runners.map(async (runner) => {
      try { return [runner.runnerId, await api.getMachineSkillVersionPolicy(skill.id, runner.runnerId)] as const; }
      catch { return [runner.runnerId, "error"] as const; }
    })).then((results) => { if (active) setPolicies(Object.fromEntries(results)); });
    return () => { active = false; };
  }, [api, skill.id, runners, machineSkills]);

  // A pin names its version by number ("Pinned to v2"), which only the version list knows.
  const pinned = Object.values(policies).some((policy) => policy !== "error" && policy.policy?.versionId &&
    policy.policy.versionId !== skill.latestVersion?.id);
  useEffect(() => {
    if (!pinned) return;
    let active = true;
    api.listSkillVersions(skill.id)
      .then((result) => { if (active) setVersions(result.versions); })
      .catch(() => { /* The pin stays unnamed: "Pinned". */ });
    return () => { active = false; };
  }, [api, skill.id, pinned]);

  const policyText = (runnerId: string) => {
    const policy = policies[runnerId];
    if (!policy) return null;
    if (policy === "error") return "Version Unavailable";
    const versionId = policy.policy?.versionId;
    if (!versionId) return "Track Latest";
    const version = skill.latestVersion?.id === versionId ? skill.latestVersion : versions.find((entry) => entry.id === versionId);
    const label = skillVersionLabel(version);
    return label ? `Pinned to ${label.text}` : "Pinned";
  };

  const machines = runners.map((runner) => ({
    runner,
    state: machineSkills[runner.runnerId],
    deployment: skillMachineDeployment(runner, skill.name, machineSkills[runner.runnerId]),
  }));
  const settled = machines.every(({ state }) => state && !state.loadError);
  const notDeployed = runners.length === 0 || (settled && machines.every(({ deployment }) => deployment.total === 0));
  const assigned = props.rules.some((rule) => rule.enabled);
  const notDeployedReason = runners.length === 0
    ? "Connect a machine to deploy this skill."
    : assigned
      ? "Its assignments don't reach an agent that can receive managed skills."
      : !props.rulesComplete
        ? "No machine has an agent it's assigned to."
        : skill.builtIn
          ? "It isn't assigned yet. Built-in skills reach a machine only after you assign them."
          : "It isn't assigned yet. Add an assignment to choose its machines and agents.";

  const toggle = (runnerId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(runnerId)) next.delete(runnerId); else next.add(runnerId);
    return next;
  });

  const agentRow = (runner: RunnerView, row: SkillAgentDeployment) => {
    const assignedBy = row.eligible
      ? skillAssignedBy(row, runner.runnerId, props.rules, props.rulesComplete, props.groupName)
      : null;
    return (
      <tr key={row.agent.id} className="skill-deployment-agent">
        <th scope="row">
          <span className="skill-deployment-agent-name">{row.agent.name || row.agent.id}</span>
          {row.reason && <p className="cell-note skill-deployment-reason">{row.reason}</p>}
        </th>
        <td className="cell-meta cell-dim">
          <span className="cell-label" aria-hidden="true">Invocation: </span>
          {!row.eligible ? "—" : row.invocation ? invocationLabel(row.invocation) : "Not Assigned"}
        </td>
        <td className="cell-meta cell-fill cell-dim">
          <span className="cell-label" aria-hidden="true">Assigned By: </span>
          {assignedBy ?? "—"}
        </td>
        <td className="cell-status">
          {row.status && <StatusBadge inline meta={statusMeta("skill", row.status)} />}
        </td>
      </tr>
    );
  };

  return (
    <>
      {notDeployed && (
        <Notice tone="neutral" title="Not Deployed Anywhere" compact>{notDeployedReason}</Notice>
      )}
      {runners.length > 0 && (
        <div className="table-wrap">
          <table className="table skill-deployment">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col" className="col-invocation">Invocation</th>
                <th scope="col" className="col-assigned-by">Assigned By</th>
                <th scope="col" className="col-status">Status</th>
              </tr>
            </thead>
            {machines.map(({ runner, state, deployment }) => {
              const name = machineLabels.get(runner.runnerId) ?? runner.runnerId;
              const online = runner.status === "online";
              const policy = policyText(runner.runnerId);
              const skillFreeTargets = targetsWithoutManagedSkills(runner.executionTargets);
              // Only this skill's: the machine's whole history is in Connections.
              const removals = state && !state.loadError ? reportedSkillLinkRemovals(state.reported, skill.name) : [];
              const open = expanded.has(runner.runnerId);
              const ineligible = deployment.ineligible.length;
              const summary = machineSummary(state, deployment);
              return (
                <tbody key={runner.runnerId} aria-label={name}>
                  <tr className="skill-deployment-machine">
                    <td colSpan={4}>
                      <div className="skill-deployment-machine-line">
                        <strong className="skill-deployment-machine-name">{name}</strong>
                        <StatusBadge inline meta={statusMeta("machine", online ? "online" : "offline")} />
                        {policy && <span className="skill-deployment-meta">{policy}</span>}
                        {summary && <span className="skill-deployment-meta">{summary}</span>}
                        <span className="skill-deployment-actions">
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")}
                            onClick={() => props.onManageVersion(runner.runnerId)}
                          >
                            Manage Version…
                          </button>
                          {online ? (
                            <BusyButton
                              className="icon-btn sm"
                              busy={props.syncingRunnerId === runner.runnerId}
                              progress={`Syncing ${name}…`}
                              disabled={props.syncingRunnerId !== null && props.syncingRunnerId !== runner.runnerId}
                              aria-label="Sync Now"
                              title="Sync Now"
                              icon={<RefreshIcon />}
                              onClick={() => props.onSync(runner.runnerId)}
                            >
                              {null}
                            </BusyButton>
                          ) : (
                            <span className="skill-deployment-meta">Updates when back online</span>
                          )}
                        </span>
                      </div>
                      {state?.loadError && <p className="cell-note skill-deployment-load-error" role="alert">{state.loadError}</p>}
                      {skillFreeTargets.length > 0 && (
                        <p className="cell-note">
                          Assigned skills load only in host sessions, so they don't reach {orList(skillFreeTargets)}.
                        </p>
                      )}
                      {runner.agents.length === 0 && <p className="cell-note">This machine reports no agents.</p>}
                      {removals.map((entry, index) => (
                        <p className="cell-note" key={`${entry.path}:${entry.reason}:${index}`}>
                          Removed {entry.path}
                          {entry.providerAccountId && ` (${accountLabelText(runner.providerAccounts?.find((account) =>
                            account.id === entry.providerAccountId)?.label ?? "Provider Account")})`}: {entry.reason}
                        </p>
                      ))}
                    </td>
                  </tr>
                  {state && !state.loadError && deployment.rows.map((row) => agentRow(runner, row))}
                  {ineligible > 0 && (
                    <tr className="skill-deployment-ineligible">
                      <td colSpan={4}>
                        <button
                          type="button"
                          className="disclosure-trigger"
                          aria-expanded={open}
                          onClick={() => toggle(runner.runnerId)}
                        >
                          <ChevronRightIcon className="disclosure-chevron" />
                          {ineligible === 1 ? "1 Agent Can't Receive Managed Skills" : `${ineligible} Agents Can't Receive Managed Skills`}
                        </button>
                      </td>
                    </tr>
                  )}
                  {open && deployment.ineligible.map((row) => agentRow(runner, row))}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </>
  );
}
