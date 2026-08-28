import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunnerView, SkillFile, SkillInvocationPolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreSelector } from "../store.js";
import { machineOptionLabels } from "../runners.js";
import { driverKindLabel } from "../agent-presentation.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Empty, Modal, Skeleton } from "./common.js";
import { Select } from "./ui/ChoiceControls.js";
import { SkillsIcon } from "./Icons.js";
import { Markdown } from "./Markdown.js";
import {
  describeAgentSelector,
  describeAssignmentScope,
  groupSkillList,
  invocationLabel,
  reportedSkillLinkRemovals,
  reportedUnmanagedSkills,
  skillAssignmentsFromPayload,
  skillDeployBadge,
  skillEligibleAgents,
  skillFilesFromUploads,
  skillFromPayload,
  skillGroupsFromPayload,
  skillMarkdownBody,
  skillMarkdownTemplate,
  skillsFromPayload,
  validateSkillDraft,
  type RunnerSkillsResponse,
  type SkillAgentSelector,
  type SkillAssignmentView,
  type SkillGroupView,
  type SkillSummary,
} from "../skills.js";

/** Drivers the MVP reconciler deploys to; offered even before a machine reports its agents. */
const ASSIGNABLE_DRIVERS = ["claude-code", "codex", "codex-app-server"] as const;

function formatTime(value: number | undefined): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

function NewSkillDialog({ onClose, onCreate, busy }: {
  onClose: () => void;
  onCreate: (input: { name: string; description: string; files: SkillFile[] }) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [markdown, setMarkdown] = useState(() => skillMarkdownTemplate("", ""));
  const [markdownTouched, setMarkdownTouched] = useState(false);
  const [folderFiles, setFolderFiles] = useState<SkillFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const buildFiles = (): SkillFile[] => folderFiles.length
    ? folderFiles
    : [{ path: "SKILL.md", content: markdown, encoding: "utf8" }];

  const readFolder = async (list: FileList | null) => {
    if (!list || list.length === 0) {
      setFolderFiles([]);
      return;
    }
    const uploads = await Promise.all([...list].map(async (file) => ({
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    const converted = skillFilesFromUploads(uploads);
    setErrors(converted.errors);
    setFolderFiles(converted.files);
  };

  const submit = async () => {
    const files = buildFiles();
    const found = validateSkillDraft({ name: name.trim(), files });
    setErrors(found);
    if (found.length) return;
    await onCreate({ name: name.trim(), description: description.trim(), files });
  };

  return (
    <Modal title="New Skill" onClose={onClose} wide footer={
      <>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create Skill"}
        </button>
      </>
    }>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            maxLength={64}
            placeholder="my-skill"
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!markdownTouched) setMarkdown(skillMarkdownTemplate(next, description));
            }}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            value={description}
            maxLength={280}
            placeholder="What this skill helps an agent do"
            onChange={(event) => {
              const next = event.target.value;
              setDescription(next);
              if (!markdownTouched) setMarkdown(skillMarkdownTemplate(name, next));
            }}
          />
        </label>
        <label className="field">
          <span>SKILL.md</span>
          <textarea
            value={markdown}
            rows={10}
            disabled={folderFiles.length > 0}
            onChange={(event) => {
              setMarkdownTouched(true);
              setMarkdown(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>Folder Upload</span>
          <input
            type="file"
            multiple
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={(event) => void readFolder(event.target.files)}
          />
          <small className="skills-hint">
            Optional: pick a skill folder to upload every file in it. The folder replaces the SKILL.md editor above.
          </small>
        </label>
        {folderFiles.length > 0 && (
          <p className="skills-hint">
            {folderFiles.length} file{folderFiles.length === 1 ? "" : "s"} ready: {folderFiles.map((file) => file.path).join(", ")}
          </p>
        )}
        {errors.length > 0 && (
          <div className="form-error" role="alert">
            {errors.map((message) => <div key={message}>{message}</div>)}
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddAssignmentDialog({ skill, runners, machineLabels, busy, onClose, onCreate }: {
  skill: SkillSummary;
  runners: RunnerView[];
  machineLabels: Map<string, string>;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: {
    scopeKind: "instance" | "runner";
    runnerId?: string;
    agentSelector: SkillAgentSelector;
    invocation: SkillInvocationPolicy;
  }) => Promise<void>;
}) {
  const [machineChoice, setMachineChoice] = useState("all");
  const [agentChoice, setAgentChoice] = useState("all");
  const [invocation, setInvocation] = useState<SkillInvocationPolicy>("agent");
  const runnerId = machineChoice === "all" ? "" : machineChoice;
  const selectedRunner = runners.find((runner) => runner.runnerId === runnerId);
  const eligibleAgents = selectedRunner ? skillEligibleAgents(selectedRunner.agents) : [];

  const submit = async () => {
    const agentSelector: SkillAgentSelector = agentChoice === "all"
      ? { kind: "all" }
      : agentChoice.startsWith("driver:")
        ? { kind: "driver", driver: agentChoice.slice("driver:".length) }
        : { kind: "agent", agentId: agentChoice.slice("agent:".length) };
    await onCreate({
      scopeKind: runnerId ? "runner" : "instance",
      ...(runnerId ? { runnerId } : {}),
      agentSelector,
      invocation,
    });
  };

  return (
    <Modal title="Add Assignment" onClose={onClose} footer={
      <>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Adding…" : "Add Assignment"}
        </button>
      </>
    }>
      <div className="form">
        <p className="skills-hint">Deploy “{skill.name}” to the machines and agents selected below.</p>
        <div className="field">
          <span>Machine</span>
          <Select
            label="Machine"
            value={machineChoice}
            options={[
              { value: "all", label: "All Machines" },
              ...runners.map((runner) => ({
                value: runner.runnerId,
                label: machineLabels.get(runner.runnerId) ?? runner.runnerId,
              })),
            ]}
            onChange={(value) => { setMachineChoice(value); setAgentChoice("all"); }}
          />
        </div>
        <div className="field">
          <span>Agents</span>
          <Select
            label="Agents"
            value={agentChoice}
            options={[
              { value: "all", label: "All Agents" },
              ...ASSIGNABLE_DRIVERS.map((driver) => ({
                value: `driver:${driver}`,
                label: driverKindLabel(driver),
              })),
              ...eligibleAgents.map((agent) => ({ value: `agent:${agent.id}`, label: agent.name })),
            ]}
            onChange={setAgentChoice}
          />
        </div>
        <div className="field">
          <span>Invocation</span>
          <Select<SkillInvocationPolicy>
            label="Invocation"
            value={invocation}
            options={[
              { value: "agent", label: invocationLabel("agent") },
              { value: "manual", label: invocationLabel("manual") },
            ]}
            onChange={setInvocation}
          />
        </div>
        <p className="skills-hint">
          Manual Only deploys the skill with model invocation disabled, so only a person can run it.
        </p>
      </div>
    </Modal>
  );
}

export function SkillsView() {
  const api = useApi();
  const { confirm } = useFeedback();
  const runnersMap = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  const runners = useMemo(() => [...runnersMap.values()], [runnersMap]);
  const machineLabels = useMemo(() => {
    const boxByRunner = new Map([...boxes.values()].map((box) => [box.runnerId, box]));
    return machineOptionLabels(runners, (id) => boxByRunner.get(id));
  }, [boxes, runners]);

  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [groups, setGroups] = useState<SkillGroupView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillSummary | null>(null);
  const [assignments, setAssignments] = useState<SkillAssignmentView[]>([]);
  const [machineSkills, setMachineSkills] = useState<Record<string, RunnerSkillsResponse>>({});
  const [busy, setBusy] = useState(false);
  const [syncingRunnerId, setSyncingRunnerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new-skill" | "add-assignment" | null>(null);

  /** Only the newest started refresh of each surface may commit (see AutomationsView). */
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const refreshList = useCallback(async () => {
    const generation = (listGeneration.current += 1);
    const [skillsPayload, groupsPayload] = await Promise.all([api.listSkills(), api.listSkillGroups()]);
    if (generation !== listGeneration.current) return;
    setSkills(skillsFromPayload(skillsPayload));
    setGroups(skillGroupsFromPayload(groupsPayload));
  }, [api]);

  const refreshDetail = useCallback(async (skillId: string) => {
    const generation = (detailGeneration.current += 1);
    const [detailPayload, assignmentsPayload] = await Promise.all([
      api.getSkill(skillId),
      api.listSkillAssignments(skillId),
    ]);
    if (generation !== detailGeneration.current) return;
    setDetail(skillFromPayload(detailPayload));
    setAssignments(skillAssignmentsFromPayload(assignmentsPayload));
  }, [api]);

  const refreshMachines = useCallback(async () => {
    const loaded = await Promise.all(runners.map(async (runner) => {
      try {
        return [runner.runnerId, await api.runnerSkills(runner.runnerId)] as const;
      } catch {
        // A machine that predates the skills routes reads as never reported rather than an error
        // banner over the whole view.
        return [runner.runnerId, {
          desired: [], reported: null, removalReporting: "unknown",
        } satisfies RunnerSkillsResponse] as const;
      }
    }));
    setMachineSkills(Object.fromEntries(loaded));
  }, [api, runners]);

  useEffect(() => {
    refreshList().catch((cause) => setError((cause as Error).message));
  }, [refreshList]);

  useEffect(() => {
    refreshMachines().catch((cause) => setError((cause as Error).message));
  }, [refreshMachines]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setAssignments([]);
      return;
    }
    refreshDetail(selectedId).catch((cause) => setError((cause as Error).message));
  }, [selectedId, refreshDetail]);

  const grouped = useMemo(() => groupSkillList(skills ?? [], groups), [skills, groups]);

  const mutate = async (work: () => Promise<unknown>, after?: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await after?.();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createSkill = async (input: { name: string; description: string; files: SkillFile[] }) => {
    await mutate(async () => {
      const created = skillFromPayload(await api.createSkill({
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        files: input.files,
      }));
      setDialog(null);
      if (created) setSelectedId(created.id);
    }, async () => {
      await refreshList();
      await refreshMachines();
    });
  };

  const createAssignment = async (input: {
    scopeKind: "instance" | "runner";
    runnerId?: string;
    agentSelector: SkillAgentSelector;
    invocation: SkillInvocationPolicy;
  }) => {
    if (!selectedId) return;
    await mutate(async () => {
      await api.createSkillAssignment({ skillId: selectedId, ...input });
      setDialog(null);
    }, async () => {
      await refreshDetail(selectedId);
      await refreshMachines();
    });
  };

  const deleteSkill = async (skill: SkillSummary) => {
    const confirmed = await confirm({
      title: `Delete “${skill.name}”?`,
      message: "The skill, its versions, and its assignments are removed. The next sync removes it from every machine.",
      confirmLabel: "Delete Skill",
      tone: "danger",
    });
    if (!confirmed) return;
    await mutate(async () => {
      await api.deleteSkill(skill.id);
      setSelectedId(null);
    }, async () => {
      await refreshList();
      await refreshMachines();
    });
  };

  const syncMachine = async (runnerId: string) => {
    setSyncingRunnerId(runnerId);
    setError(null);
    try {
      const reported = await api.syncRunnerSkills(runnerId);
      setMachineSkills((current) => ({
        ...current,
        [runnerId]: {
          desired: current[runnerId]?.desired ?? [],
          reported,
          removalReporting: current[runnerId]?.removalReporting ?? "unknown",
        },
      }));
      await refreshMachines();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSyncingRunnerId(null);
    }
  };

  const latest = detail?.latestVersion ?? null;
  const skillMd = latest?.files?.find((file) => file.path === "SKILL.md" && file.encoding === "utf8");

  return (
    <section className="skills-view">
      <div className="view-heading skills-heading">
        <div>
          <h2>Agent Skills</h2>
          <p>Author a skill once, then assign it to machines and agents. Wollipog deploys the latest version and reports each machine's state.</p>
        </div>
        <button className="btn primary" type="button" onClick={() => setDialog("new-skill")}>New Skill</button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="skills-layout">
        <aside className="skills-list" aria-label="Skills">
          {skills === null && <Skeleton rows={4} announce="Loading skills" />}
          {skills !== null && skills.length === 0 && (
            <Empty
              icon={<SkillsIcon size={28} />}
              title="No Skills Yet"
              headingLevel={3}
              hint="Create a skill to share reusable instructions with the agents on your machines."
              action={
                <button type="button" className="btn primary sm" onClick={() => setDialog("new-skill")}>
                  New Skill
                </button>
              }
            />
          )}
          {grouped.map((group) => (
            <div className="skills-group" key={group.id ?? "ungrouped"}>
              <h3 className="skills-group-title">{group.name}</h3>
              {group.skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className={`skills-item${selectedId === skill.id ? " active" : ""}`}
                  aria-current={selectedId === skill.id ? "true" : undefined}
                  onClick={() => setSelectedId(skill.id)}
                >
                  <span className="skills-item-name">{skill.name}</span>
                  {skill.description && <span className="skills-item-description">{skill.description}</span>}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="skills-detail">
          {!detail && (
            /* Not an empty-state card: nothing is missing here — the pane is simply waiting for a
               list selection, like the Projects manager's own unselected detail column. */
            <div className="skills-empty">
              Select a skill to see its content, assignments, and per-machine deployment.
            </div>
          )}
          {detail && (
            <>
              <div className="skills-detail-head">
                <div>
                  <h3>{detail.name}</h3>
                  {detail.description && <p className="skills-hint">{detail.description}</p>}
                  <p className="skills-meta muted">
                    {latest?.digest ? `Version ${latest.digest.slice(0, 12)}` : "No version recorded"}
                    {" · "}
                    {formatTime(latest?.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={busy}
                  onClick={() => void deleteSkill(detail)}
                >
                  Delete Skill
                </button>
              </div>

              {skillMd && (
                <section className="skills-section" aria-label="Skill Content">
                  <h4>Content</h4>
                  <div className="skills-doc">
                    <Markdown highlightEligible={false}>{skillMarkdownBody(skillMd.content)}</Markdown>
                  </div>
                </section>
              )}

              <section className="skills-section" aria-label="Assignments">
                <div className="skills-section-heading">
                  <h4>Assignments</h4>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => setDialog("add-assignment")}>
                    Add Assignment
                  </button>
                </div>
                {assignments.length === 0 ? (
                  <p className="skills-hint">Not assigned anywhere yet. Add an assignment to deploy this skill.</p>
                ) : (
                  <table className="skills-table">
                    <thead>
                      <tr><th scope="col">Scope</th><th scope="col">Agents</th><th scope="col">Invocation</th><th scope="col">Enabled</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
                    </thead>
                    <tbody>
                      {assignments.map((assignment) => {
                        const runner = assignment.runnerId ? runnersMap.get(assignment.runnerId) : undefined;
                        return (
                          <tr key={assignment.id}>
                            <td>{describeAssignmentScope(assignment, (id) => machineLabels.get(id))}</td>
                            <td>{describeAgentSelector(assignment.agentSelector, runner?.agents ?? [])}</td>
                            <td>
                              <Select<SkillInvocationPolicy>
                                label="Invocation"
                                value={assignment.invocation}
                                disabled={busy}
                                options={[
                                  { value: "agent", label: invocationLabel("agent") },
                                  { value: "manual", label: invocationLabel("manual") },
                                ]}
                                onChange={(value) => void mutate(
                                  () => api.updateSkillAssignment(assignment.id, { invocation: value }),
                                  async () => {
                                    await refreshDetail(detail.id);
                                    await refreshMachines();
                                  },
                                )}
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={assignment.enabled}
                                aria-label="Enabled"
                                className="btn sm"
                                disabled={busy}
                                onClick={() => void mutate(
                                  () => api.updateSkillAssignment(assignment.id, { enabled: !assignment.enabled }),
                                  async () => {
                                    await refreshDetail(detail.id);
                                    await refreshMachines();
                                  },
                                )}
                              >
                                {assignment.enabled ? "On" : "Off"}
                              </button>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn danger sm"
                                disabled={busy}
                                onClick={() => void (async () => {
                                  const confirmed = await confirm({
                                    title: "Remove this assignment?",
                                    message: "The next sync removes the skill from the machines this assignment covered.",
                                    confirmLabel: "Remove Assignment",
                                    tone: "danger",
                                  });
                                  if (!confirmed) return;
                                  await mutate(() => api.deleteSkillAssignment(assignment.id), async () => {
                                    await refreshDetail(detail.id);
                                    await refreshMachines();
                                  });
                                })()}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="skills-section" aria-label="Deployment">
                <h4>Deployment</h4>
                {runners.length === 0 && <p className="skills-hint">Connect a machine to deploy this skill.</p>}
                {runners.map((runner) => {
                  const machine = machineSkills[runner.runnerId];
                  const desired = machine?.desired.find((entry) => entry.name === detail.name);
                  const badge = skillDeployBadge({
                    runnerOnline: runner.status === "online",
                    desired,
                    reported: machine?.reported,
                    skillName: detail.name,
                  });
                  const unmanaged = reportedUnmanagedSkills(machine?.reported);
                  const removals = reportedSkillLinkRemovals(machine?.reported);
                  const removalReporting = machine?.removalReporting ?? "unknown";
                  return (
                    <article className="skills-machine" key={runner.runnerId}>
                      <div className="skills-machine-head">
                        <strong>{machineLabels.get(runner.runnerId) ?? runner.runnerId}</strong>
                        <span className={`status-badge ${badge.className}`} title={badge.detail}>
                          <span className="status-dot2" aria-hidden="true" />
                          {badge.label}
                        </span>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={runner.status !== "online" || syncingRunnerId !== null}
                          onClick={() => void syncMachine(runner.runnerId)}
                        >
                          {syncingRunnerId === runner.runnerId ? "Syncing…" : "Sync Now"}
                        </button>
                      </div>
                      {badge.detail && <p className="skills-hint">{badge.detail}</p>}
                      {unmanaged.length > 0 && (
                        <div className="skills-unmanaged">
                          <h5>Unmanaged Skills</h5>
                          <ul>
                            {unmanaged.map((entry) => (
                              <li key={`${entry.agentId}:${entry.name}`}>
                                <strong>{entry.name}</strong>
                                <span className="muted"> · {entry.agentId}</span>
                                {entry.description && <span className="muted"> — {entry.description}</span>}
                              </li>
                            ))}
                          </ul>
                          <p className="skills-hint">
                            These skills live on the machine but are not managed here. Adopting them into the library arrives later.
                          </p>
                        </div>
                      )}
                      {machine && (removals.length > 0 || removalReporting !== "unknown") && (
                        <div className="skills-removals">
                          <h5>Recent Link Removals</h5>
                          {removalReporting === "unsupported" && (
                            <p className="skills-hint">
                              This runner version cannot report new managed link removals.
                            </p>
                          )}
                          {removalReporting === "supported" && removals.length === 0 && (
                            <p className="skills-hint">No managed link removals have been reported.</p>
                          )}
                          {removals.length > 0 && (
                            <>
                              <p className="skills-hint">
                                Reported {formatTime(machine.reported?.removalsUpdatedAt ?? machine.reported?.updatedAt)}
                              </p>
                              <ul>
                                {removals.map((entry, index) => (
                                  <li key={`${entry.path}:${entry.reason}:${index}`}>
                                    <strong>{entry.path}</strong>
                                    <span className="muted"> — {entry.reason}</span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </section>
            </>
          )}
        </div>
      </div>

      {dialog === "new-skill" && (
        <NewSkillDialog busy={busy} onClose={() => setDialog(null)} onCreate={createSkill} />
      )}
      {dialog === "add-assignment" && detail && (
        <AddAssignmentDialog
          skill={detail}
          runners={runners}
          machineLabels={machineLabels}
          busy={busy}
          onClose={() => setDialog(null)}
          onCreate={createAssignment}
        />
      )}
    </section>
  );
}
