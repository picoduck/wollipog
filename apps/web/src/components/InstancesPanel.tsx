import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { writeClipboardText } from "../clipboard.js";
import type { InstanceProfile } from "../desktop-instances.js";
import { relativeTime } from "../format.js";
import {
  describeInstanceFailure,
  instanceAvailabilityMeta,
  instanceMonogram,
  instanceStatus,
  useActiveInstanceConnection,
  useInstances,
  type InstanceManager,
} from "../instances-context.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";
import { ArrowLeftRightIcon, CheckIcon, CopyIcon, DeleteIcon, EditIcon, KeyIcon, MoreHorizontalIcon, RefreshIcon } from "./Icons.js";
import { useFeedback } from "./FeedbackProvider.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import type { PagePrimaryAction } from "./PageHeader.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The Instances tab's page-header primary (§3.3, §4.2): the page's only primary, a `+` on a phone's
 * app bar. The provider's one dialog opens (#3003) and returns focus to it.
 */
export function addRemoteInstanceAction(
  instances: Pick<InstanceManager, "openInstanceDialog">,
  buttonRef: RefObject<HTMLButtonElement | null>,
): PagePrimaryAction {
  return {
    label: "Add Remote Instance…",
    buttonRef,
    onClick: () => instances.openInstanceDialog({ mode: "add", returnFocus: buttonRef.current }),
  };
}

/** A remote's last connection as a fact (§5.2): "Last connected 5h ago", or "Never connected". */
export function lastConnection(profile: InstanceProfile): string {
  const parsed = profile.lastConnectedAt ? Date.parse(profile.lastConnectedAt) : Number.NaN;
  return Number.isFinite(parsed) ? `Last connected ${relativeTime(parsed)}` : "Never connected";
}

type RowAction = "switch" | "retry" | "remove";

/** A failed switch, retry or removal, shown under its row (§13.2): a sentence, and the raw words behind Show Details. */
interface RowFailure {
  message: string;
  detail: string;
}

/**
 * What each row is doing, and how its last action ended (#3002). A Switch or Retry makes the shell
 * give way to the recovery screen while the instance opens (`DesktopInstanceBoundary`), which
 * unmounts this list and mounts the recovery screen's own, and the shell's list again once it is
 * open. So the state lives beside the component, keyed by profile, and the list on screen shows the
 * busy button and then the notice under the row that was pressed. `attempts` remembers a finished
 * Switch or Retry and the connection it opened (`InstanceManager.currentConnection`): the provider
 * reports a failed connection as its `failed` phase, not by throwing, and the row speaks for that
 * connection only, never for a later one (an edit, a re-pair or another Retry) that fails too.
 */
interface RowAttempt {
  action: Exclude<RowAction, "remove">;
  connection: number;
}

interface RowFeedback {
  pending: Readonly<Record<string, RowAction>>;
  attempts: Readonly<Record<string, RowAttempt>>;
  failures: Readonly<Record<string, RowFailure>>;
}

const EMPTY_FEEDBACK: RowFeedback = { pending: {}, attempts: {}, failures: {} };
let rowFeedback = EMPTY_FEEDBACK;
const rowFeedbackListeners = new Set<() => void>();

function updateRowFeedback(change: (current: RowFeedback) => RowFeedback) {
  rowFeedback = change(rowFeedback);
  for (const listener of rowFeedbackListeners) listener();
}
function subscribeRowFeedback(listener: () => void) {
  rowFeedbackListeners.add(listener);
  return () => { rowFeedbackListeners.delete(listener); };
}
const readRowFeedback = () => rowFeedback;

/** Forgets every row's progress and failures. For tests, which mount the list many times. */
export function resetInstanceRowFeedback() {
  updateRowFeedback(() => EMPTY_FEEDBACK);
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _drop, ...rest } = record;
  return rest;
}

const FAILURE_SENTENCES: Record<RowAction, (label: string) => string> = {
  switch: (label) => `Couldn't switch to “${label}”. Try again.`,
  retry: (label) => `Couldn't reconnect to “${label}”. Try again.`,
  remove: (label) => `Couldn't remove “${label}”. Try again.`,
};

/**
 * A remote row's More Actions (§5.2, §9.1): Edit…, Re-Pair…, Copy Address, then Remove…, last and
 * after a separator. A menu item unmounts with its menu, so each one focuses ⋯ first, and a dialog
 * or the confirmation returns focus there.
 */
function InstanceMenu({ profile, busy, onRemove }: {
  profile: InstanceProfile;
  busy: boolean;
  onRemove: (trigger: HTMLButtonElement | null) => void;
}) {
  const instances = useInstances();
  const { showToast } = useFeedback();
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "instance-row-menu");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const name = `More Actions for ${profile.label}`;

  const choose = (action: (trigger: HTMLButtonElement | null) => void) => {
    const trigger = menu.triggerRef.current;
    trigger?.focus();
    menu.close(false);
    action(trigger);
  };
  const copyAddress = async (trigger: HTMLButtonElement | null) => {
    // A refused write falls back only while focus is still where the copy left it (`writeClipboardText`).
    const current = () => mountedRef.current && (document.activeElement === null
      || document.activeElement === document.body || document.activeElement === trigger);
    const result = await writeClipboardText(profile.origin, current);
    if (result === null) return;
    if (document.activeElement === document.body || document.activeElement === null) trigger?.focus();
    if (result) showToast("Copied the address.", { tone: "success" });
    else showToast("Couldn't copy the address.", { tone: "error" });
  };

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm"
        disabled={busy}
        aria-busy={busy || undefined}
        title={name}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
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
          label={name}
          align="end"
          sheetTitle="More Actions"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem icon={<EditIcon />} data-menu-label="Edit…" aria-haspopup="dialog"
            onClick={() => choose((trigger) => instances.openInstanceDialog({ mode: "edit", profileId: profile.id, returnFocus: trigger }))}>
            Edit…
          </MenuItem>
          <MenuItem icon={<KeyIcon />} data-menu-label="Re-Pair…" aria-haspopup="dialog"
            onClick={() => choose((trigger) => instances.openInstanceDialog({ mode: "repair", profileId: profile.id, returnFocus: trigger }))}>
            Re-Pair…
          </MenuItem>
          <MenuItem icon={<CopyIcon />} data-menu-label="Copy Address" onClick={() => choose((trigger) => void copyAddress(trigger))}>
            Copy Address
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<DeleteIcon />} danger data-menu-label="Remove…" aria-haspopup="dialog" onClick={() => choose(onRemove)}>
            Remove…
          </MenuItem>
        </MenuSurface>
      )}
    </>
  );
}

/**
 * Connections › Instances (docs/design-system.md §5.1–§5.2, #3002): one surface of two-line rows in
 * registry order, This Machine first. A row leads with the instance tile (§4.1), names the instance
 * with its one status word (`instanceAvailabilityMeta`, §11.2) and says on line 2 where it is or,
 * when something is wrong, what (`describeInstanceFailure`). It ends with at most one button chosen
 * by state, then ⋯ for a remote. Add Remote Instance… is the page header's primary
 * (`addRemoteInstanceAction`); `addButtonRef` is where focus goes after a removal.
 *
 * The `recovery` variant sits under the recovery screen's status panel (#3004), which already says
 * what is wrong with the active instance and offers its next step. So the active row says it once
 * there: line 2 is its address and last connection, its slot is empty and no notice follows it.
 * While a link names an instance that is not saved (Not Found), no row is current, so This Machine
 * offers Switch.
 */
export function InstancesPanel({ addButtonRef, variant = "page" }: {
  addButtonRef?: RefObject<HTMLButtonElement | null>;
  variant?: "page" | "recovery";
}) {
  const instances = useInstances();
  const recovery = variant === "recovery";
  const connection = useActiveInstanceConnection();
  const { confirm } = useFeedback();
  const { pending: busy, attempts, failures } = useSyncExternalStore(subscribeRowFeedback, readRowFeedback);

  const run = async (profile: InstanceProfile, action: RowAction, operation: () => Promise<void>) => {
    updateRowFeedback((current) => ({
      pending: { ...current.pending, [profile.id]: action },
      attempts: without(current.attempts, profile.id),
      failures: without(current.failures, profile.id),
    }));
    try {
      await operation();
      // A switch or retry reports a failed connection through the provider's phase, not by throwing;
      // once it settles, the provider's current connection is the one it opened.
      const opened = instances.currentConnection?.();
      if (action !== "remove" && opened !== undefined) {
        updateRowFeedback((current) => ({ ...current, attempts: { ...current.attempts, [profile.id]: { action, connection: opened } } }));
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      updateRowFeedback((current) => ({
        ...current,
        failures: { ...current.failures, [profile.id]: { message: FAILURE_SENTENCES[action](profile.label), detail } },
      }));
    } finally {
      updateRowFeedback((current) => ({ ...current, pending: without(current.pending, profile.id) }));
    }
  };
  const dismiss = (profileId: string) => updateRowFeedback((current) => ({
    ...current,
    attempts: without(current.attempts, profileId),
    failures: without(current.failures, profileId),
  }));

  const remove = async (profile: InstanceProfile) => {
    const active = profile.id === instances.activeProfile.id;
    const accepted = await confirm({
      title: "Remove Instance",
      message: `“${profile.label}” and its saved credential are removed from this app${active ? ", and Wollipog switches to This Machine" : ""}. Nothing on ${profile.label} is deleted.`,
      confirmLabel: "Remove Instance",
      tone: "danger",
    });
    if (!accepted) return;
    await run(profile, "remove", async () => {
      await instances.removeInstance(profile.id);
      window.setTimeout(() => addButtonRef?.current?.focus(), 0);
    });
  };

  return (
    <div className="surface instance-list">
      {instances.registry.profiles.map((profile) => {
        // A missing instance is active only in name: nothing is open, so no row is current.
        const active = profile.id === instances.activeProfile.id && !(recovery && instances.phase === "missing");
        // The recovery screen's panel speaks for the active instance (#3004).
        const panelSpeaks = recovery && active;
        const status = instanceStatus(instances, connection, profile.id);
        const meta = instanceAvailabilityMeta(status.availability);
        const pending = busy[profile.id];
        const problem = profile.kind === "remote" && !panelSpeaks ? describeInstanceFailure(status) : null;
        const pairing = status.availability === "authentication-required" || status.availability === "missing-credential";
        // A thrown failure (a removal), else a Switch or Retry from a list whose own connection failed.
        const attempt = attempts[profile.id];
        const attemptFailed = attempt !== undefined && active && !panelSpeaks && instances.phase === "failed"
          && attempt.connection === instances.currentConnection?.();
        const failure: RowFailure | undefined = failures[profile.id] ?? (attemptFailed ? {
          message: FAILURE_SENTENCES[attempt.action](profile.label),
          detail: instances.error ?? status.message ?? "",
        } : undefined);

        // One slot, chosen by state (§5.2): a switch keeps its Switch through Connecting.
        let slot: ReactNode = null;
        if (panelSpeaks) {
          // The panel above says how it is going, and holds the next step.
        } else if (pending === "retry") {
          slot = <BusyButton className="btn sm" busy progress={`Reconnecting to ${profile.label}…`} icon={<RefreshIcon size={14} />}>Retry</BusyButton>;
        } else if (pending === "switch" || (active && status.availability === "connecting")) {
          slot = (
            <BusyButton className="btn sm" busy progress={`Switching to ${profile.label}…`} icon={<ArrowLeftRightIcon size={14} />}>
              Switch
            </BusyButton>
          );
        } else if (pairing) {
          if (profile.kind === "remote") {
            slot = (
              <button type="button" className="btn sm" aria-haspopup="dialog" disabled={pending !== undefined}
                onClick={(event) => instances.openInstanceDialog({ mode: "repair", profileId: profile.id, returnFocus: event.currentTarget })}>
                <KeyIcon size={14} />
                <span>Re-Pair…</span>
              </button>
            );
          }
        } else if (status.availability === "incompatible") {
          // Nothing here fixes it: the other computer needs an update.
        } else if (active && status.availability === "offline") {
          slot = (
            <BusyButton className="btn sm" busy={false} progress={`Reconnecting to ${profile.label}…`} icon={<RefreshIcon size={14} />}
              disabled={pending !== undefined} onClick={() => void run(profile, "retry", () => instances.retryActive())}>
              Retry
            </BusyButton>
          );
        } else if (active) {
          slot = <span className="instance-row-current"><CheckIcon size={14} />Current</span>;
        } else {
          slot = (
            <BusyButton className="btn sm" busy={false} progress={`Switching to ${profile.label}…`} icon={<ArrowLeftRightIcon size={14} />}
              disabled={pending !== undefined} onClick={() => void run(profile, "switch", () => instances.switchInstance(profile.id))}>
              Switch
            </BusyButton>
          );
        }

        return (
          <React.Fragment key={profile.id}>
            <div
              className="row row-2 instance-row"
              data-instance-id={profile.id}
              data-instance-status={meta ? status.availability : undefined}
              aria-busy={pending !== undefined || status.availability === "connecting" || undefined}
            >
              <span className="instance-monogram tile" aria-hidden="true">
                {instanceMonogram(profile.label)}
                {meta && <span className={`instance-tile-dot ${statusToneClass(meta.tone)}${meta.hollow ? " hollow" : ""}`} />}
              </span>
              <span className="row-body">
                <span className="row-line">
                  <span className="row-title" title={profile.label}>{profile.label}</span>
                  {meta && <StatusBadge meta={meta} />}
                </span>
                <span className="row-sub instance-row-sub">
                  {profile.kind === "local" ? (
                    <span>On this machine</span>
                  ) : problem ? (
                    <>
                      <span>{problem}</span>
                      <span className="instance-row-last">{lastConnection(profile)}</span>
                    </>
                  ) : (
                    <>
                      <span className="instance-row-address" title={profile.origin}>{profile.origin}</span>
                      <span className="instance-row-last">{lastConnection(profile)}</span>
                    </>
                  )}
                </span>
              </span>
              <span className="instance-row-actions">
                {slot}
                {profile.kind === "remote" ? (
                  <InstanceMenu profile={profile} busy={pending !== undefined} onRemove={() => void remove(profile)} />
                ) : (
                  // This Machine has no menu; it keeps the menu's room so every slot ends at one edge.
                  <span className="instance-row-menu-room" aria-hidden="true" />
                )}
              </span>
            </div>
            {failure && (
              <Notice compact tone="danger" role="alert" details={failure.detail || undefined}
                onDismiss={() => dismiss(profile.id)}>
                {failure.message}
              </Notice>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
