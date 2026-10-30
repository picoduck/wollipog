import React, { useEffect, useRef, useState } from "react";
import type { ArchivedHistoryRetentionView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import {
  RETENTION_LOAD_FAILED,
  RETENTION_NO_PERMISSION,
  RETENTION_SAVE_FAILED,
  RETENTION_UNSUPPORTED,
  parseRetentionDays,
  retentionChangePrunesMore,
  retentionConfirmation,
  retentionCountsLabel,
  retentionDaysError,
  retentionLastRun,
  retentionScheduleSentence,
  retentionSourceSentence,
  retentionSwitchDescription,
} from "../archived-history-retention.js";
import { useInstanceScope } from "../instance-scope.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { NumberRow, SAVED_MS, SettingsGroup, SwitchRow, ValueRow, type RowFailure } from "./ui/SettingsRows.js";
import { publishArchivedHistoryRetention } from "./useArchivedHistoryRetention.js";

type Failure = { message: string; detail?: string };

function failure(cause: unknown, message: string): Failure {
  const detail = cause instanceof ApiError ? cause.message.trim() || undefined : undefined;
  return { message, ...(detail ? { detail } : {}) };
}

function unsupported(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 405 || cause.status === 501);
}

export function ArchivedHistoryRetentionPanel() {
  const instanceScope = useInstanceScope();
  return <ArchivedHistoryRetentionEditor key={instanceScope} />;
}

/**
 * Settings › Storage (#2777, docs/archived-history-retention.md): whether archived sessions lose
 * most of their history, and how many days after archiving.
 *
 * Off by default. Turning it on or shortening the threshold first shows what the new policy would
 * prune and when it starts, as a danger confirmation; turning it off or lengthening it saves at once.
 * The days field keeps the value to use while the switch is off, and saves when it loses focus while
 * the switch is on. Only an organization owner or admin can change either; everyone else reads them.
 */
function ArchivedHistoryRetentionEditor() {
  const api = useApi();
  const { confirm } = useFeedback();
  const currentApi = useRef(api);
  currentApi.current = api;
  const generation = useRef(0);
  const [view, setView] = useState<ArchivedHistoryRetentionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<"switch" | "days" | null>(null);
  const [error, setError] = useState<(Failure & { action: "load" | "save"; days?: number | null; row?: "switch" | "days" }) | null>(null);
  const [isUnsupported, setUnsupported] = useState(false);
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    const started = ++generation.current;
    const current = () => generation.current === started && currentApi.current === api;
    setView(null);
    setLoading(true);
    setError(null);
    setSaved(null);
    setSaving(false);
    void api.archivedHistoryRetention().then((next) => {
      if (!current()) return;
      setView(next);
      setDraft(String(next.retentionDays ?? next.limits.suggestedDays));
      publishArchivedHistoryRetention(api, next);
    }).catch((cause: unknown) => {
      if (!current()) return;
      if (unsupported(cause)) setUnsupported(true);
      else setError({ ...failure(cause, RETENTION_LOAD_FAILED), action: "load" });
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { generation.current++; };
  }, [api, retry]);

  // The check is a moment, not a state (§8.6).
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const apply = (next: ArchivedHistoryRetentionView, row: "switch" | "days") => {
    setView(next);
    setDraft(String(next.retentionDays ?? next.limits.suggestedDays));
    setDraftError(null);
    setSaved(row);
    publishArchivedHistoryRetention(api, next);
  };

  /** Save `days` (null is off). A change that prunes more is confirmed against its own preview. */
  const save = async (days: number | null, row: "switch" | "days") => {
    if (!view || saving) return;
    const started = ++generation.current;
    const current = () => generation.current === started && currentApi.current === api;
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      if (retentionChangePrunesMore(view.retentionDays, days)) {
        const preview = (await api.archivedHistoryRetention(days!)).preview;
        if (!current() || !preview) return;
        // The dialog shows its own progress while it saves; the row stays as it was until then.
        setSaving(false);
        const copy = retentionConfirmation(view.retentionDays, preview);
        const confirmed = await confirm({
          ...copy,
          tone: "danger",
          progress: "Saving archived history retention…",
          // A sent policy change cannot be withdrawn, so the dialog waits for its answer.
          cancelWhileRunning: false,
          onConfirm: async () => {
            const next = await api.updateArchivedHistoryRetention({ retentionDays: days });
            if (current()) apply(next, row);
          },
        });
        // Cancelled: the field shows the policy in effect again.
        if (!confirmed && current()) setDraft(String(view.retentionDays ?? days));
        return;
      }
      const next = await api.updateArchivedHistoryRetention({ retentionDays: days });
      if (current()) apply(next, row);
    } catch (cause) {
      if (current()) setError({ ...failure(cause, RETENTION_SAVE_FAILED), action: "save", days, row });
    } finally {
      if (current()) setSaving(false);
    }
  };

  const toggle = () => {
    if (!view) return;
    if (view.retentionDays !== null) {
      void save(null, "switch");
      return;
    }
    const days = parseRetentionDays(draft, view.limits);
    if (days === null) {
      setDraftError(retentionDaysError(view.limits));
      return;
    }
    void save(days, "switch");
  };

  const commitDays = () => {
    if (!view) return;
    const days = parseRetentionDays(draft, view.limits);
    if (days === null) {
      setDraftError(retentionDaysError(view.limits));
      return;
    }
    setDraftError(null);
    // While retention is off the field only holds the value the switch will use.
    if (view.retentionDays !== null && days !== view.retentionDays) void save(days, "days");
  };

  // Retry repeats what failed: the read, or the change itself.
  const groupFailure: RowFailure | null = error ? {
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    onRetry: () => {
      if (error.action === "save" && error.days !== undefined) void save(error.days, error.row ?? "switch");
      else setRetry((value) => value + 1);
    },
  } : null;
  const canManage = view?.canManage === true;
  const disabled = !view || loading || saving || !canManage;
  const source = view ? retentionSourceSentence(view) : null;
  const schedule = view ? retentionScheduleSentence(view, Date.now()) : undefined;
  const lastRun = view?.lastRun ? retentionLastRun(view.lastRun) : null;
  return (
    <SettingsGroup
      title="Archived Session History"
      intro={view && !canManage ? RETENTION_NO_PERMISSION : isUnsupported ? RETENTION_UNSUPPORTED : undefined}
      notice={source ? <Notice compact tone="neutral" role="note">{source}</Notice> : undefined}
      failure={groupFailure}
      foot={(
        <details className="disclosure">
          <summary><ChevronRightIcon size={14} className="disclosure-chevron" />About Archived History Retention</summary>
          <div className="disclosure-body">
            <p>A prune removes tool calls and their output, file edits, reasoning, and intermediate messages from sessions archived longer than the threshold. Prompts, the final response, usage and cost, and attachments are kept, and the session stays in the archive.</p>
            <p>Turning pruning on or shortening the threshold takes effect 24 hours later, so it can be undone first. Capable machines also trim their session logs after the control plane prunes them. Once a machine has trimmed a log, Reprocess cannot restore its full history. Older machines keep their complete logs.</p>
            <p>The database reuses the space a prune frees, so it stops growing. Making the file smaller needs an offline VACUUM.</p>
          </div>
        </details>
      )}
    >
      <SwitchRow
        title="Prune Archived History"
        description={view ? retentionSwitchDescription(view) : undefined}
        checked={view?.retentionDays != null}
        disabled={disabled || isUnsupported}
        busy={loading || saving}
        busyLabel={loading ? "Loading archived history retention…" : undefined}
        saved={saved === "switch"}
        onClick={toggle}
      />
      <NumberRow
        title="Prune After"
        description="Days after a session is archived."
        unit="days"
        value={draft}
        min={view?.limits.minDays}
        max={view?.limits.maxDays}
        step={1}
        disabled={disabled || isUnsupported}
        error={draftError}
        saved={saved === "days"}
        onChange={(value) => {
          setDraft(value);
          setDraftError(null);
        }}
        onBlur={commitDays}
      />
      {view && view.retentionDays !== null && (
        <ValueRow title="Eligible Now" description={schedule} value={retentionCountsLabel(view.eligible)} />
      )}
      {lastRun && <ValueRow title="Last Pass" description={lastRun.when} value={lastRun.pruned} />}
    </SettingsGroup>
  );
}
