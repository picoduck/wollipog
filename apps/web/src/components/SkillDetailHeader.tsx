import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "../format.js";
import { skillSourceKind, skillSourceLabel, skillVersionLabel, type SkillSummary } from "../skills.js";
import { FilesIcon, FolderIcon, SkillSourceIcon, UpdatedIcon, VersionIcon } from "./Icons.js";
import { ActionsMenu, type PageAction, type PageMenuAction } from "./PageHeader.js";

/** Why a built-in skill has no Check for Updates… of its own (§9.1: a disabled item says why). */
export const BUILT_IN_UPDATES_REASON = "Built-in skills update with each Wollipog release.";
/** Why Delete Skill… waits: a change to this skill is still being saved, and deleting under it would fail it. */
export const SKILL_BUSY_REASON = "Wait for the current change to finish.";

/**
 * The skill detail's ⋯ items (#1962), in order. The desktop header shows them behind its ⋯; on a
 * phone the detail bar's ⋯ holds Add Assignment… and then these. Delete Skill… is destructive, so
 * the menu draws it last, after a separator, in danger text (§3.3). Check for Updates… exists for a
 * Git skill, and for a built-in skill as a disabled item that says why; other skills have no source
 * to check.
 */
export function skillDetailMenu(skill: SkillSummary, busy: boolean, actions: {
  onVersionHistory: () => void;
  onMachineVersion: () => void;
  onCheckForUpdates: () => void;
  onDelete: () => void;
}): PageMenuAction[] {
  const source = skillSourceKind(skill);
  return [
    { label: "Version History…", onClick: actions.onVersionHistory },
    { label: "Machine Version…", onClick: actions.onMachineVersion },
    ...(source === "built_in"
      ? [{ label: "Check for Updates…", onClick: () => {}, disabled: true, description: BUILT_IN_UPDATES_REASON }]
      : source === "git" ? [{ label: "Check for Updates…", onClick: actions.onCheckForUpdates }] : []),
    { label: "Delete Skill…", onClick: actions.onDelete, danger: true, disabled: busy, ...(busy ? { description: SKILL_BUSY_REASON } : {}) },
  ];
}

/**
 * The top of a skill's detail (#1962): its name with Add Assignment… and ⋯ on one row, the
 * description clamped to two lines, and one meta row of neutral facts (§11.3). On a phone the
 * detail bar carries the name and the actions, so only the description and meta show here.
 */
export function SkillDetailHeader({ skill, groupName, showTitle, addAssignment, menu }: {
  skill: SkillSummary;
  /** The skill's group, when it has one the library knows. */
  groupName?: string;
  showTitle: boolean;
  addAssignment: PageAction;
  menu: PageMenuAction[];
}) {
  return (
    <header className="skill-detail-head">
      {showTitle && (
        <div className="skill-detail-title-row">
          <h2 className="skill-detail-title" title={skill.name}>{skill.name}</h2>
          <div className="actions">
            <button type="button" className="btn" disabled={addAssignment.disabled} onClick={addAssignment.onClick}>
              {addAssignment.label}
            </button>
            <ActionsMenu items={menu} />
          </div>
        </div>
      )}
      {skill.description && <SkillDescription text={skill.description} />}
      <SkillMeta skill={skill} groupName={groupName} />
    </header>
  );
}

/**
 * Two lines until the person asks for the rest. Whether the clamp hides anything is measured, never
 * guessed from the character count: against the clamp every time, expanded or not, and again
 * whenever the paragraph's width changes, so a description that fits after the window widens loses
 * its toggle. The clamp is put on for the measurement and taken off inside the same layout pass,
 * so nothing paints in between.
 */
function SkillDescription({ text }: { text: string }) {
  const id = `skill-desc-${useId().replace(/:/g, "")}`;
  const [expanded, setExpanded] = useState(false);
  const [truncates, setTruncates] = useState(false);
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const paragraph = paragraphRef.current;
    if (!paragraph) return;
    const measure = () => {
      paragraph.classList.add("is-clamped");
      const hidden = paragraph.scrollHeight > paragraph.clientHeight;
      if (expanded) paragraph.classList.remove("is-clamped");
      // A toggle that is about to disappear hands its focus to the text it controlled (§16.1).
      if (!hidden && toggleRef.current && toggleRef.current === toggleRef.current.ownerDocument.activeElement) {
        paragraph.focus({ preventScroll: true });
      }
      setTruncates(hidden);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The paragraph's width comes from the pane, never from its own height, so observing it
    // cannot loop.
    const observer = new ResizeObserver(measure);
    observer.observe(paragraph);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className="skill-detail-desc-block">
      <p ref={paragraphRef} id={id} className={`skill-detail-desc${expanded ? "" : " is-clamped"}`} tabIndex={-1}>{text}</p>
      {truncates && (
        <button
          ref={toggleRef}
          type="button"
          className="link skill-detail-desc-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show Less" : "Show Full Description"}
        </button>
      )}
    </div>
  );
}

/** Group, version, when it changed, how many files, and where it comes from: each fact with its icon. */
function SkillMeta({ skill, groupName }: { skill: SkillSummary; groupName?: string }) {
  const latest = skill.latestVersion;
  const version = skillVersionLabel(latest);
  const updatedAt = skill.updatedAt ?? latest?.createdAt;
  const files = latest?.files?.length;
  const fact = (key: string, icon: ReactNode, label: string | null, value: ReactNode, title?: string) => (
    <li key={key} title={title}>
      {icon}
      {label && <span className="sr-only">{label}: </span>}
      {value}
    </li>
  );
  return (
    <ul className="skill-detail-meta" aria-label="Skill Details">
      {groupName && fact("group", <FolderIcon size={14} />, "Group", groupName)}
      {version
        ? fact("version", <VersionIcon size={14} />, "Version", version.mono ? <span className="mono">{version.text}</span> : version.text)
        : fact("version", <VersionIcon size={14} />, null, "No version recorded")}
      {updatedAt !== undefined && fact("updated", <UpdatedIcon size={14} />, null, `Updated ${relativeTime(updatedAt)}`, new Date(updatedAt).toLocaleString())}
      {files !== undefined && fact("files", <FilesIcon size={14} />, null, `${files} ${files === 1 ? "file" : "files"}`)}
      {fact("source", <SkillSourceIcon size={14} />, "Source", skillSourceLabel(skillSourceKind(skill)))}
    </ul>
  );
}

/** An unboxed detail section (§4.5, §5.1): a title row, then its content. */
export function SkillDetailSection({ title, children }: { title: string; children: ReactNode }) {
  const id = `skill-section-${useId().replace(/:/g, "")}`;
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id} className="section-title">{title}</h3>
      </div>
      {children}
    </section>
  );
}
