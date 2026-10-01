import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RunnerView } from "@wollipog/protocol";
import { relativeTime } from "../format.js";
import { statusMeta } from "../status-meta.js";
import {
  skillDeployingMachineCount,
  skillLibrarySummary,
  skillListDescription,
  skillOfflineMachineSentence,
  skillRecentChanges,
  skillRecommended,
  skillUncheckedMachineSentence,
  type RunnerSkillsResponse,
  type SkillGroupView,
  type SkillOverviewAttentionItem,
  type SkillSummary,
} from "../skills.js";
import { CountBadge } from "./CountBadge.js";
import { ChevronDownIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { StatusBadge } from "./StatusBadge.js";

/** Get Started stays while the library is this small (§6.1). */
const GET_STARTED_BELOW = 3;

export interface SkillsOverviewProps {
  skills: SkillSummary[];
  groups: SkillGroupView[];
  runners: RunnerView[];
  machineSkills: Record<string, RunnerSkillsResponse>;
  machineLabels: Map<string, string>;
  /** Needs Attention, from `skillOverviewAttention()`: the page counts the same list on a phone. */
  attention: SkillOverviewAttentionItem[];
  busy: boolean;
  /** False on a phone, where the detail bar already names the route. */
  showTitle: boolean;
  onOpenSkill: (skillId: string) => void;
  onOpenOrphans: () => void;
  /** `null` assigns the skill to every supported agent on every machine. */
  onAssignRecommended: (skillId: string, runnerId: string | null) => void;
  onDismissRecommendation: (skillId: string) => void;
  onNewSkill: () => void;
  onImportFromGit: () => void;
  onImportFromMachine: () => void;
}

/**
 * The Agent Skills default detail (docs/design-system.md §6.1), at `/skills` beside the list and at
 * `/skills/overview` on a phone: the library's counts, what needs attention (the same
 * `skillAttention()` the list's badges read), what Wollipog recommends, what changed recently, and,
 * while the library is small, how to add to it.
 */
export function SkillsOverview({
  skills, groups, runners, machineSkills, machineLabels, attention, busy, showTitle,
  onOpenSkill, onOpenOrphans, onAssignRecommended, onDismissRecommendation, onNewSkill, onImportFromGit, onImportFromMachine,
}: SkillsOverviewProps) {
  const id = useId().replace(/:/g, "");
  const machineLabel = (runnerId: string) => machineLabels.get(runnerId) ?? runnerId;
  const recommended = useMemo(() => skills.filter(skillRecommended).sort((a, b) => a.name.localeCompare(b.name)), [skills]);
  const recent = useMemo(() => skillRecentChanges(skills), [skills]);
  // Until every machine's report is in, "nothing needs attention" would be a guess.
  const checking = runners.some((runner) => !machineSkills[runner.runnerId]);
  const offline = skillOfflineMachineSentence(runners, machineLabel);
  const unchecked = skillUncheckedMachineSentence(runners, machineSkills, machineLabel);

  // Assigning or dismissing a recommendation removes its row, trigger included, so focus moves on
  // to the next recommendation's View, or else to the Needs Attention heading. A failed action
  // keeps the row, and focus stays on its Assign button.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const settle = (skillId: string, apply: () => void) => {
    focusAfter.current = skillId;
    apply();
  };
  useEffect(() => {
    const pending = focusAfter.current;
    if (!pending || busy) return;
    focusAfter.current = null;
    const root = rootRef.current;
    const next = recommended.some((skill) => skill.id === pending)
      ? [...root?.querySelectorAll<HTMLElement>("[data-skill-assign]") ?? []].find((trigger) => trigger.dataset.skillAssign === pending)
      : root?.querySelector<HTMLElement>("[data-skill-view]") ??
        root?.querySelector<HTMLElement>(`#${id}-attention`);
    next?.focus();
  }, [busy, recommended, id]);

  return (
    <div className="skills-overview" ref={rootRef}>
      <header className="skills-overview-head">
        {showTitle && <h2 className="skills-overview-title">Library Overview</h2>}
        <p className="skills-overview-summary">
          {skillLibrarySummary({
            skills: skills.length,
            groups: groups.length,
            deployingMachines: skillDeployingMachineCount(runners, machineSkills),
          })}
        </p>
      </header>

      <section className="section" aria-labelledby={`${id}-attention`}>
        <div className="section-head">
          <h3 className="section-title" id={`${id}-attention`} tabIndex={-1}>
            Needs Attention
            {attention.length > 0 && <span className="skills-overview-count">{attention.length}</span>}
          </h3>
        </div>
        {attention.length > 0 ? (
          <div className="surface">
            {attention.map((item) => item.kind === "orphans" ? (
              <div className="row row-2 skills-overview-row" key="orphans">
                <span className="row-body">
                  <span className="row-line">
                    <span className="row-title">Orphaned Copies</span>
                    <CountBadge count={item.count} />
                  </span>
                  <span className="row-sub" title={item.reason}>{item.reason}</span>
                </span>
                <button type="button" className="btn sm" aria-label="Review Orphaned Copies" onClick={onOpenOrphans}>Review</button>
              </div>
            ) : (
              <div className="row row-2 skills-overview-row" key={item.skill.id}>
                <span className="row-body">
                  <span className="row-line">
                    <span className="row-title">{item.skill.name}</span>
                    <StatusBadge meta={statusMeta("skill", item.kind)} />
                  </span>
                  <span className="row-sub" title={item.reason}>{item.reason}</span>
                </span>
                <button type="button" className="btn sm" aria-label={`Review ${item.skill.name}`}
                  onClick={() => onOpenSkill(item.skill.id)}>Review</button>
              </div>
            ))}
          </div>
        ) : checking ? (
          <p className="skills-hint">Checking each machine's skills…</p>
        ) : unchecked ? null : (
          <p className="skills-overview-ok">
            <span className="skills-overview-dot" aria-hidden="true" />
            <span>Every skill is deployed as assigned.{offline ? ` ${offline}` : ""}</span>
          </p>
        )}
        {/* A machine whose report failed says nothing to skillAttention(), so it is never called healthy. */}
        {unchecked && <p className="skills-hint">{unchecked}</p>}
      </section>

      {recommended.length > 0 && (
        <section className="section" aria-labelledby={`${id}-recommended`}>
          <div className="section-head">
            <h3 className="section-title" id={`${id}-recommended`}>Recommended by Wollipog</h3>
          </div>
          <p className="skills-hint">
            Built-in skills that teach agents to use Wollipog. They aren't on any machine until you assign them.
          </p>
          <div className="surface">
            {recommended.map((skill) => {
              const description = skillListDescription(skill);
              return (
                <div className="row row-2 skills-overview-row" key={skill.id}>
                  <span className="row-body">
                    <span className="row-line">
                      <span className="row-title">{skill.name}</span>
                      <StatusBadge tone="neutral" noDot label="Built-In" />
                    </span>
                    {description && <span className="row-sub" title={description}>{description}</span>}
                  </span>
                  <span className="skills-overview-actions">
                    <button type="button" className="btn ghost sm" aria-label={`View ${skill.name}`} data-skill-view=""
                      onClick={() => onOpenSkill(skill.id)}>View</button>
                    <AssignMenu
                      skill={skill}
                      runners={runners}
                      machineLabel={machineLabel}
                      disabled={busy}
                      onAssign={(runnerId) => settle(skill.id, () => onAssignRecommended(skill.id, runnerId))}
                      onDismiss={() => settle(skill.id, () => onDismissRecommendation(skill.id))}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="section" aria-labelledby={`${id}-recent`}>
          <div className="section-head">
            <h3 className="section-title" id={`${id}-recent`}>Recently Changed</h3>
          </div>
          <div className="surface">
            {recent.map((change) => (
              <button type="button" className="row row-2 skills-overview-row" key={change.skill.id}
                onClick={() => onOpenSkill(change.skill.id)}>
                <span className="row-body">
                  <span className="row-line">
                    <span className="row-title">{change.skill.name}</span>
                    <span className="row-trail" title={new Date(change.at).toLocaleString()}>{relativeTime(change.at)}</span>
                  </span>
                  <span className="row-sub">{change.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {skills.length < GET_STARTED_BELOW && (
        <section className="section" aria-labelledby={`${id}-start`}>
          <div className="section-head">
            <h3 className="section-title" id={`${id}-start`}>Get Started</h3>
          </div>
          <ul className="skills-get-started">
            <li>
              <button type="button" className="btn" onClick={onNewSkill}>New Skill</button>
              <span className="skills-hint">Write a skill here, starting from a SKILL.md template.</span>
            </li>
            <li>
              <button type="button" className="btn" onClick={onImportFromGit}>Import from Git…</button>
              <span className="skills-hint">Copy a skill from a Git repository and keep its source.</span>
            </li>
            <li>
              <button type="button" className="btn" onClick={onImportFromMachine}>Import from Machine…</button>
              <span className="skills-hint">Snapshot a skill that already lives on a connected machine.</span>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Assign as a menu button (§9.1): every machine at once, one machine, or no longer recommended.
 * Each choice applies at once, without a confirmation: Remove Assignment… undoes an assignment and
 * Show Recommendation undoes a dismissal.
 */
function AssignMenu({ skill, runners, machineLabel, disabled, onAssign, onDismiss }: {
  skill: SkillSummary;
  runners: RunnerView[];
  machineLabel: (runnerId: string) => string;
  disabled: boolean;
  onAssign: (runnerId: string | null) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-assign-menu");
  const choose = (apply: () => void) => {
    menu.close(true);
    apply();
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm"
        aria-label={`Assign ${skill.name}`}
        data-skill-assign={skill.id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        disabled={disabled}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        Assign
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={`Assign ${skill.name}`}
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem description="Every supported agent on every machine." onClick={() => choose(() => onAssign(null))}>
            All Machines
          </MenuItem>
          {runners.map((runner) => (
            <MenuItem
              key={runner.runnerId}
              description={runner.status === "online"
                ? "Its supported agents get it on the next sync."
                : "Its agents get it when it reconnects."}
              onClick={() => choose(() => onAssign(runner.runnerId))}
            >
              {machineLabel(runner.runnerId)}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => choose(onDismiss)}>Dismiss Recommendation</MenuItem>
        </MenuSurface>
      )}
    </>
  );
}
