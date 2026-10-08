import React from "react";
import type { SessionStatus } from "@wollipog/protocol";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { Spinner } from "./common.js";

export type TranscriptEmptyKind = "awaiting" | "starting" | "ended";

/** Which empty transcript a session with no activity shows (#2172): one that is starting says so, one
 * that ended before anything was sent says that, and every other session is waiting for its first
 * message. */
export function transcriptEmptyKind(session: { status: SessionStatus; archived?: boolean }): TranscriptEmptyKind {
  if (session.archived) return "ended";
  if (session.status === "queued" || session.status === "starting") return "starting";
  if (session.status === "completed" || session.status === "failed" || session.status === "stopped") return "ended";
  return "awaiting";
}

/** "Claude Code is ready in Wollipog on Build Box.", leaving out whichever place is unknown. */
export function transcriptReadySentence(agent: string, project: string | undefined, machine: string | undefined): string {
  return `${agent} is ready${project ? ` in ${project}` : ""}${machine ? ` on ${machine}` : ""}.`;
}

/** The reading column's empty transcript (docs/design-system.md §12.1): a compact state at its top
 * left. Starting has a spinner tile; a session that ended before any activity offers nothing here,
 * because the session notice slot carries the way back (#2202). */
export function TranscriptEmptyState({
  kind,
  agent,
  project,
  machine,
  onBrowseFiles,
}: {
  kind: TranscriptEmptyKind;
  agent: string;
  project?: string;
  machine?: string;
  /** Opens the Files tab. Absent where the session has no Files tab to open. */
  onBrowseFiles?: () => void;
}) {
  if (kind === "starting") {
    return <State compact icon={<Spinner decorative />} title={`Starting ${agent}`} />;
  }
  if (kind === "ended") {
    return (
      <State compact title="No Messages">
        This session ended before anything was sent.
      </State>
    );
  }
  return (
    <State
      compact
      title="Start the Conversation"
      actions={onBrowseFiles && <button className="btn" type="button" onClick={onBrowseFiles}>Browse Files</button>}
    >
      {transcriptReadySentence(agent, project, machine)}
    </State>
  );
}

/** How much of the history arrived, and from where, for the history notice's body. An offline
 * machine is why the rest cannot arrive yet, so the sentence says so (#2773). */
export function transcriptHistoryLoadedSentence(
  loaded: number,
  total: number | undefined,
  machine: string | undefined,
  machineOffline = false,
): string {
  const from = machine
    ? ` from ${machine}${machineOffline ? ", which is offline" : ""}`
    : machineOffline ? " while its machine is offline" : "";
  if (loaded <= 0) return `No activity loaded${from}.`;
  const events = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"}`;
  if (total !== undefined && total > loaded) return `Loaded ${loaded.toLocaleString("en-US")} of ${events(total)}${from}.`;
  return `Loaded ${events(loaded)}${from}.`;
}

/** The reading column's one history notice (§12.4, §13.2), sticky at its top. A failed or partial
 * load is a danger notice with Retry and the raw error behind Show Details, whether or not anything
 * loaded; cached content shown while disconnected is a neutral sentence. */
export function TranscriptHistoryNotice({
  kind,
  error,
  loaded,
  total,
  machine,
  machineOffline = false,
  canRetry,
  onRetry,
}: {
  kind: "stale" | "error";
  error: string | null;
  /** Events this device holds for the session. */
  loaded: number;
  /** The session's event count, when the snapshot reports one. */
  total?: number;
  machine?: string;
  /** The session's machine is offline, so the rest of its history cannot load yet. */
  machineOffline?: boolean;
  canRetry: boolean;
  onRetry: () => void;
}) {
  if (kind === "stale") {
    return (
      <Notice compact tone="neutral" role="status" className="transcript-history-notice" dataState="stale">
        Showing cached activity while disconnected.
      </Notice>
    );
  }
  return (
    <Notice
      compact
      tone="danger"
      role="status"
      className="transcript-history-notice"
      dataState="error"
      title="Couldn't Load the Full Conversation"
      actions={<button className="btn sm" type="button" disabled={!canRetry} onClick={onRetry}>Retry</button>}
      details={error ? <code className="transcript-history-error">{error}</code> : undefined}
    >
      {transcriptHistoryLoadedSentence(loaded, total, machine, machineOffline)}
    </Notice>
  );
}
