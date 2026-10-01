import React, { useId, useState, type ReactNode } from "react";
import { runnerSupportsProtocol, type RunnerView, type SkillDriftState } from "@wollipog/protocol";
import { Notice } from "./Notice.js";
import { ChevronDownIcon, RecommendedIcon } from "./Icons.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { useAccessibleMenu } from "./interactions.js";
import { BusyButton } from "./ui/BusyButton.js";
import {
  reportedSkillDrift,
  skillDeploymentErrorWords,
  skillRecommended,
  skillVersionLabel,
  type RunnerSkillsResponse,
  type SkillGitAutoUpdate,
  type SkillSummary,
} from "../skills.js";
import {
  skillDeploymentErrorSummary,
  skillManualOnlyErrors,
  type SkillDeploymentErrorSummary,
  type SkillManualOnlyError,
  type SkillRule,
} from "../skill-assignment-matrix.js";

/**
 * The one thing a skill needs from the person, most urgent first, so a recommendation never hides a
 * problem (§13.2, #1972): a deployment error, then an edited copy, then a held update, then the
 * recommendation. Everything below the shown item stays where it lives (the agent's state in
 * Deployment, the held notice in Source).
 */
export type SkillNoticeItem<T extends SkillRule = SkillRule> =
  | { kind: "manual-only"; error: SkillManualOnlyError<T> }
  | { kind: "deployment-error"; error: SkillDeploymentErrorSummary }
  | { kind: "edited"; runnerId: string; entry: SkillDriftState }
  | { kind: "git-held"; held: NonNullable<SkillGitAutoUpdate["held"]> }
  | { kind: "built-in-held"; release: string }
  | { kind: "recommended" };

/** Whether this machine can resolve an edited copy from here now. */
const resolvesEditedCopies = (runner: RunnerView) =>
  runner.status === "online" && runnerSupportsProtocol(runner.protocolVersion, "skillDrift");

/** Which notice the slot shows for this skill, or null when it needs nothing. Machines are read in
 * the order given, which is the Deployment order, so the same machine wins every time. `rulesComplete`
 * is false while the skill's group's rules are unread, so no rule is blamed for a skipped agent. */
export function skillNoticeItem<T extends SkillRule>(
  skill: SkillSummary,
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
  rules: ReadonlyArray<T>,
  rulesComplete = true,
): SkillNoticeItem<T> | null {
  // A rule that skips agents outranks a machine's own error: the page can name its fix.
  const manualOnly = skillManualOnlyErrors(skill.name, runners, machineSkills, rules, rulesComplete)[0];
  if (manualOnly) return { kind: "manual-only", error: manualOnly };
  // The machine's own error, told as the Library Overview tells it (#2293).
  const failed = skillDeploymentErrorSummary(skill.name, runners, machineSkills, "machine");
  if (failed) return { kind: "deployment-error", error: failed };
  // Deployment keeps no list of edited copies, so a copy that can be resolved now goes first: an
  // offline machine's copy must not hide another machine's behind its disabled actions.
  const edited = runners.flatMap((runner) => {
    const state = machineSkills[runner.runnerId];
    return !state || state.loadError ? [] : reportedSkillDrift(state.reported, skill.name)
      .map((entry) => ({ runner, entry }));
  });
  const copy = edited.find(({ runner }) => resolvesEditedCopies(runner)) ?? edited[0];
  if (copy) return { kind: "edited", runnerId: copy.runner.runnerId, entry: copy.entry };
  const gitHeld = skill.gitAutoUpdate?.enabled ? skill.gitAutoUpdate.held : null;
  if (gitHeld) return { kind: "git-held", held: gitHeld };
  if (skill.builtIn?.heldUpdate) return { kind: "built-in-held", release: skill.builtIn.heldUpdate.release };
  if (skillRecommended(skill)) return { kind: "recommended" };
  return null;
}

/** "A", "A and B", "A, B and C", or past `max`, "A, B and 2 more". */
export function listText(items: ReadonlyArray<string>, max = 2): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

const unique = (items: ReadonlyArray<string>) => [...new Set(items)];

/** A notice action that opens a menu anchored to itself (§9.1): one item per choice. */
function NoticeMenuButton({ label, chevron = false, disabled, children }: {
  label: string;
  chevron?: boolean;
  disabled?: boolean;
  /** The menu's items, given `choose`, which closes the menu, returns focus and runs the action. */
  children: (choose: (action: () => void) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-notice-menu");
  const choose = (action: () => void) => {
    menu.close(false);
    menu.triggerRef.current?.focus();
    action();
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm"
        disabled={disabled}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
      >
        {label}
        {chevron && <ChevronDownIcon size={14} />}
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={label.replace(/…$/, "")}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {children(choose)}
        </MenuSurface>
      )}
    </>
  );
}

/** The built-in recommendation: assign it everywhere, to one machine, or to chosen agents; or
 * dismiss it with the close button. Assignment and dismissal both have their own undo, so neither
 * asks first. */
export function RecommendedNotice({ runners, machineLabels, busy, onAssign, onChooseAgents, onDismiss }: {
  runners: ReadonlyArray<RunnerView>;
  machineLabels: ReadonlyMap<string, string>;
  busy: boolean;
  /** `null` assigns the skill to all machines. */
  onAssign: (runnerId: string | null) => void;
  onChooseAgents: () => void;
  onDismiss: () => void;
}) {
  return (
    <Notice
      as="section"
      tone="info"
      icon={<RecommendedIcon />}
      title="Recommended by Wollipog"
      ariaLabel="Recommended by Wollipog"
      onDismiss={onDismiss}
      dismissLabel="Dismiss Recommendation"
      dismissDisabled={busy}
      actions={
        <>
          <button type="button" className="btn primary sm" disabled={busy} onClick={() => onAssign(null)}>
            Assign to All Machines
          </button>
          <NoticeMenuButton label="Assign to Machine" chevron disabled={busy}>
            {(choose) => (
              <>
                {runners.map((runner) => (
                  <MenuItem
                    key={runner.runnerId}
                    description={runner.status === "online" ? "Online" : "Offline"}
                    onClick={() => choose(() => onAssign(runner.runnerId))}
                  >
                    {machineLabels.get(runner.runnerId) ?? runner.runnerId}
                  </MenuItem>
                ))}
                {runners.length > 0 && <MenuSeparator />}
                <MenuItem onClick={() => choose(onChooseAgents)}>Choose Agents…</MenuItem>
              </>
            )}
          </NoticeMenuButton>
        </>
      }
    >
      It teaches agents in Wollipog sessions to use Wollipog's CLI and MCP tools. It isn't on any machine until you
      assign it; assigning deploys it to every supported agent on the machines you choose.
    </Notice>
  );
}

/** A held Git update and its review (#1972). The slot shows it when nothing outranks it; otherwise
 * Source does, so it is one notice in one place. Review Update… opens Check for Updates on the
 * tracked ref. */
export function GitHeldNotice({ held, busy, onReview }: {
  held: NonNullable<SkillGitAutoUpdate["held"]>;
  busy: boolean;
  onReview: () => void;
}) {
  const commit = held.commit.slice(0, 12);
  const paths = listText(held.scriptPaths, 3);
  return (
    <Notice
      as="section"
      tone="warning"
      title="Update Held for Review"
      ariaLabel="Update Held for Review"
      actions={<button type="button" className="btn sm" disabled={busy} onClick={onReview}>Review Update…</button>}
    >
      <p>
        {held.reason === "scripts" && paths ? `Commit ${commit} adds or changes ${paths}.`
          : held.reason === "untracked_modes" && paths
            ? `Commit ${commit} changes ${paths}, which the last import didn't check for scripts.`
            : held.reason === "local_changes" ? `Commit ${commit} would replace changes made here since the last Git import.`
              : `Commit ${commit} needs a review.`}{" "}
        Review it before it deploys.
      </p>
    </Notice>
  );
}

export interface SkillNoticeSlotProps<T extends SkillRule> {
  skill: SkillSummary;
  runners: ReadonlyArray<RunnerView>;
  machineLabels: ReadonlyMap<string, string>;
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>;
  /** The skill's own assignments and its group's, which decide the rule behind a skipped agent. */
  rules: ReadonlyArray<T>;
  /** False while a rule that could win is unread (the group's, loading or unreadable). */
  rulesComplete?: boolean;
  /** The item `skillNoticeItem` chose, when the caller already asked: Source reads the same answer
   * to leave out what the slot shows, so the two can never disagree. */
  item?: SkillNoticeItem<T> | null;
  busy: boolean;
  syncingRunnerId: string | null;
  onSwitchToAgentInvocable: (rule: T) => void;
  onLimitToClaudeCode: (rule: T) => void;
  onEditGroups: () => void;
  onSync: (runnerId: string) => void;
  onReviewEdit: (runnerId: string, entry: SkillDriftState) => void;
  onRestore: (runner: RunnerView, entry: SkillDriftState) => void;
  onReviewGitUpdate: () => void;
  onReviewBuiltInUpdate: () => void;
  onAssign: (runnerId: string | null) => void;
  onChooseAgents: () => void;
  onDismissRecommendation: () => void;
}

/** The notice slot directly under the skill detail's header: at most one notice (§13.2). */
export function SkillNoticeSlot<T extends SkillRule>(props: SkillNoticeSlotProps<T>) {
  const { skill, runners, machineLabels, machineSkills, rules, busy } = props;
  const reasonId = `skill-notice-reason-${useId().replace(/:/g, "")}`;
  const item = props.item !== undefined ? props.item : skillNoticeItem(skill, runners, machineSkills, rules, props.rulesComplete ?? true);
  if (!item) return null;
  const machineName = (runnerId: string) => machineLabels.get(runnerId) ?? runnerId;
  const runnerOf = (runnerId: string) => runners.find((runner) => runner.runnerId === runnerId);
  /** A sentence after the body saying why an action cannot be taken now, which the action names. */
  const reason = (text: string | null) => text && <p id={reasonId} className="notice-meta">{text}</p>;

  let notice: ReactNode;
  if (item.kind === "manual-only") {
    const { rule, runnerIds } = item.error;
    const names = unique(item.error.agents.map((agent) => agent.name || agent.id));
    const title = `${listText(names, 3)} Can't Run Manual-Only Skills`;
    const fromGroup = Boolean(rule?.groupId);
    notice = (
      <Notice
        as="section"
        tone="danger"
        title={title}
        ariaLabel={title}
        actions={!rule ? undefined : fromGroup ? (
          <button type="button" className="btn sm" disabled={busy} onClick={props.onEditGroups}>Edit in Groups…</button>
        ) : (
          <NoticeMenuButton label="Change Invocation…" disabled={busy}>
            {(choose) => (
              <>
                <MenuItem
                  description={`Agents run it on their own, so ${listText(names)} can use it too.`}
                  onClick={() => choose(() => props.onSwitchToAgentInvocable(rule))}
                >
                  Switch to Agent Invocable
                </MenuItem>
                <MenuItem
                  description="Stays Manual Only, and the rule covers Claude Code only."
                  onClick={() => choose(() => props.onLimitToClaudeCode(rule))}
                >
                  Limit to Claude Code
                </MenuItem>
              </>
            )}
          </NoticeMenuButton>
        )}
      >
        <p>
          {names.length === 1 ? "It's" : "They're"} skipped on {listText(runnerIds.map(machineName))}.{" "}
          {fromGroup
            ? "Switch the group's assignment to Agent Invocable, or limit it to Claude Code."
            : "Switch the assignment to Agent Invocable, or limit it to Claude Code."}
        </p>
      </Notice>
    );
  } else if (item.kind === "deployment-error") {
    const { runnerId } = item.error;
    const machine = machineName(runnerId);
    const words = skillDeploymentErrorWords(item.error, machineName);
    const online = runnerOf(runnerId)?.status === "online";
    const title = `Couldn't Deploy to ${machine}`;
    notice = (
      <Notice
        as="section"
        tone="danger"
        title={title}
        ariaLabel={title}
        details={<p>{words.detail}</p>}
        actions={
          <BusyButton
            className="btn sm"
            busy={props.syncingRunnerId === runnerId}
            progress={`Syncing ${machine}…`}
            disabled={!online || (props.syncingRunnerId !== null && props.syncingRunnerId !== runnerId)}
            aria-describedby={online ? undefined : reasonId}
            onClick={() => props.onSync(runnerId)}
          >
            Sync Now
          </BusyButton>
        }
      >
        <p>{words.who} reported an error for this skill.{words.more && ` ${words.more}`}</p>
        {reason(online ? null : `${machine} is offline.`)}
      </Notice>
    );
  } else if (item.kind === "edited") {
    const { runnerId, entry } = item;
    const runner = runnerOf(runnerId)!;
    const machine = machineName(runnerId);
    const latest = skill.latestVersion;
    const version = entry.digest === latest?.digest ? skillVersionLabel(latest)!.text : entry.digest.slice(0, 12);
    const desired = machineSkills[runnerId]?.desired.find((candidate) => candidate.name === skill.name);
    const users = unique((desired?.targets ?? [])
      .filter((target) => target.invocation === entry.variant)
      .map((target) => runner.agents.find((agent) => agent.id === target.agentId)?.name ?? target.agentId));
    const copy = users.length === 1 ? `${users[0]}'s copy`
      : users.length > 1 ? `The copy ${listText(users)} use` : "The deployed copy";
    const online = runner.status === "online";
    const supported = runnerSupportsProtocol(runner.protocolVersion, "skillDrift");
    const blocked = !online ? `${machine} is offline.`
      : !supported ? "Update this machine's runner to resolve edited copies here." : null;
    const unreadable = !blocked && !entry.observedDigest ? "This copy can't be read back as a skill, so it can't be imported." : null;
    const title = `${machine} Has an Edited Copy`;
    notice = (
      <Notice
        as="section"
        tone="warning"
        title={title}
        ariaLabel={title}
        actions={
          <>
            <button
              type="button"
              className="btn sm"
              disabled={busy || Boolean(blocked) || !entry.observedDigest}
              aria-describedby={blocked || unreadable ? reasonId : undefined}
              onClick={() => props.onReviewEdit(runnerId, entry)}
            >
              Review Edit…
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy || Boolean(blocked)}
              aria-describedby={blocked ? reasonId : undefined}
              onClick={() => props.onRestore(runner, entry)}
            >
              Restore Library Version…
            </button>
          </>
        }
      >
        <p>
          {copy} differs from {version}.{" "}
          {entry.held
            ? `Updates on that machine wait until you import the edit or restore ${version}.`
            : `It stays on that machine until you import the edit or restore ${version}.`}
        </p>
        {reason(blocked ?? unreadable)}
      </Notice>
    );
  } else if (item.kind === "git-held") {
    notice = <GitHeldNotice held={item.held} busy={busy} onReview={props.onReviewGitUpdate} />;
  } else if (item.kind === "built-in-held") {
    notice = (
      <Notice
        as="section"
        tone="warning"
        title="Built-In Update Held"
        ariaLabel="Built-In Update Held"
        actions={<button type="button" className="btn sm" disabled={busy} onClick={props.onReviewBuiltInUpdate}>Review Update…</button>}
      >
        <p>
          Wollipog {item.release} updates this skill, but the latest library version has changes made here, so it waits
          for your review.
        </p>
      </Notice>
    );
  } else {
    notice = (
      <RecommendedNotice
        runners={runners}
        machineLabels={machineLabels}
        busy={busy}
        onAssign={props.onAssign}
        onChooseAgents={props.onChooseAgents}
        onDismiss={props.onDismissRecommendation}
      />
    );
  }
  return <div className="skill-notice-slot" data-notice={item.kind}>{notice}</div>;
}
