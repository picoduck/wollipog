import { useId, useLayoutEffect, useRef, useState } from "react";
import type { RunnerView, SkillInvocationPolicy } from "@wollipog/protocol";
import { skillRuleUnreachableAgents, type SkillRule } from "../skill-assignment-matrix.js";
import {
  describeAgentSelector,
  describeAssignmentScope,
  invocationLabel,
  type SkillAssignmentView,
  type SkillGroupAssignmentView,
  type SkillGroupView,
} from "../skills.js";
import { CheckIcon, ChevronDownIcon, MoreHorizontalIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { SkillDetailSection } from "./SkillDetailHeader.js";
import { INVOCATION_HELP } from "./SkillAssignmentDialog.js";
import { listText } from "./SkillNoticeSlot.js";
import { Switch } from "./ui/SettingsRows.js";

const INVOCATIONS: ReadonlyArray<SkillInvocationPolicy> = ["agent", "manual"];

type RuleTarget = Pick<SkillAssignmentView, "scopeKind" | "runnerId" | "agentSelector">;

/** A rule as one phrase: "All Agents on All Machines", "Codex (Command Line) on Studio Workstation". */
export function assignmentRuleTitle(rule: RuleTarget, runners: ReadonlyArray<RunnerView>,
  machineLabels: ReadonlyMap<string, string>): string {
  // A machine's rule names its own agents; an instance-wide rule can name an agent on any machine.
  const agents = rule.scopeKind === "runner"
    ? runners.find((runner) => runner.runnerId === rule.runnerId)?.agents ?? []
    : runners.flatMap((runner) => runner.agents);
  return `${describeAgentSelector(rule.agentSelector, agents)} on ${describeAssignmentScope(rule, (id) => machineLabels.get(id))}`;
}

/** Agent Invocable or Manual Only, as a small select trigger over a §9.1 radio-like menu whose two
 * items say what each means. Choosing the current value changes nothing. */
export function InvocationMenu({ value, describedBy, disabled, onChange }: {
  value: SkillInvocationPolicy;
  /** The rule's title, so each row's trigger says which rule it changes. */
  describedBy?: string;
  disabled?: boolean;
  onChange: (invocation: SkillInvocationPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-invocation-menu");
  const choose = (invocation: SkillInvocationPolicy) => {
    menu.close(true);
    if (invocation !== value) onChange(invocation);
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm"
        data-rule-control="invocation"
        aria-label={`Invocation: ${invocationLabel(value)}`}
        aria-describedby={describedBy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        disabled={disabled}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        {invocationLabel(value)}
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Invocation"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {INVOCATIONS.map((invocation) => (
            <MenuItem
              key={invocation}
              role="menuitemradio"
              checked={invocation === value}
              description={INVOCATION_HELP[invocation]}
              onClick={() => choose(invocation)}
            >
              {invocationLabel(invocation)}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </>
  );
}

/** A rule's ⋯, holding Remove Assignment…, which confirms before anything is removed. */
function RuleActionsMenu({ title, disabled, onRemove }: { title: string; disabled?: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-assignment-menu");
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm"
        data-rule-control="more"
        title="More Actions"
        aria-label={`More Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        disabled={disabled}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <MoreHorizontalIcon />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={title}
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem
            danger
            onClick={() => {
              // Focus is back on ⋯ before the confirmation opens, so closing it returns here.
              menu.close(false);
              menu.triggerRef.current?.focus();
              onRemove();
            }}
          >
            Remove Assignment…
          </MenuItem>
        </MenuSurface>
      )}
    </>
  );
}

export interface AssignmentRuleRowProps {
  rule: Pick<SkillAssignmentView, "id" | "scopeKind" | "runnerId" | "agentSelector" | "enabled" | "invocation">;
  title: string;
  /** The line under the title while the rule is turned off ("Direct assignment, turned off"). */
  offDescription: string;
  /** Another change is saving, so this row waits. */
  busy: boolean;
  /** This row's own change is in flight, and whether its "Saved" check shows (§8.6). */
  saving: boolean;
  saved: boolean;
  onSetInvocation: (invocation: SkillInvocationPolicy) => void;
  onSetEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}

/**
 * One editable assignment rule (#1982): its title as one phrase, then its invocation, an Enabled
 * switch and ⋯ (Remove Assignment…). Both controls apply at once and show "Saved" for 2s once the
 * server confirms. A turned-off rule is dimmed and says so. Under a 560px container the controls
 * wrap below the title.
 */
export function AssignmentRuleRow({ rule, title, offDescription, busy, saving, saved, onSetInvocation, onSetEnabled, onRemove }: AssignmentRuleRowProps) {
  const id = useId().replace(/:/g, "");
  const titleId = `${id}-title`;
  return (
    <li className={`skill-assignment${rule.enabled ? "" : " is-off"}`} data-assignment-id={rule.id}>
      <div className="skill-assignment-text">
        <span className="skill-assignment-title" id={titleId}>{title}</span>
        {!rule.enabled && <span className="skill-assignment-desc">{offDescription}</span>}
      </div>
      <div className="skill-assignment-controls">
        <InvocationMenu value={rule.invocation} describedBy={titleId} disabled={busy} onChange={onSetInvocation} />
        <Switch
          label="Enabled"
          describedBy={titleId}
          checked={rule.enabled}
          disabled={busy && !saving}
          busy={saving}
          className="ui-switch-standalone skill-assignment-enabled"
          onChange={onSetEnabled}
        >
          Enabled
        </Switch>
        {saved && <span className="ui-row-saved" aria-hidden="true"><CheckIcon size={14} />Saved</span>}
        <RuleActionsMenu title={title} disabled={busy} onRemove={onRemove} />
      </div>
      <span className="sr-only" role="status">{saved ? `${title} saved` : ""}</span>
    </li>
  );
}

/** Agents on machines, each as "Codex on Studio Workstation", or "Codex and Pi on Studio Workstation"
 * when they share one machine. */
function agentsOnMachines(entries: ReadonlyArray<{ runnerId: string; agent: { id: string; name?: string } }>,
  machineLabels: ReadonlyMap<string, string>): string {
  const byMachine = new Map<string, string[]>();
  for (const { runnerId, agent } of entries) {
    const names = byMachine.get(runnerId) ?? [];
    const name = agent.name || agent.id;
    if (!names.includes(name)) names.push(name);
    byMachine.set(runnerId, names);
  }
  const machine = (runnerId: string) => machineLabels.get(runnerId) ?? runnerId;
  const machines = [...byMachine];
  if (machines.length === 1) return `${listText(machines[0]![1], 3)} on ${machine(machines[0]![0])}`;
  return listText(machines.flatMap(([runnerId, names]) => names.map((name) => `${name} on ${machine(runnerId)}`)), 3);
}

/** What a group rule cannot deploy to, as amber sentences naming the agents, or null. */
function unreachableSentence(rule: SkillRule, rules: ReadonlyArray<SkillRule>, runners: ReadonlyArray<RunnerView>,
  machineLabels: ReadonlyMap<string, string>): string | null {
  const { ineligible, manualOnly } = skillRuleUnreachableAgents(rule, rules, runners);
  const sentences = [
    ineligible.length ? `${agentsOnMachines(ineligible, machineLabels)} can't receive managed skills.` : null,
    manualOnly.length ? `${agentsOnMachines(manualOnly, machineLabels)} can't run manual-only skills.` : null,
  ].filter(Boolean);
  return sentences.length ? sentences.join(" ") : null;
}

/** A group's rule as read-only facts: the group decides it, in Manage Groups. */
function GroupRuleRow({ rule, title, warning }: { rule: SkillGroupAssignmentView; title: string; warning: string | null }) {
  return (
    <li className={`skill-assignment${rule.enabled ? "" : " is-off"}`} data-assignment-id={rule.id}>
      <div className="skill-assignment-text">
        <span className="skill-assignment-title">{title}</span>
        {warning && <span className="skill-assignment-warning">{warning}</span>}
      </div>
      <div className="skill-assignment-controls skill-assignment-facts">
        <span>{invocationLabel(rule.invocation)}</span>
        {!rule.enabled && <span>Turned Off</span>}
      </div>
    </li>
  );
}

/** The skill's group and its rules as the page last read them. */
export interface SkillAssignmentsGroup {
  id: string;
  /** Undefined when the library does not list the group. */
  view?: SkillGroupView;
  /** Null while the rules load, or when they could not be read (`error`). */
  rules: SkillGroupAssignmentView[] | null;
  error?: string;
}

export interface SkillAssignmentsProps {
  assignments: ReadonlyArray<SkillAssignmentView>;
  group: SkillAssignmentsGroup | null;
  /** The skill's own rules and its group's, when both are current: who wins for each agent. */
  rules: ReadonlyArray<SkillRule>;
  runners: ReadonlyArray<RunnerView>;
  machineLabels: ReadonlyMap<string, string>;
  busy: boolean;
  /** The direct rule whose change is saving, or whose "Saved" check shows. */
  save: { id: string; state: "saving" | "saved" } | null;
  onSetInvocation: (assignment: SkillAssignmentView, invocation: SkillInvocationPolicy) => void;
  onSetEnabled: (assignment: SkillAssignmentView, enabled: boolean) => void;
  /** Confirms, then removes; settles once the rule is gone or the person declined. */
  onRemove: (assignment: SkillAssignmentView) => Promise<void>;
  onEditInGroups: (groupId: string) => void;
}

/**
 * The skill detail's Assignments section (#1982): the skill's direct rules as editable rows on one
 * Surface, then, under "From Groups", its group's rules as read-only rows with Edit in Groups….
 */
export function SkillAssignments(props: SkillAssignmentsProps) {
  const { assignments, group, rules, runners, machineLabels, busy, save } = props;
  const listRef = useRef<HTMLUListElement>(null);
  // A removed rule's ⋯ goes with its row: focus moves to the row that took its place, or the one
  // above, or the list, rather than dropping to the page.
  const removedAt = useRef<{ id: string; index: number; settled: boolean } | null>(null);
  useLayoutEffect(() => {
    const removed = removedAt.current;
    if (!removed) return;
    if (assignments.some((assignment) => assignment.id === removed.id)) {
      // Declined or failed: the row stayed, so there is nothing to move focus for.
      if (removed.settled) removedAt.current = null;
      return;
    }
    // The shorter list can arrive while the rest of the refresh still holds every control disabled,
    // and a disabled ⋯ takes no focus: wait until they are enabled again.
    if (busy) return;
    removedAt.current = null;
    const list = listRef.current;
    const active = list?.ownerDocument.activeElement;
    if (!list || (active && active !== list.ownerDocument.body && active.isConnected)) return;
    const triggers = list.querySelectorAll<HTMLElement>('[data-rule-control="more"]');
    (triggers[Math.min(removed.index, triggers.length - 1)] ?? list).focus();
  }, [assignments, busy]);
  const title = (rule: RuleTarget) => assignmentRuleTitle(rule, runners, machineLabels);
  const groupName = group?.view?.name ?? "Unavailable Group";

  return (
    <SkillDetailSection
      title="Assignments"
      note="Rules that choose which agents get this skill. A direct rule wins over a group rule for the same agents."
    >
      <div className="surface skill-assignments">
        <ul ref={listRef} className="skill-assignment-list" aria-label="Direct Assignments" tabIndex={-1}>
          {assignments.length === 0 ? (
            <li className="skill-assignment is-empty">No direct assignments.</li>
          ) : assignments.map((assignment, index) => (
            <AssignmentRuleRow
              key={assignment.id}
              rule={assignment}
              title={title(assignment)}
              offDescription="Direct assignment, turned off"
              busy={busy}
              saving={save?.id === assignment.id && save.state === "saving"}
              saved={save?.id === assignment.id && save.state === "saved"}
              onSetInvocation={(invocation) => props.onSetInvocation(assignment, invocation)}
              onSetEnabled={(enabled) => props.onSetEnabled(assignment, enabled)}
              onRemove={() => {
                const removal = { id: assignment.id, index, settled: false };
                removedAt.current = removal;
                // Settles after the refresh is set but before it renders, so the effect still sees it.
                void props.onRemove(assignment).finally(() => { removal.settled = true; });
              }}
            />
          ))}
        </ul>
        {group && (
          <section className="skill-assignments-group" aria-label={`From Groups: ${groupName}`}>
            <div className="skill-assignments-group-head">
              <span className="skill-assignments-group-label">From Groups</span>
              <span className="skill-assignments-group-name">{groupName}</span>
              <button type="button" className="btn ghost sm" onClick={() => props.onEditInGroups(group.id)}>Edit in Groups…</button>
            </div>
            {!group.view ? (
              <p className="skill-assignments-group-note">Group information is unavailable.</p>
            ) : !group.view.scope ? (
              <p className="skill-assignments-group-note">This legacy group is organizational metadata only and has no deployable assignments.</p>
            ) : group.error ? (
              <p className="skill-assignments-group-note danger-text">Couldn't load this group's assignments. {group.error}</p>
            ) : group.rules === null ? (
              <p className="skill-assignments-group-note">Loading the group's assignments…</p>
            ) : group.rules.length === 0 ? (
              <p className="skill-assignments-group-note">This group has no assignments.</p>
            ) : (
              <ul className="skill-assignment-list">
                {group.rules.map((rule) => (
                  <GroupRuleRow key={rule.id} rule={rule} title={title(rule)}
                    warning={rules.includes(rule) ? unreachableSentence(rule, rules, runners, machineLabels) : null} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </SkillDetailSection>
  );
}
