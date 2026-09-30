import { useEffect, useId, useRef, useState } from "react";
import type { RunnerView, SkillAdoptionRecoveryOperation } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { MachineSkillRecovery } from "../skills.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { machineSkillLocation, userFacingMachineError } from "../skill-machine.js";
import type { MachineRequestTracker } from "./SkillMachineImportDialog.js";

/** A journal's state in words (§17.2): what a person sees, not the runner's enum. */
export const RECOVERY_STATE_LABEL: Record<SkillAdoptionRecoveryOperation["state"], string> = {
  intent_only: "Interrupted",
  source_preserved: "Original Preserved",
  managed_linked: "Linked",
  restored: "Restored",
  blocked: "Needs Attention",
};

const restorable = (operation: SkillAdoptionRecoveryOperation) =>
  operation.state === "source_preserved" || operation.state === "managed_linked";

/**
 * Adoption Recovery (#1963): the recovery journals a machine keeps for folders that were replaced
 * with links, stacked over Import from Machine. Restoring one asks for a non-destructive
 * confirmation; the request and its server-side confirmation are unchanged.
 */
export function SkillAdoptionRecoveryDialog({ runner, machineName, track, machineBusy, onClose, onRestored }: {
  runner: RunnerView;
  machineName: string;
  /** The import dialog's machine-request tracker: its reads wait until these settle. */
  track: MachineRequestTracker;
  /** A machine request is still running (perhaps one whose confirmation was cancelled): the server
   * refuses a second, so nothing here starts one until it settles. */
  machineBusy: boolean;
  onClose: () => void;
  onRestored: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [recovery, setRecovery] = useState<MachineSkillRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const closed = useRef(false);
  const rowId = useId().replace(/:/g, "");

  const inspect = async () => {
    setLoading(true); setError(null);
    try {
      const next = await track(() => api.inspectMachineSkillRecovery(runner.runnerId));
      if (!closed.current) setRecovery(next);
    } catch (cause) {
      if (!closed.current) { setRecovery(null); setError(userFacingMachineError(cause, machineName)); }
    } finally {
      if (!closed.current) setLoading(false);
    }
  };
  // Inspect once on open. The ref survives StrictMode's simulated remount, so the runner is read once.
  const inspected = useRef(false);
  useEffect(() => {
    if (inspected.current) return;
    inspected.current = true;
    void inspect();
  }, []);
  // Reset on (re)mount: StrictMode's simulated unmount runs this cleanup once before the real mount.
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; };
  }, []);

  const restore = async (operation: SkillAdoptionRecoveryOperation) => {
    setStatus(null);
    let restored = false;
    let stopped = false;
    const confirmed = await confirm({
      title: "Restore Original",
      message: `The original ${operation.name} folder returns to ${operation.sourceDirectory} on ${machineName}. The link is kept in the recovery journal.`,
      confirmLabel: "Restore Original",
      progress: "Restoring the original folder…",
      onConfirm: async (signal) => {
        let result: Awaited<ReturnType<typeof api.restoreMachineSkillRecovery>>;
        try {
          result = await track(() => api.restoreMachineSkillRecovery(runner.runnerId, operation.operationId));
        } catch (cause) {
          // The confirmation shows this text as is, so it is put in the dialog's words first (§17.2).
          throw new Error(userFacingMachineError(cause, machineName));
        }
        // Cancelled while the machine was restoring: the confirmation has gone, but the restore may
        // have finished, so the journals (and, after a restore, the page) are read again.
        if (signal.aborted) {
          void (async () => {
            await inspect();
            if (result.status === "restored") await onRestored();
          })();
          return;
        }
        if (result.status === "restored" || result.status === "not_needed") {
          restored = result.status === "restored";
          setStatus({ tone: "success", text: restored
            ? `Restored the original ${result.operation?.name ?? operation.name} folder. The link is kept in its recovery journal.`
            : "The original folder was already in place; nothing needed restoring." });
          return;
        }
        // Read the journals again once the confirmation settles, not now: a retry from the
        // confirmation must not meet a second machine request.
        stopped = true;
        throw new Error(result.error
          ? userFacingMachineError(new Error(result.error), machineName)
          : "Restore stopped safely. Check the journal below before trying again.");
      },
    });
    if (!confirmed) {
      if (stopped) await inspect();
      return;
    }
    await inspect();
    if (restored) await onRestored();
  };

  const operations = recovery?.operations ?? [];
  return <Modal title="Adoption Recovery" description="Original folders kept when a folder was replaced with a link."
    className="skill-adoption-recovery" onClose={onClose}
    footer={<button className="btn" type="button" onClick={onClose}>Done</button>}>
    {status && <Notice tone={status.tone} role="status">{status.text}</Notice>}
    {loading && !recovery ? <div className="skill-adoption-recovery-loading" role="status">
      <span className="sr-only">Loading recovery journals…</span>
      <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
    </div> : error ? <Notice tone="danger" title="Couldn't Load Recovery Journals"
      actions={<button className="btn sm" type="button" disabled={machineBusy} onClick={() => void inspect()}>Retry</button>}>{error}</Notice>
      : <>
        {recovery?.truncated && <Notice tone="warning" title="Some Journals Aren't Shown">
          Restore or resolve the journals below, then open Adoption Recovery again to see the rest.
        </Notice>}
        {operations.length === 0
          ? <p className="skill-adoption-recovery-empty">No folders on {machineName} have been replaced with links.</p>
          : <div className="surface" role="list" aria-label="Recovery Journals">
            {operations.map((operation, index) => <div className="row row-2" role="listitem" key={operation.operationId}>
              <span className="row-body">
                <span className="row-title" id={`${rowId}-${index}`}>{operation.name}</span>
                <span className="row-sub skill-machine-location" title={operation.detail}>{machineSkillLocation(operation, runner)}</span>
              </span>
              <span className="row-trail">{RECOVERY_STATE_LABEL[operation.state] ?? "Unknown"}</span>
              {restorable(operation) && <button className="btn sm" type="button"
                disabled={machineBusy} aria-describedby={`${rowId}-${index}`} onClick={() => void restore(operation)}>Restore Original…</button>}
            </div>)}
          </div>}
      </>}
  </Modal>;
}
