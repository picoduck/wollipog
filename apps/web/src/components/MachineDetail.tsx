import React, { useState, type ReactNode } from "react";
import { runnerCapabilityRequirement, runnerSupportsProtocol, type BoxView, type RunnerView } from "@wollipog/protocol";
import type { RunnerCapacityDimensions } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { describeSshFailure, osLabel, relativeTime } from "../format.js";
import {
  formatAdmissionPolicy,
  formatExecutionIsolation,
  machineStatus,
  nativeRunnerUpdateHint,
  runnerDisplay,
  runnerOutdated,
  sshRunnerLifecycleHint,
  type MachineListEntry,
} from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { activeSessionConflict } from "./active-session-conflict.js";
import { AgentSessionDiscoveryDialog } from "./AgentSessionDiscoveryDialog.js";
import { CopyButton, Modal, Spinner } from "./common.js";
import { useFeedback, type ConfirmationDetailRow, type ConfirmationOptions } from "./FeedbackProvider.js";
import {
  ComputerIcon,
  DeleteIcon,
  GlobeIcon,
  InfoIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  WifiOffIcon,
  WrenchIcon,
} from "./Icons.js";
import { Notice } from "./Notice.js";
import { ActionsMenu, type ActionsMenuChoice, type PageAction, type PageMenuAction } from "./PageHeader.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * One detail for every machine (#2988, docs/design-system.md §3.3, §11, §13.2): a title row with
 * the name, one status badge, Settings… and ⋯, one meta line of neutral facts, then at most one
 * lifecycle notice, and then the machine's sections, which the caller supplies. A native runner and
 * an SSH machine render the same header; only the ⋯ items and the notice differ.
 */

/** Why Delete Machine… waits on an online native runner: Wollipog cannot stop a runner it did not start. */
export const STOP_RUNNER_TO_DELETE = "Stop the runner to delete.";
/** Why Reconnect waits: an SSH connection is already being made. */
export const CONNECTION_IN_PROGRESS = "Wait for the connection to finish.";
/** Why a lifecycle item waits: another request on this machine is still running. */
export const MACHINE_ACTION_RUNNING = "Wait for the current action to finish.";
const BACK_TO_MORE_ACTIONS = "Back to More Actions";

/** What the person may do to a machine. */
export interface MachineAccess {
  /** An organization owner or admin: every lifecycle action (the gate Manage used). */
  canManage: boolean;
  /** May open Machine Settings: an owner or admin, or this machine's own manager. */
  canOpenSettings: boolean;
  /** May look for sessions started outside Wollipog. Viewers may not. */
  canFindSessions: boolean;
}

export interface LifecycleConflictPresentation {
  message: string;
  /** The interrupted sessions the server listed, for the confirmation's detail rows. */
  detailRows: ConfirmationDetailRow[];
  /** Interrupted sessions the server counted but did not list (beyond its limit, or not visible to
   * this person). */
  detailRowsOverflow: number;
}

export function lifecycleConflictPresentation(
  error: ApiError,
  action: "update" | "reconnect" | "adopt",
): LifecycleConflictPresentation {
  const { count, detailRows, detailRowsOverflow } = activeSessionConflict(error);
  const actionLabel = action === "update" ? "Updating" : action === "reconnect" ? "Reconnecting" : "Adopting legacy data for";
  const message = count == null
    ? `${actionLabel} this runner will interrupt active work.`
    : `${actionLabel} this runner will interrupt ${count} active session${count === 1 ? "" : "s"}.`;
  return { message, detailRows, detailRowsOverflow };
}

const LIFECYCLE_CONFIRMATION_TITLES = {
  update: "Interrupt Sessions and Update",
  reconnect: "Interrupt Sessions and Reconnect",
  adopt: "Interrupt Sessions and Adopt",
} as const;

function isActiveSessionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === "BOX_HAS_ACTIVE_SESSIONS";
}

/**
 * Runs a lifecycle request, and when the machine still has active sessions (`409
 * BOX_HAS_ACTIVE_SESSIONS`) asks to interrupt them, naming each one (§7.4), then runs it forced.
 * Resolves to the request's result, or null when the person kept the sessions.
 */
async function withSessionInterruption<T>(
  confirm: (options: ConfirmationOptions) => Promise<boolean>,
  action: keyof typeof LIFECYCLE_CONFIRMATION_TITLES,
  run: (force: boolean) => Promise<T>,
  back?: ConfirmationOptions["back"],
): Promise<T | null> {
  try {
    return await run(false);
  } catch (cause) {
    if (!isActiveSessionConflict(cause)) throw cause;
    const conflict = lifecycleConflictPresentation(cause, action);
    const title = LIFECYCLE_CONFIRMATION_TITLES[action];
    const approved = await confirm({
      title,
      message: conflict.message,
      detailRows: conflict.detailRows,
      detailRowsOverflow: conflict.detailRowsOverflow,
      confirmLabel: title,
      tone: "danger",
      ...(back ? { back } : {}),
    });
    return approved ? run(true) : null;
  }
}

/**
 * The one Delete Machine confirmation (§7.4), used by the machine's ⋯ and by Machine Settings: what
 * goes, named, and what stays. It waits on the deletion, so a failure stays in the dialog.
 */
export function confirmDeleteMachine(
  confirm: (options: ConfirmationOptions) => Promise<boolean>,
  { name, kind, onDelete, back }: {
    name: string;
    kind: MachineListEntry["kind"];
    onDelete: () => Promise<void>;
    back?: ConfirmationOptions["back"];
  },
): Promise<boolean> {
  const deleted = "its sessions and its multi-agent runs are deleted from Wollipog. Files on the machine stay where they are.";
  return confirm({
    title: "Delete Machine",
    message: kind === "ssh" ? `The connection to ${name} is removed, and ${deleted}` : `${name}, ${deleted}`,
    confirmLabel: "Delete Machine",
    tone: "danger",
    progress: "Deleting the machine…",
    onConfirm: onDelete,
    // A delete request cannot be withdrawn once sent, so Cancel would only hide a deletion that
    // still happens, and drop its failure.
    cancelWhileRunning: false,
    ...(back ? { back } : {}),
  });
}

/** A lifecycle request in flight on one machine. */
type MachineOperation = "rediscover" | "reconnect" | "update" | "adopt";

/** Everything the detail and the phone's detail bar draw from one machine's actions. */
export interface MachineActions {
  /** Settings…, for those who may open Machine Settings. On a phone it leads the detail bar's ⋯. */
  settings: PageAction | null;
  /** ⋯ Machine Actions, in order (§9.1). */
  menu: PageMenuAction[];
  /** The one lifecycle notice, or null (§13.2). */
  notice: ReactNode;
  /** Connection Details and Find Agent Sessions, while open. */
  dialogs: ReactNode;
}

/**
 * The selected machine's actions. State is keyed by the machine, so a request still running on
 * one machine never shows as running on the next one selected. Results are toasts (§13.1).
 */
export function useMachineActions(entry: MachineListEntry | null, access: MachineAccess, handlers: {
  onSettings: (runnerId: string) => void;
  onRepair: (runnerId: string) => void;
}): MachineActions {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const [operations, setOperations] = useState<Record<string, MachineOperation>>({});
  const [connectionDetailsFor, setConnectionDetailsFor] = useState<string | null>(null);
  const [findingSessionsFor, setFindingSessionsFor] = useState<string | null>(null);
  if (!entry) return { settings: null, menu: [], notice: null, dialogs: null };

  const { runnerId, runner, box, name } = entry;
  const operation = operations[runnerId];
  const run = async (kind: MachineOperation, task: () => Promise<void>) => {
    setOperations((current) => ({ ...current, [runnerId]: kind }));
    try {
      await task();
    } finally {
      setOperations(({ [runnerId]: _done, ...rest }) => rest);
    }
  };
  const backTo = (choice?: ActionsMenuChoice) => choice ? { label: BACK_TO_MORE_ACTIONS, run: choice.reopen } : undefined;
  const target = box?.sshTarget ?? name;

  const rediscover = () => void run("rediscover", async () => {
    try {
      await api.rediscover(runnerId);
      // The request returns at once; the agents stream in. Keep the spinner briefly so the press
      // is seen to do something.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (error) {
      showToast(`Couldn't rediscover agents on ${name}.`, { tone: "error", detail: (error as Error).message });
    }
  });
  const reconnect = (choice?: ActionsMenuChoice) => {
    if (!box) return;
    void run("reconnect", async () => {
      try {
        await withSessionInterruption(confirm, "reconnect", (force) => api.reconnectBox(box.boxId, force), backTo(choice));
      } catch (error) {
        showToast(`Couldn't reconnect ${name}.`, {
          tone: "error",
          detail: describeSshFailure((error as Error).message, target, { status: error instanceof ApiError ? error.status : null }),
        });
      }
    });
  };
  const updateRunner = () => {
    if (!box) return;
    void run("update", async () => {
      try {
        const result = await withSessionInterruption(confirm, "update", (force) => api.updateBoxRunner(box.boxId, force));
        if (!result) return;
        const build = `Build ${result.expectedVersion} from ${result.source === "staged" ? "a local development build" : `release ${result.releaseTag}`}.`;
        if (result.status === "already_current") showToast("Already up to date.", { tone: "success", detail: build });
        else if (result.status === "started") {
          showToast("Deploying the update. The status changes when the runner is back online.", { tone: "info", detail: build });
        } else showToast("Another connection action took over. The update installs on the next reconnect.", { tone: "info", detail: build });
      } catch (error) {
        showToast(`Couldn't update the runner on ${name}.`, { tone: "error", detail: (error as Error).message });
      }
    });
  };
  const adoptLegacyData = () => {
    if (!box) return;
    void (async () => {
      const approved = await confirm({
        title: "Adopt Legacy Data",
        message: `Confirm that every legacy runner process using this SSH account on ${name} is stopped. Wollipog keeps the existing state and allows one migration attempt.`,
        confirmLabel: "Adopt Legacy Data",
      });
      if (!approved) return;
      await run("adopt", async () => {
        try {
          await withSessionInterruption(confirm, "adopt", (force) => api.adoptLegacyBoxData(box.boxId, force));
        } catch (error) {
          showToast(`Couldn't adopt the legacy data on ${name}.`, { tone: "error", detail: (error as Error).message });
        }
      });
    })();
  };
  const deleteMachine = (choice?: ActionsMenuChoice) => void confirmDeleteMachine(confirm, {
    name,
    kind: entry.kind,
    onDelete: () => box ? api.removeBox(box.boxId).then(() => undefined) : api.removeRunner(runnerId).then(() => undefined),
    back: backTo(choice),
  });
  const showConnectionDetails = () => setConnectionDetailsFor(runnerId);

  const online = runner?.status === "online";
  const nativeOffline = !box && !online;
  const inProgress = box?.status === "bootstrapping" || box?.status === "deploying";
  const pv = runner?.protocolVersion;
  const sessionsSupported = runnerSupportsProtocol(pv, "externalSessions");
  const busyReason = operation ? { description: MACHINE_ACTION_RUNNING } : {};
  // The first item repairs or refreshes the connection: Repair while a native runner is offline.
  const connectionAction: PageMenuAction = nativeOffline
    ? { label: "Repair Connection…", icon: <WrenchIcon />, onClick: () => handlers.onRepair(runnerId) }
    : box
    ? {
      label: "Reconnect",
      icon: operation === "reconnect" ? <Spinner decorative /> : <RefreshIcon />,
      disabled: inProgress || operation !== undefined,
      ...(inProgress ? { description: CONNECTION_IN_PROGRESS } : busyReason),
      onClick: (choice) => reconnect(choice),
    }
    : {
      label: "Rediscover Agents",
      icon: operation === "rediscover" ? <Spinner decorative /> : <RefreshIcon />,
      disabled: operation !== undefined,
      ...busyReason,
      onClick: rediscover,
    };
  const findSessions: PageMenuAction[] = online && access.canFindSessions ? [{
    label: "Find Agent Sessions…",
    icon: <SearchIcon />,
    disabled: !sessionsSupported,
    ...(sessionsSupported ? {} : { description: runnerCapabilityRequirement(pv, "externalSessions", "finding agent sessions") }),
    onClick: () => setFindingSessionsFor(runnerId),
  }] : [];
  const connectionDetails: PageMenuAction = { label: "Connection Details…", icon: <InfoIcon />, onClick: showConnectionDetails };
  // Lifecycle items are for owners and admins; a viewer's ⋯ is Connection Details… alone.
  const menu: PageMenuAction[] = !access.canManage ? [...findSessions, connectionDetails] : [
    connectionAction,
    ...findSessions,
    connectionDetails,
    {
      label: "Delete Machine…",
      icon: <DeleteIcon />,
      danger: true,
      disabled: !box && online,
      ...(!box && online ? { description: STOP_RUNNER_TO_DELETE } : {}),
      onClick: deleteMachine,
    },
  ];

  const settings = access.canOpenSettings ? { label: "Settings…", onClick: () => handlers.onSettings(runnerId) } : null;
  const notice = machineNotice(entry, access, {
    operation,
    onRepair: () => handlers.onRepair(runnerId),
    onConnectionDetails: showConnectionDetails,
    onReconnect: () => reconnect(),
    onUpdate: updateRunner,
    onAdopt: adoptLegacyData,
  });
  const dialogs = (
    <>
      {connectionDetailsFor === runnerId && (
        <ConnectionDetailsDialog runner={runner} box={box} name={name} runnerId={runnerId} onClose={() => setConnectionDetailsFor(null)} />
      )}
      {findingSessionsFor === runnerId && runner && (
        <AgentSessionDiscoveryDialog runner={runner} onClose={() => setFindingSessionsFor(null)} />
      )}
    </>
  );
  return { settings, menu, notice, dialogs };
}

/** Which lifecycle notice a machine shows, the first that applies (§13.2), or null. */
export type MachineNoticeKind = "offline" | "connection_failed" | "connecting" | "update_required" | "legacy_data";

export function machineNoticeKind(runner: RunnerView | undefined, box: BoxView | undefined): MachineNoticeKind | null {
  if (box) {
    // A failed bootstrap, or an SSH session that ended with an error, could not connect; one that
    // simply ended is offline.
    if (box.status === "failed" || (box.status === "offline" && box.lastError)) return "connection_failed";
    if (box.status === "offline" || (box.status === "online" && runner && runner.status !== "online")) return "offline";
    if (box.status === "bootstrapping" || box.status === "deploying" || !runner) return "connecting";
    // Only a known older protocol proves the deployed runner is out of date; an unknown one is not
    // a reason to redeploy.
    if (runnerOutdated(runner.protocolVersion)) return "update_required";
    if (box.runnerDataLayout === "legacy") return "legacy_data";
    return null;
  }
  if (!runner || runner.status !== "online") return "offline";
  return nativeRunnerUpdateHint(runner.protocolVersion) ? "update_required" : null;
}

function machineNotice(entry: MachineListEntry, access: MachineAccess, actions: {
  operation: MachineOperation | undefined;
  onRepair: () => void;
  onConnectionDetails: () => void;
  onReconnect: () => void;
  onUpdate: () => void;
  onAdopt: () => void;
}): ReactNode {
  const { runner, box, name } = entry;
  const kind = machineNoticeKind(runner, box);
  const busy = actions.operation !== undefined;
  const reconnect = (label: string) => (
    <BusyButton className="btn sm" busy={actions.operation === "reconnect"} progress={`Reconnecting ${name}…`}
      disabled={busy && actions.operation !== "reconnect"} onClick={actions.onReconnect}>
      {label}
    </BusyButton>
  );
  const legacy = legacyDataState(box);
  const adoptLegacyData = (
    <BusyButton className="btn sm" busy={actions.operation === "adopt" || legacy === "pending"} progress="Adopting the legacy data…"
      disabled={busy && actions.operation !== "adopt"} onClick={actions.onAdopt}>
      Adopt Legacy Data…
    </BusyButton>
  );
  // A runner refuses to start on older data until it is adopted, so a machine that cannot connect
  // keeps the adoption within reach even though its connection notice outranks the data's own.
  const blockedByLegacyData = legacy === "adoptable" || legacy === "pending";
  const legacySentence = blockedByLegacyData &&
    <p>It has older runner data, which its runner needs adopted before it can start.</p>;
  if (kind === "offline") {
    const ssh = Boolean(box);
    return (
      <Notice tone="neutral" icon={<WifiOffIcon />} role="status" title="This Machine Is Offline"
        actions={access.canManage && (
          <>
            {ssh ? reconnect("Reconnect")
              : <button type="button" className="btn sm" onClick={actions.onRepair}>Repair Connection…</button>}
            {blockedByLegacyData && adoptLegacyData}
            <button type="button" className="btn sm" onClick={actions.onConnectionDetails}>Connection Details…</button>
          </>
        )}>
        <p>{ssh
          ? "The SSH session to this machine ended, so Wollipog can't reach its runner."
          : "Wollipog can't reach its runner. The runner may have stopped, or its credential may no longer work."}</p>
        {legacySentence}
        {!access.canManage && <p>{ssh
          ? "Ask an organization owner or admin to reconnect this machine."
          : "Ask an organization owner or admin to repair this connection."}</p>}
      </Notice>
    );
  }
  if (kind === "connection_failed" && box) {
    return (
      <Notice tone="danger" role="alert" title={`Couldn't Connect to ${name}`}
        actions={access.canManage && <>{reconnect("Try Again")}{blockedByLegacyData && adoptLegacyData}</>}
        details={box.lastError ? <pre className="machine-notice-error">{box.lastError}</pre> : undefined}>
        <p>{describeSshFailure(box.lastError, box.sshTarget)}</p>
        {legacySentence}
      </Notice>
    );
  }
  if (kind === "connecting") {
    return (
      <Notice tone="info" role="status" title="Connecting…">
        <p>Waiting for the runner to come online.</p>
      </Notice>
    );
  }
  if (kind === "update_required" && runner) {
    if (box) {
      return (
        <Notice tone="warning" role="status" title="Runner Update Required"
          actions={access.canManage && (
            <BusyButton className="btn sm" busy={actions.operation === "update"} progress={`Checking for a runner update on ${name}…`}
              disabled={busy && actions.operation !== "update"} onClick={actions.onUpdate}>
              Update Runner…
            </BusyButton>
          )}>
          <p>This machine&apos;s runner is out of date.</p>
        </Notice>
      );
    }
    return (
      <Notice tone="warning" role="status" title="Runner Update Required"
        details={<p>Standalone installs should rerun the matching <code>scripts/install-runner</code> installer
          before relaunching. See <code>docs/runner-updates.md</code>.</p>}>
        <p>{nativeRunnerUpdateHint(runner.protocolVersion)}</p>
      </Notice>
    );
  }
  if (kind === "legacy_data" && box) {
    return (
      <Notice tone="warning" role="status" title="Older Runner Data Found"
        actions={access.canManage && blockedByLegacyData && adoptLegacyData}>
        <p>{legacy === "adopted"
          ? "This SSH account's legacy data is already adopted. This machine keeps its own runner data and needs no other adoption."
          : legacy === "elsewhere"
          ? "Another machine on this SSH account is adopting the shared legacy data. This machine waits until that finishes."
          : legacy === "pending"
          ? "The legacy data adoption is in progress."
          : "This machine predates separate runner data. Stop every legacy runner on its SSH account, then adopt its data once."}</p>
      </Notice>
    );
  }
  return null;
}

/**
 * Where an SSH machine's older runner data stands, or null for a machine without any: one to
 * adopt, its adoption under way, another machine on the SSH account adopting it, or adopted.
 */
export function legacyDataState(box: BoxView | undefined): "adoptable" | "pending" | "elsewhere" | "adopted" | null {
  if (box?.runnerDataLayout !== "legacy") return null;
  if (box.legacyDataAccountStatus === "adopted") return "adopted";
  if (box.legacyDataAdoption?.status === "pending") return "pending";
  return box.legacyDataAccountStatus === "pending" ? "elsewhere" : "adoptable";
}

/** The meta line's facts (§11.3): the kind, the host, the OS, and when offline, when it was last seen. */
export function machineMetaFacts(runner: RunnerView | undefined, box: BoxView | undefined): Array<{ key: string; text: string }> {
  const facts = [{ key: "kind", text: box ? "SSH" : "Native Runner" }];
  const host = box?.sshTarget ?? runner?.hostname;
  if (host) facts.push({ key: "host", text: host });
  if (runner) facts.push({ key: "os", text: osLabel(runner.os) });
  if (runner && runner.status !== "online" && runner.lastSeen) facts.push({ key: "seen", text: `Last seen ${relativeTime(runner.lastSeen)}` });
  return facts;
}

/**
 * The machine's header and its one notice, then its sections. `showTitle` is false on a phone,
 * where the detail bar carries the name, Settings… and ⋯; the body keeps the badge and the meta.
 */
export function MachineDetail({ entry, actions, showTitle, children }: {
  entry: MachineListEntry;
  actions: MachineActions;
  showTitle: boolean;
  children?: ReactNode;
}) {
  const { runner, box, name } = entry;
  const badge = <StatusBadge meta={statusMeta("machine", machineStatus(runner, box))} className="machine-detail-status" />;
  return (
    <article className="machine-detail" data-kind={entry.kind} aria-label={name}>
      <header className="machine-detail-head">
        <div className="machine-detail-title-row">
          {showTitle && <h2 className="machine-detail-title" title={name}>{name}</h2>}
          {badge}
          {showTitle && (actions.settings || actions.menu.length > 0) && (
            <div className="actions">
              {actions.settings && (
                <button type="button" className="btn" onClick={actions.settings.onClick}>{actions.settings.label}</button>
              )}
              {actions.menu.length > 0 && <ActionsMenu label="Machine Actions" items={actions.menu} />}
            </div>
          )}
        </div>
        <ul className="machine-detail-meta" aria-label="Machine Details">
          {machineMetaFacts(runner, box).map((fact) => (
            <li key={fact.key} data-fact={fact.key} title={fact.text}>
              {fact.key === "kind" && (box ? <GlobeIcon size={14} aria-hidden="true" /> : <ComputerIcon size={14} aria-hidden="true" />)}
              <span>{fact.text}</span>
            </li>
          ))}
        </ul>
      </header>
      {actions.notice}
      {children}
      {actions.dialogs}
    </article>
  );
}

/** The phone's detail bar ⋯: Settings… first, then the machine's own items (§4.3, §15.1). */
export function phoneMachineMenu(actions: MachineActions): PageMenuAction[] {
  return [
    ...(actions.settings ? [{ label: actions.settings.label, icon: <SettingsIcon />, onClick: actions.settings.onClick }] : []),
    ...actions.menu,
  ];
}

const NOT_AVAILABLE = "Not available";

interface ConnectionFact {
  label: string;
  /** null reads "Not available". */
  value: string | null;
  /** Shown in the monospace face, as ids and paths are (§11.3). */
  mono?: boolean;
  copy?: boolean;
  /** Extra content after the value, which Copy All leaves out. */
  extra?: ReactNode;
}

const IDLE_PROCESS_POLICY_LABELS = {
  park_when_needed: "Park When Needed",
  retain: "Retain Idle Processes",
} as const satisfies Record<RunnerCapacityDimensions["idleProcessPolicy"], string>;

/** The facts Connection Details lists, in order (#2988), and the text Copy All puts on the clipboard. */
export function connectionFacts(runner: RunnerView | undefined, box: BoxView | undefined, runnerId: string): ConnectionFact[] {
  const runtime = runner?.runtime;
  const pv = runner?.protocolVersion;
  const admission = runtime ? formatAdmissionPolicy(runtime) : null;
  const idleProcesses = runner?.capacity?.dimensions?.idleProcessPolicy;
  return [
    { label: "Connection", value: box ? "SSH" : "Native Runner" },
    box
      ? { label: "SSH Target", value: box.sshTarget, mono: true, copy: true }
      : { label: "Machine ID", value: runnerId, mono: true, copy: true },
    { label: "Host", value: runner?.hostname?.trim() || null },
    { label: "Operating System", value: runner ? osLabel(runner.os) : null },
    {
      label: "Runner Version",
      value: runner?.version?.trim() || null,
      extra: runner && (
        <>
          {pv != null && <span className="connection-fact-note">Protocol v{pv}</span>}
          {runnerOutdated(pv) && <StatusBadge meta={statusMeta("machine", "update_required")} />}
        </>
      ),
    },
    { label: "Last Seen", value: runner?.lastSeen ? relativeTime(runner.lastSeen) : null },
    { label: "Worktree Storage", value: runtime?.worktreeRoot?.trim() || null, mono: true, copy: true },
    { label: "Sandboxing", value: runtime ? formatExecutionIsolation(runtime) : null },
    ...(admission ? [{ label: "Admission Policy", value: admission }] : []),
    // Capacity's idle-process policy, set on the machine itself (#2989).
    {
      label: "Idle Processes",
      value: idleProcesses ? IDLE_PROCESS_POLICY_LABELS[idleProcesses] : null,
      extra: idleProcesses && <span className="connection-fact-note">Set in <code>runner.config.json</code></span>,
    },
    ...(box ? [
      { label: "Deployed Build", value: box.deployedVersion?.trim() || null, mono: true, copy: true },
      { label: "Platform", value: box.triple?.trim() || null, mono: true },
    ] : []),
  ];
}

/** A plain-text block of every listed fact, for a support request. */
export function connectionFactsText(name: string, facts: readonly ConnectionFact[], protocolVersion?: number | null): string {
  return [
    name,
    ...facts.map((fact) => {
      const value = fact.value ?? NOT_AVAILABLE;
      return `${fact.label}: ${fact.label === "Runner Version" && protocolVersion != null ? `${value} (Protocol v${protocolVersion})` : value}`;
    }),
  ].join("\n");
}

/**
 * Connection Details (§5.4, §7.3), for every machine: one facts list, the SSH reconnect sentence
 * for an SSH machine, and Copy All beside Done.
 */
export function ConnectionDetailsDialog({ runner, box, name, runnerId, onClose }: {
  runner: RunnerView | undefined;
  box: BoxView | undefined;
  name?: string;
  runnerId: string;
  onClose: () => void;
}) {
  const title = name ?? runnerDisplay(runner, box, runnerId).name;
  const facts = connectionFacts(runner, box, runnerId);
  return (
    <Modal
      title="Connection Details"
      description={title}
      onClose={onClose}
      className="connection-details"
      tertiary={<CopyButton text={connectionFactsText(title, facts, runner?.protocolVersion)} label="Copy All" className="btn ghost" />}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <dl className="facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              {fact.value === null ? <span className="connection-fact-missing">{NOT_AVAILABLE}</span> : (
                <span className="connection-fact">
                  <span className={fact.mono ? "connection-fact-mono" : undefined}>{fact.value}</span>
                  {fact.copy && <CopyButton text={fact.value} iconOnly ariaLabel={`Copy ${fact.label}`} className="icon-btn sm" />}
                </span>
              )}
              {fact.extra}
            </dd>
          </div>
        ))}
      </dl>
      {box && <p className="section-note">{sshRunnerLifecycleHint()}</p>}
    </Modal>
  );
}
