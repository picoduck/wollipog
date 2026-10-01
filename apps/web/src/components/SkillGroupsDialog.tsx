import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { IdentityAdministrationView, ResourceScope, RunnerView, SkillInvocationPolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { invocationLabel, skillGroupsFromPayload, skillsFromPayload, type SkillGroupAssignmentView, type SkillGroupView, type SkillSummary } from "../skills.js";
import { useAccessScopeIdentity } from "./AccessScopeControls.js";
import { type ConfirmationDetailRow, useFeedback } from "./FeedbackProvider.js";
import { ChevronDownIcon, MoreHorizontalIcon, PlusIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { AddAssignmentDialog, type AddAssignmentInput } from "./SkillAssignmentDialog.js";
import { AssignmentRuleRow, assignmentRuleTitle } from "./SkillAssignments.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SAVED_MS } from "./ui/SettingsRows.js";
import { useIsMobile } from "./useIsMobile.js";

type Identity = IdentityAdministrationView | null;

/** Who a group belongs to, as a label: "Shared with your organization", "Shared with Platform",
 * "Only you". Never an id: a team the identity does not name is "a team". */
export function groupOwnership(scope: ResourceScope, identity: Identity): string {
  const owner = scope.owner;
  if (owner.kind === "organization") return "Shared with your organization";
  if (owner.kind === "team") return `Shared with ${identity?.teams.find((team) => team.teamId === owner.teamId)?.name ?? "a team"}`;
  return identity && identity.context.userId !== owner.userId ? "Only its owner" : "Only you";
}

/** The same ownership inside a sentence: "shared with your organization", "visible only to you". */
function ownershipInSentence(scope: ResourceScope, identity: Identity): string {
  return scope.owner.kind === "user" ? "visible only to you" : `s${groupOwnership(scope, identity).slice(1)}`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const quoted = (name: string) => `“${name}”`;

/** Library state as Manage Groups last read it. */
interface Library {
  groups: SkillGroupView[];
  skills: SkillSummary[];
  /** Who a group created now would belong to; null without a signed-in person. */
  creationScope: ResourceScope | null;
}

/** One group's rules as last read. `rules` is null while the first read runs or after a failure. */
interface GroupRules {
  groupId: string;
  rules: SkillGroupAssignmentView[] | null;
  error: string | null;
}

/** The control whose change is running; every other change waits for it. */
type Pending =
  | "create" | "add-member" | "convert" | "delete" | "add-rule"
  | `remove-member:${string}` | `rule:${string}:${"enabled" | "invocation"}` | `remove-rule:${string}`;

/**
 * Manage Groups (#1985): a full-height `.modal.lg` with the groups on the left and the selected
 * group on the right: its ownership in words, its members and its assignments. Every change that
 * deploys or removes skills asks first, in the shared confirmation, naming the group and the skills
 * it affects; deleting a group asks for its name. A running change shows on the control that made
 * it, and a refused one as a danger notice above the footer. On a phone the list and the group are
 * two steps of one sheet, with Back.
 */
export function SkillGroupsDialog({ runners, machineLabels, initialGroupId, onClose, onChanged }: {
  runners: RunnerView[]; machineLabels: Map<string, string>;
  /** The group to open at: a skill's Edit in Groups… (#1982). */
  initialGroupId?: string;
  onClose: () => void; onChanged: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const phone = useIsMobile();
  const [library, setLibrary] = useState<Library | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialGroupId ?? "");
  const [step, setStep] = useState<"list" | "detail">(initialGroupId ? "detail" : "list");
  const [groupRules, setGroupRules] = useState<GroupRules | null>(null);
  const [rulesRevision, setRulesRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPendingState] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const setPending = (next: Pending | null) => { pendingRef.current = next; setPendingState(next); };
  const [error, setError] = useState<string | null>(null);
  /** What the last change did, for a screen reader only: the lists themselves show it. */
  const [announcement, setAnnouncement] = useState("");
  const [savedRule, setSavedRule] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (savedTimer.current !== null) window.clearTimeout(savedTimer.current); }, []);

  const groups = library?.groups ?? [];
  const skills = library?.skills ?? [];
  const { identity } = useAccessScopeIdentity([library?.creationScope, ...groups.map((group) => group.scope)]
    .some((scope) => scope?.owner.kind === "team" || scope?.owner.kind === "user"));

  // Only the newest read is shown, so a slow older read never replaces a newer one.
  const loadToken = useRef(0);
  const load = useCallback(async () => {
    const token = ++loadToken.current;
    const [groupPayload, skillPayload] = await Promise.all([api.listSkillGroups(), api.listSkills()]);
    if (token !== loadToken.current) return;
    setLibrary({
      groups: skillGroupsFromPayload(groupPayload),
      skills: skillsFromPayload(skillPayload),
      creationScope: !Array.isArray(groupPayload) ? groupPayload.creationScope ?? null : null,
    });
    setLoadError(null);
  }, [api]);
  const firstLoad = useCallback(() => {
    const token = loadToken.current + 1;
    load().catch((cause) => { if (loadToken.current === token) setLoadError((cause as Error).message); });
  }, [load]);
  useEffect(() => { firstLoad(); }, [firstLoad]);

  // The selected group, or the first one: on desktop the detail is never empty (§6.1). A group that
  // went away (deleted elsewhere) gives way to the first.
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0] ?? null;
  const exactlySelected = groups.some((group) => group.id === selectedId);
  const showList = !phone || step === "list" || !exactlySelected;
  const showDetail = (!phone || !showList) && selected !== null;

  useEffect(() => {
    const groupId = selected?.id;
    const owned = Boolean(selected?.scope);
    if (!groupId || !owned) { setGroupRules(null); return; }
    let active = true;
    // A reload of the same group keeps its rules on screen, so the body does not jump.
    setGroupRules((current) => current?.groupId === groupId ? current : { groupId, rules: null, error: null });
    api.listSkillGroupAssignments(groupId).then((result) => {
      if (active) setGroupRules({ groupId, rules: result.assignments, error: null });
    }).catch((cause) => {
      if (active) setGroupRules({ groupId, rules: null, error: (cause as Error).message });
    });
    return () => { active = false; };
  }, [api, selected?.id, Boolean(selected?.scope), rulesRevision]);
  // An owned group's rules are loading until its first read lands, so the section is never missing.
  const rules = !selected?.scope ? null
    : groupRules?.groupId === selected.id ? groupRules : { groupId: selected.id, rules: null, error: null };

  // ---- Focus: a change that unmounts the focused control (a removed member's Remove…, a deleted
  // group, a phone pane) would drop focus on the page behind the sheet. After every commit, focus
  // that was lost from this dialog moves to the next control the change names, or the default one;
  // while that control is disabled by the running change, the dialog holds it. Focus that is
  // somewhere is never moved.
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const focusInside = useRef(false);
  const rescuing = useRef(false);
  const nextFocus = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useLayoutEffect(() => {
    dialogRef.current = bodyRef.current?.closest<HTMLElement>('[role="dialog"]') ?? dialogRef.current;
  });
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      focusInside.current = Boolean(dialog && event.target instanceof Node && dialog.contains(event.target));
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const defaultFocus = (): HTMLElement | null | undefined => {
    if (phone && !showList) return dialogRef.current?.querySelector<HTMLElement>(".modal-back");
    return listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
      ?? listRef.current?.querySelector<HTMLElement>(".skill-groups-list > .row")
      ?? dialogRef.current?.querySelector<HTMLElement>("[data-group-control='new']");
  };
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.isConnected) return;
    const active = document.activeElement;
    // A focused control that a change disabled (Add Skill once no skill is left to add) loses focus
    // at the browser's next focus fixup, with no event to say so: treat it as lost now.
    const lost = !active || active === document.body || !active.isConnected || (active as HTMLButtonElement).disabled === true;
    if (lost && focusInside.current) rescuing.current = true;
    if (rescuing.current) {
      if (!lost && active !== dialog) {
        rescuing.current = false;
      } else {
        const target = nextFocus.current?.() ?? defaultFocus();
        target?.focus();
        if (target && document.activeElement === target) rescuing.current = false;
        else if (document.activeElement !== dialog) dialog.focus();
      }
    }
    if (!rescuing.current && pendingRef.current === null) nextFocus.current = null;
  });

  // ---- Changes. One at a time; each refreshes the groups, the skills and the group's rules.
  const change = async (key: Pending, work: () => Promise<void>, outcome: string,
    focusAfter?: () => HTMLElement | null | undefined): Promise<boolean> => {
    if (pendingRef.current !== null) return false;
    setPending(key);
    setError(null);
    nextFocus.current = focusAfter ?? null;
    try {
      // A confirmation hands focus back to the control that opened it on its next task. Waiting for
      // that means a fast answer can't remove that control first and leave focus nowhere.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await work();
    } catch (cause) {
      setPending(null);
      setError((cause as Error).message);
      return false;
    }
    let refreshFailed = false;
    try {
      await load();
      setRulesRevision((revision) => revision + 1);
      await onChanged();
    } catch {
      refreshFailed = true;
    }
    setPending(null);
    setAnnouncement(outcome);
    if (refreshFailed) setError("The change was saved, but this dialog couldn't refresh. Close it and open it again before another change.");
    return true;
  };
  const busy = pending !== null;
  const control = (selector: string, index = 0) => {
    const all = detailRef.current?.querySelectorAll<HTMLElement>(selector) ?? [];
    return all[Math.min(index, all.length - 1)] ?? null;
  };

  const members = selected ? skills.filter((skill) => skill.groupId === selected.id) : [];
  const ungrouped = skills.filter((skill) => !skill.groupId);
  const ruleTitle = (rule: SkillGroupAssignmentView) => assignmentRuleTitle(rule, runners, machineLabels);
  const ruleRows = (): ConfirmationDetailRow[] => (rules?.rules ?? []).map((rule) => ({
    label: ruleTitle(rule),
    meta: rule.enabled ? invocationLabel(rule.invocation) : "Turned Off",
  }));
  const memberRows = (): ConfirmationDetailRow[] => members.map((skill) => ({ label: skill.name }));

  const createGroup = async () => {
    const name = newName.trim();
    if (!name || !library?.creationScope) return;
    // The new group opens before the refresh lists it, so the next step is adding its skills.
    await change("create", async () => {
      const created = (await api.createSkillGroup({ name })).group;
      setSelectedId(created.id);
      setStep("detail");
      setCreating(false);
      setNewName("");
    }, `Created ${name}.`, () => control("[data-group-control='add-skill']:not(:disabled)")
      ?? control("[data-group-control='add-rule']"));
  };
  const cancelCreate = () => {
    nextFocus.current = () => dialogRef.current?.querySelector<HTMLElement>("[data-group-control='new']");
    setCreating(false);
    setNewName("");
  };

  const addMember = async (group: SkillGroupView, skill: SkillSummary) => {
    const owned = Boolean(group.scope);
    const rows = owned ? ruleRows() : [];
    const message = !owned
      ? `${quoted(skill.name)} joins ${quoted(group.name)}. The group has no owner, so it doesn't deploy anything.`
      : rules?.rules && rules.rules.length === 0
        ? `${quoted(skill.name)} joins ${quoted(group.name)}. The group has no assignments yet, so nothing deploys until it has one.`
        : `${quoted(skill.name)} joins ${quoted(group.name)} and starts deploying under the group's assignments${rows.length ? ", listed below" : ""}.`;
    if (!await confirm({ title: "Add Skill to Group", message, detailRows: rows, confirmLabel: "Add Skill" })) return;
    await change("add-member", () => api.updateSkill(skill.id, { groupId: group.id }).then(() => undefined),
      `Added ${skill.name} to ${group.name}.`,
      () => control("[data-group-control='add-skill']:not(:disabled)") ?? control("[data-group-control='remove-member']", Infinity));
  };

  const removeMember = async (group: SkillGroupView, skill: SkillSummary, index: number) => {
    const rows = group.scope ? ruleRows() : [];
    const message = rows.length
      ? `${quoted(skill.name)} leaves ${quoted(group.name)} and is removed from the machines these assignments deployed it to, unless its own assignments keep it there. The skill, its direct assignments and its version pins stay.`
      : `${quoted(skill.name)} leaves ${quoted(group.name)}. The group has no assignments, so nothing is removed from any machine.`;
    if (!await confirm({ title: "Remove Skill from Group", message, detailRows: rows, confirmLabel: "Remove Skill", tone: "danger" })) return;
    await change(`remove-member:${skill.id}`, () => api.updateSkill(skill.id, { groupId: null }).then(() => undefined),
      `Removed ${skill.name} from ${group.name}.`,
      () => control("[data-group-control='remove-member']", index) ?? control("[data-group-control='add-skill']"));
  };

  const setRule = async (group: SkillGroupView, rule: SkillGroupAssignmentView, patch: { enabled?: boolean; invocation?: SkillInvocationPolicy }) => {
    const done = await change(`rule:${rule.id}:${patch.invocation ? "invocation" : "enabled"}`, () => api.updateSkillGroupAssignment(group.id, rule.id, patch).then(() => undefined),
      `${ruleTitle(rule)} saved.`);
    if (!done) return;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSavedRule(rule.id);
    savedTimer.current = window.setTimeout(() => { savedTimer.current = null; setSavedRule(null); }, SAVED_MS);
  };

  const removeRule = async (group: SkillGroupView, rule: SkillGroupAssignmentView, index: number) => {
    const title = ruleTitle(rule);
    const message = members.length
      ? `The next sync removes the skills in ${quoted(group.name)} from ${title}, unless another assignment keeps them there.`
      : `${quoted(group.name)} has no skills, so removing ${title} takes nothing off any machine.`;
    if (!await confirm({ title: "Remove Group Assignment", message, detailRows: memberRows(), confirmLabel: "Remove Assignment", tone: "danger" })) return;
    // The row goes as soon as the server agrees, while its ⋯ is still busy, so focus can follow it.
    await change(`remove-rule:${rule.id}`, async () => {
      await api.deleteSkillGroupAssignment(group.id, rule.id);
      setGroupRules((current) => current?.groupId === group.id && current.rules
        ? { ...current, rules: current.rules.filter((candidate) => candidate.id !== rule.id) } : current);
    },
      `Removed ${title} from ${group.name}.`,
      () => control("[data-rule-control='more']", index) ?? control("[data-group-control='add-rule']"));
  };

  const convertGroup = async (group: SkillGroupView) => {
    const scope = library?.creationScope;
    if (!scope) return;
    const message = `${quoted(group.name)} becomes ${ownershipInSentence(scope, identity)} for good, and anyone outside that loses access to it. Its skills must already have that owner; none of them changes owner.`;
    if (!await confirm({ title: "Convert Group", message, detailRows: memberRows(), confirmLabel: "Convert Group", tone: "danger" })) return;
    await change("convert", () => api.convertSkillGroup(group.id).then(() => undefined), `Converted ${group.name}.`,
      () => control("[data-group-control='add-skill']:not(:disabled)") ?? control("[data-group-control='more']"));
  };

  const deleteGroup = async (group: SkillGroupView) => {
    const ruleCount = group.scope ? rules?.rules?.length ?? 0 : 0;
    const subject = ruleCount ? `${quoted(group.name)} and its ${plural(ruleCount, "assignment")} are` : `${quoted(group.name)} is`;
    const message = members.length
      ? `${subject} deleted, and its ${plural(members.length, "skill")} stop deploying through it. The skills, their direct assignments and their version pins stay.`
      : `${subject} deleted. It has no skills, so nothing is removed from any machine.`;
    if (!await confirm({
      title: "Delete Group", message, detailRows: memberRows(), confirmLabel: "Delete Group", tone: "danger", typeToConfirm: group.name,
    })) return;
    const index = groups.findIndex((candidate) => candidate.id === group.id);
    const neighbour = groups[index + 1] ?? groups[index - 1];
    // The next group takes its place (a phone returns to the list), and focus goes to its row.
    await change("delete", async () => {
      await api.deleteSkillGroup(group.id);
      setSelectedId(neighbour?.id ?? "");
      setStep("list");
    }, `Deleted ${group.name}.`, () => listRef.current?.querySelector<HTMLElement>('[aria-current="true"]'));
  };

  const addRule = async (group: SkillGroupView, input: AddAssignmentInput) => {
    setAddError(null);
    if (pendingRef.current !== null) return;
    setPending("add-rule");
    try {
      await api.createSkillGroupAssignment(group.id, input);
    } catch (cause) {
      setPending(null);
      setAddError((cause as Error).message);
      return;
    }
    let refreshFailed = false;
    try {
      await load();
      setRulesRevision((revision) => revision + 1);
      await onChanged();
    } catch {
      refreshFailed = true;
    }
    // Closing returns focus to Add Assignment…, which is enabled again in the same commit.
    setPending(null);
    setAdding(false);
    setAnnouncement(`Added an assignment to ${group.name}.`);
    if (refreshFailed) setError("The change was saved, but this dialog couldn't refresh. Close it and open it again before another change.");
  };

  const close = () => { if (pendingRef.current === null) onClose(); };
  const choose = (group: SkillGroupView) => {
    if (busy) return;
    setSelectedId(group.id);
    setStep("detail");
  };

  const newGroupForm = creating && (
    <form className="skill-groups-new" onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
      <div className="field">
        <div className="field-head"><label htmlFor="skill-groups-new-name">Group Name</label></div>
        <input id="skill-groups-new-name" value={newName} maxLength={120} autoFocus autoComplete="off" readOnly={pending === "create"}
          aria-describedby={library?.creationScope ? "skill-groups-new-owner" : undefined}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || pending === "create") return;
            // Escape leaves the name field, not the dialog.
            event.preventDefault();
            cancelCreate();
          }} />
        {library?.creationScope && <p className="field-helper" id="skill-groups-new-owner">{`New groups are ${ownershipInSentence(library.creationScope, identity)}.`}</p>}
      </div>
      <div className="actions">
        <button type="button" className="btn ghost sm" disabled={pending === "create"} onClick={cancelCreate}>Cancel</button>
        <BusyButton type="submit" className="btn primary sm" busy={pending === "create"} progress="Creating the group…"
          disabled={!newName.trim() || (busy && pending !== "create")}>Create Group</BusyButton>
      </div>
    </form>
  );
  const newGroupButton = (
    <button type="button" className="btn ghost sm" data-group-control="new" disabled={busy || creating || !library?.creationScope}
      aria-describedby={library && !library.creationScope ? "skill-groups-create-reason" : undefined}
      onClick={() => { setError(null); setCreating(true); }}>
      <PlusIcon size={14} />New Group
    </button>
  );
  const createReason = library && !library.creationScope && (
    <p className="skill-groups-note" id="skill-groups-create-reason">Only a signed-in person can create a group.</p>
  );

  let content: ReactNode;
  if (!library) {
    content = loadError
      ? <Notice tone="danger" title="Couldn't Load Groups" role="alert"
        actions={<button type="button" className="btn sm" onClick={firstLoad}>Retry</button>}>{loadError}</Notice>
      : <div className="skill-groups-loading" role="status">
        <span className="sr-only">Loading groups…</span>
        <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
      </div>;
  } else if (groups.length === 0) {
    content = <div className="skill-groups-empty">
      <h3>No Groups Yet</h3>
      <p>A group deploys its skills together, under assignments it shares with every skill in it.</p>
      {creating ? newGroupForm : <div className="actions">{newGroupButton}</div>}
      {createReason}
    </div>;
  } else {
    const list = <div className="skill-groups-pane list" ref={listRef}>
      <div className="skill-groups-list-head">
        <span className="skill-groups-label" id="skill-groups-list-label">Groups</span>
        {newGroupButton}
      </div>
      {newGroupForm}
      {createReason}
      <div className="surface skill-groups-list" role="group" aria-labelledby="skill-groups-list-label">
        {groups.map((group) => {
          const count = skills.filter((skill) => skill.groupId === group.id).length;
          const isSelected = !phone && group.id === selected?.id;
          return <button key={group.id} type="button" className={`row${isSelected ? " is-selected" : ""}`}
            aria-current={isSelected || undefined} disabled={busy} onClick={() => choose(group)}>
            <span className="row-body"><span className="row-title" title={group.name}>{group.name}</span></span>
            <span className="row-trail">{group.scope ? (count ? plural(count, "skill") : "No skills") : "No owner"}</span>
          </button>;
        })}
      </div>
    </div>;
    const detail = selected && <div className="skill-groups-pane detail" ref={detailRef} key={selected.id}>
      <GroupDetail
        group={selected}
        ownership={selected.scope ? groupOwnership(selected.scope, identity) : null}
        conversion={library.creationScope ? ownershipInSentence(library.creationScope, identity) : null}
        members={members}
        ungrouped={ungrouped}
        rules={rules}
        ruleTitle={ruleTitle}
        pending={pending}
        savedRule={savedRule}
        onAddMember={(skill) => void addMember(selected, skill)}
        onRemoveMember={(skill, index) => void removeMember(selected, skill, index)}
        onSetRule={(rule, patch) => void setRule(selected, rule, patch)}
        onRemoveRule={(rule, index) => void removeRule(selected, rule, index)}
        onRetryRules={() => setRulesRevision((revision) => revision + 1)}
        onAddRule={() => { setAddError(null); setAdding(true); }}
        onConvert={() => void convertGroup(selected)}
        onDelete={() => void deleteGroup(selected)}
      />
    </div>;
    content = <div className="skill-groups-panes">
      {showList && list}
      {showDetail && detail}
    </div>;
  }

  return <>
    <Modal title="Manage Groups" size="lg" className="skill-groups" onClose={close}
      back={phone && !showList ? { label: "Back to Groups", onBack: () => setStep("list") } : undefined}
      footer={<button type="button" className="btn" disabled={busy} onClick={close}>Done</button>}>
      <div className="skill-groups-body" ref={bodyRef}>
        {content}
        {error && <Notice tone="danger" role="alert" className="skill-groups-error">{error}</Notice>}
        <span className="sr-only" role="status">{announcement}</span>
      </div>
    </Modal>
    {/* Stacked over Manage Groups under one dim (§7.1); closing it returns to the same group, with
        focus on Add Assignment…. */}
    {adding && selected && <AddAssignmentDialog variant="group" groupName={selected.name} runners={runners} machineLabels={machineLabels}
      busy={pending === "add-rule"} error={addError}
      onClose={() => { if (pendingRef.current !== "add-rule") { setAdding(false); setAddError(null); } }}
      onCreate={(input) => addRule(selected, input)} />}
  </>;
}

interface GroupDetailProps {
  group: SkillGroupView;
  /** The group's ownership as a label, or null for a legacy group without an owner. */
  ownership: string | null;
  /** What converting would make the group, inside a sentence; null when no one can convert it. */
  conversion: string | null;
  members: SkillSummary[];
  ungrouped: SkillSummary[];
  /** Null for a legacy group, which has no rules. */
  rules: GroupRules | null;
  ruleTitle: (rule: SkillGroupAssignmentView) => string;
  pending: Pending | null;
  savedRule: string | null;
  onAddMember: (skill: SkillSummary) => void;
  onRemoveMember: (skill: SkillSummary, index: number) => void;
  onSetRule: (rule: SkillGroupAssignmentView, patch: { enabled?: boolean; invocation?: SkillInvocationPolicy }) => void;
  onRemoveRule: (rule: SkillGroupAssignmentView, index: number) => void;
  onRetryRules: () => void;
  onAddRule: () => void;
  onConvert: () => void;
  onDelete: () => void;
}

/** The selected group: its name and ownership with a ⋯ (Delete Group…), then Members and Group
 * Assignments, each a section whose one action sits in its title row (§3.3). */
function GroupDetail(props: GroupDetailProps) {
  const { group, ownership, members, ungrouped, rules, pending } = props;
  const busy = pending !== null;
  return <>
    <div className="skill-groups-head">
      <div className="skill-groups-heading">
        <h3 className="skill-groups-name">{group.name}</h3>
        {ownership && <p className="skill-groups-owner">{ownership}</p>}
      </div>
      <GroupActionsMenu name={group.name} busy={pending === "delete"} disabled={busy} onDelete={props.onDelete} />
    </div>
    {!group.scope && <Notice tone="warning" title="This Group Has No Owner"
      actions={<>
        <BusyButton className="btn sm" data-group-control="convert" busy={pending === "convert"} progress="Converting the group…"
          disabled={!props.conversion || (busy && pending !== "convert")} onClick={props.onConvert}>Convert Group…</BusyButton>
      </>}>
      {props.conversion
        ? `It's a label from an older version, so it can't have assignments. Converting makes it ${props.conversion}.`
        : "It's a label from an older version, so it can't have assignments. Only a signed-in person can convert it."}
    </Notice>}
    <section className="skill-groups-section" aria-labelledby={`${group.id}-members`}>
      <div className="skill-groups-section-head">
        <h4 id={`${group.id}-members`}>Members</h4>
        <AddSkillMenu skills={ungrouped} busy={pending === "add-member"} disabled={busy} onAdd={props.onAddMember} />
      </div>
      <ul className="surface skill-groups-members">
        {members.length === 0
          ? <li className="row skill-groups-empty-row">No skills in this group.</li>
          : members.map((skill, index) => <li className="row" key={skill.id}>
            <span className="row-body"><span className="row-title" id={`${group.id}-member-${index}`} title={skill.name}>{skill.name}</span></span>
            <BusyButton className="btn ghost sm" data-group-control="remove-member" aria-describedby={`${group.id}-member-${index}`}
              busy={pending === `remove-member:${skill.id}`} progress={`Removing ${skill.name}…`}
              disabled={busy && pending !== `remove-member:${skill.id}`} onClick={() => props.onRemoveMember(skill, index)}>
              Remove…
            </BusyButton>
          </li>)}
      </ul>
      {ungrouped.length === 0 && <p className="skill-groups-note">Every skill is already in a group, so there are none to add.</p>}
    </section>
    {rules && <section className="skill-groups-section" aria-labelledby={`${group.id}-rules`}>
      <div className="skill-groups-section-head">
        <h4 id={`${group.id}-rules`}>Group Assignments</h4>
        <button type="button" className="btn sm" data-group-control="add-rule" disabled={busy || rules.rules === null}
          onClick={props.onAddRule}>Add Assignment…</button>
      </div>
      {rules.error
        ? <Notice tone="danger" title="Couldn't Load the Group's Assignments" role="alert"
          actions={<button type="button" className="btn sm" onClick={props.onRetryRules}>Retry</button>}>{rules.error}</Notice>
        : rules.rules === null
          ? <div className="skill-groups-loading" role="status"><span className="sr-only">Loading the group's assignments…</span><div className="skeleton-row" /></div>
          : <div className="surface skill-assignments">
            <ul className="skill-assignment-list" aria-label="Group Assignments">
              {rules.rules.length === 0
                ? <li className="skill-assignment is-empty">No assignments. Add one to deploy this group's skills.</li>
                : rules.rules.map((rule, index) => <AssignmentRuleRow
                  key={rule.id}
                  rule={rule}
                  title={props.ruleTitle(rule)}
                  offDescription="Group assignment, turned off"
                  busy={busy}
                  saving={pending === `rule:${rule.id}:enabled` || pending === `rule:${rule.id}:invocation`}
                  invocationSaving={pending === `rule:${rule.id}:invocation`}
                  saved={props.savedRule === rule.id}
                  removing={pending === `remove-rule:${rule.id}`}
                  inlineMenus
                  onSetInvocation={(invocation) => props.onSetRule(rule, { invocation })}
                  onSetEnabled={(enabled) => props.onSetRule(rule, { enabled })}
                  onRemove={() => props.onRemoveRule(rule, index)}
                />)}
            </ul>
          </div>}
    </section>}
  </>;
}

/** Add Skill: a menu of the skills in no group. Choosing one confirms before it joins. */
function AddSkillMenu({ skills, busy, disabled, onAdd }: {
  skills: SkillSummary[]; busy: boolean; disabled: boolean; onAdd: (skill: SkillSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-groups-add");
  return <>
    <BusyButton ref={menu.triggerRef} className="btn sm" data-group-control="add-skill" busy={busy} progress="Adding the skill…"
      disabled={(disabled && !busy) || skills.length === 0} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menu.menuId : undefined} onClick={menu.toggle} onKeyDown={menu.onTriggerKeyDown}>
      Add Skill<ChevronDownIcon size={14} />
    </BusyButton>
    {open && <MenuSurface surfaceRef={menu.menuRef} anchor={{ trigger: menu.triggerRef }} id={menu.menuId} label="Add Skill"
      align="end" inline onDismiss={() => menu.close(true)} onKeyDown={menu.onMenuKeyDown}>
      {skills.map((skill) => <MenuItem key={skill.id} onClick={() => {
        // The confirmation returns focus to Add Skill, which it records as its opener.
        menu.triggerRef.current?.focus();
        menu.close(false);
        onAdd(skill);
      }}>{skill.name}</MenuItem>)}
    </MenuSurface>}
  </>;
}

/** The group's ⋯: Delete Group…, which asks for the group's name. */
function GroupActionsMenu({ name, busy, disabled, onDelete }: { name: string; busy: boolean; disabled: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-groups-more");
  const label = `More Actions for ${name}`;
  return <>
    <BusyButton ref={menu.triggerRef} className="icon-btn" data-group-control="more" title="More Actions" aria-label={label}
      busy={busy} progress={`Deleting ${name}…`} disabled={disabled && !busy} icon={<MoreHorizontalIcon />}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menu.menuId : undefined}
      onClick={menu.toggle} onKeyDown={menu.onTriggerKeyDown}>
      {null}
    </BusyButton>
    {open && <MenuSurface surfaceRef={menu.menuRef} anchor={{ trigger: menu.triggerRef }} id={menu.menuId} label={name}
      align="end" inline onDismiss={() => menu.close(true)} onKeyDown={menu.onMenuKeyDown}>
      <MenuItem danger onClick={() => {
        menu.triggerRef.current?.focus();
        menu.close(false);
        onDelete();
      }}>Delete Group…</MenuItem>
    </MenuSurface>}
  </>;
}
