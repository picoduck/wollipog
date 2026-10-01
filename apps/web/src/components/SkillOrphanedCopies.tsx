import { useEffect, useId, useRef, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { statusMeta } from "../status-meta.js";
import {
  omittedKeptAsideCopies,
  orphanedCopyDiscardBlocker,
  orphanedCopyImportBlocker,
  orphanedCopyKey,
  orphanedCopyLimitation,
  orphanedCopySentence,
  orphanedCopyStoreEntry,
  reportedOrphanedCopies,
  type OrphanedSkillCopy,
  type RunnerSkillsResponse,
} from "../skills.js";
import { CopyButton } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { MoreHorizontalIcon, RefreshIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

export { orphanedCopyDiscardable } from "../skills.js";

/** Whether this machine's runner can resolve a copy of this kind at all, online or not. */
function runnerResolves(runner: RunnerView, copy: OrphanedSkillCopy): boolean {
  return runnerSupportsProtocol(runner.protocolVersion, copy.kind === "kept_aside" ? "skillKeptAsideCopies" : "skillDrift");
}

/** Whether this machine's runner can act on the copy right now. */
export function canResolveOrphanedCopy(runner: RunnerView, copy: OrphanedSkillCopy): boolean {
  return runner.status === "online" && runnerResolves(runner, copy);
}

export interface SkillOrphanedCopiesProps {
  runners: RunnerView[];
  machineLabels: ReadonlyMap<string, string>;
  machineSkills: Record<string, RunnerSkillsResponse>;
  busy: boolean;
  syncingRunnerId: string | null;
  /** False on a phone, where the detail bar already names the route. */
  showTitle: boolean;
  onSync: (runnerId: string) => void;
  onReview: (runner: RunnerView, copy: OrphanedSkillCopy) => void;
  onDiscard: (runner: RunnerView, copy: OrphanedSkillCopy) => void;
  onOpenOverview: () => void;
}

/**
 * Every orphaned edited copy, independent of any library skill (#1974, docs/design-system.md §5): a
 * section per machine with something to show, each copy one two-line row in that machine's Surface.
 * A copy that cannot be imported says why in amber on its second line; what a runner cannot report
 * is one compact notice under its machine; and with nothing left, one state says so.
 */
export function SkillOrphanedCopies({
  runners, machineLabels, machineSkills, busy, syncingRunnerId, showTitle, onSync, onReview, onDiscard, onOpenOverview,
}: SkillOrphanedCopiesProps) {
  const id = useId().replace(/:/g, "");
  const machines = runners.map((runner) => {
    const machine = machineSkills[runner.runnerId];
    return {
      runner,
      machine,
      copies: reportedOrphanedCopies(machine),
      limitation: orphanedCopyLimitation(machine?.keptAsideReporting === "unsupported", omittedKeptAsideCopies(machine)),
    };
  }).filter(({ machine, copies, limitation }) => !machine || machine.loadError || copies.length > 0 || limitation);
  const resolved = machines.length === 0;
  const listed = machines.some(({ copies }) => copies.length > 0);

  // Resolving the last copy removes the row whose action had focus, so focus moves on to the way
  // back rather than staying lost: on <body>, or on the page title, where a closing confirmation
  // leaves it when its opener was disabled while the discard ran. A pane that never listed a copy
  // (machines still loading, then nothing to show) leaves focus alone.
  const stateRef = useRef<HTMLDivElement>(null);
  const hadCopies = useRef(listed);
  useEffect(() => {
    if (listed) {
      hadCopies.current = true;
      return;
    }
    if (!resolved || !hadCopies.current) return;
    hadCopies.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || active.id === "page-title") {
      stateRef.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [resolved, listed]);

  return (
    <section className="skill-orphans" aria-label="Orphaned Copies">
      <header className="skill-orphans-head">
        {showTitle && <h2 className="skill-orphans-title">Orphaned Copies</h2>}
        <p className="skill-orphans-summary">
          Edited copies still on your machines that no longer match a library skill. Import one to keep it, or discard it.
        </p>
      </header>
      {resolved ? (
        <div className="skill-orphans-resolved" ref={stateRef}>
          <State
            compact
            title="All Resolved"
            headingLevel={3}
            actions={<button type="button" className="btn sm" onClick={onOpenOverview}>Open Library Overview</button>}
          >
            No orphaned copies are left on your machines.
          </State>
        </div>
      ) : machines.map(({ runner, machine, copies, limitation }) => {
        const label = machineLabels.get(runner.runnerId) ?? runner.runnerId;
        const online = runner.status === "online";
        const headingId = `${id}-${runner.runnerId}`;
        const offlineId = `${headingId}-offline`;
        return (
          <section className="section" key={runner.runnerId} aria-labelledby={headingId}>
            <div className="skill-orphans-machine-head">
              <h3 className="section-title" id={headingId}>{label}</h3>
              <StatusBadge inline meta={statusMeta("machine", online ? "online" : "offline")} />
              {online ? (
                <BusyButton
                  className="icon-btn sm"
                  busy={syncingRunnerId === runner.runnerId}
                  progress={`Syncing ${label}…`}
                  disabled={syncingRunnerId !== null && syncingRunnerId !== runner.runnerId}
                  aria-label="Sync Now"
                  title="Sync Now"
                  icon={<RefreshIcon />}
                  onClick={() => onSync(runner.runnerId)}
                >
                  {null}
                </BusyButton>
              ) : (
                <span className="skill-orphans-meta" id={offlineId}>Import or discard when back online</span>
              )}
            </div>
            {!machine && <p className="skills-hint">Checking this machine's copies…</p>}
            {machine?.loadError && <p className="skills-hint" role="alert">{machine.loadError}</p>}
            {copies.length > 0 && (
              <ul className="surface skill-orphans-list">
                {copies.map((copy) => (
                  <OrphanedCopyRow
                    key={orphanedCopyKey(copy)}
                    runner={runner}
                    copy={copy}
                    busy={busy}
                    offlineId={online ? undefined : offlineId}
                    onReview={onReview}
                    onDiscard={onDiscard}
                  />
                ))}
              </ul>
            )}
            {limitation && <Notice tone="neutral" compact>{limitation}</Notice>}
          </section>
        );
      })}
    </section>
  );
}

/**
 * One orphaned copy (§5.2): its name with Import… and ⋯ on line 1, and one sentence of facts on line
 * 2. A copy that cannot be imported keeps Import… disabled and says why in amber after the facts.
 * Line 2 wraps rather than being cut, and only a row whose line 2 wraps grows.
 */
function OrphanedCopyRow({ runner, copy, busy, offlineId, onReview, onDiscard }: {
  runner: RunnerView;
  copy: OrphanedSkillCopy;
  busy: boolean;
  /** The machine's "back online" phrase, which is the reason while the machine is offline. */
  offlineId: string | undefined;
  onReview: (runner: RunnerView, copy: OrphanedSkillCopy) => void;
  onDiscard: (runner: RunnerView, copy: OrphanedSkillCopy) => void;
}) {
  const reasonId = `orphan-reason-${useId().replace(/:/g, "")}`;
  const name = copy.name ?? "Unidentified Copy";
  const supported = runnerResolves(runner, copy);
  const importBlocker = orphanedCopyImportBlocker(copy, supported);
  const discardBlocker = orphanedCopyDiscardBlocker(copy, supported);
  const sentence = orphanedCopySentence(copy);
  const storeEntry = orphanedCopyStoreEntry(copy);
  const describedBy = importBlocker ? reasonId : offlineId;

  const { showToast } = useFeedback();
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "skill-orphan-menu");
  return (
    <li className="row skill-orphans-row">
      <span className="row-title">{name}</span>
      <span className="skill-orphans-actions">
        <button
          type="button"
          className="btn sm"
          aria-label={`Import ${name}…`}
          aria-describedby={describedBy}
          disabled={busy || !!offlineId || !!importBlocker}
          onClick={() => onReview(runner, copy)}
        >
          Import…
        </button>
        <button
          ref={menu.triggerRef}
          type="button"
          className="icon-btn sm"
          disabled={busy}
          title="More Actions"
          aria-label={`More Actions for ${name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menu.menuId : undefined}
          onClick={menu.toggle}
          onKeyDown={menu.onTriggerKeyDown}
        >
          <MoreHorizontalIcon />
        </button>
      </span>
      {importBlocker ? (
        <span className="row-sub skill-orphans-sub">
          {sentence} <span className="skill-orphans-reason" id={reasonId}>{importBlocker}</span>
        </span>
      ) : (
        <span className="row-sub skill-orphans-sub">{sentence}</span>
      )}
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={name}
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {storeEntry && (
            <>
              <CopyButton
                text={storeEntry}
                label="Copy Store Entry"
                className="menu-item"
                role="menuitem"
                onResult={(copied) => {
                  menu.close(true);
                  showToast(copied ? "Store entry copied." : "Couldn't copy the store entry.", { tone: copied ? "success" : "error" });
                }}
              />
              <MenuSeparator />
            </>
          )}
          <MenuItem
            danger
            disabled={!!offlineId || !!discardBlocker}
            description={discardBlocker ?? undefined}
            aria-describedby={discardBlocker ? undefined : offlineId}
            onClick={() => {
              // Focus the trigger before the confirmation opens, so it is what Cancel or Escape
              // returns to; the menu item is about to unmount.
              menu.close(false);
              menu.triggerRef.current?.focus();
              onDiscard(runner, copy);
            }}
          >
            Discard Copy…
          </MenuItem>
        </MenuSurface>
      )}
    </li>
  );
}
