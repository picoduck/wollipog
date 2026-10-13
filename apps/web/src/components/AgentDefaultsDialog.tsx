import { useEffect, useRef, useState } from "react";
import type { AgentHarnessDefaultConfig, AgentHarnessDefaultOption } from "@wollipog/protocol";
import { effortLabel } from "../format.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";
import {
  draftRepairNotice,
  effortsForDraft,
  permissionModeDisplayLabel,
  permissionModesForDraft,
  repairDraft,
  repairedDraftFields,
  uniqueModels,
} from "./agent-defaults-options.js";

/** The "Wollipog Default" choice each field starts with: the field is left unset. */
const UNSET = "";
const EFFORT_ERROR_ID = "agent-defaults-effort-error";
const EFFORT_HELPER_ID = "agent-defaults-effort-helper";
const HELPER_ID = "agent-defaults-helper";

type Pending = "save" | "reset" | null;

/** Validation (unchanged from the inline editor): a chosen model that has efforts needs one. */
function needsEffort(option: AgentHarnessDefaultOption, draft: AgentHarnessDefaultConfig): boolean {
  return !!draft.model && !draft.effort && effortsForDraft(option, draft).length > 0;
}

interface Failure {
  title: string;
  sentence: string;
  detail: string;
}

/**
 * One agent's defaults (#3024): a `.modal` (560px) of three Selects in one row, a bottom sheet on
 * phones (§7.1, §7.5). Every field starts with "Wollipog Default", which leaves it unset.
 *
 * Footer (§7.3): Use Wollipog Defaults as the far-left tertiary while something is saved, then Cancel
 * and Save Defaults. A failed save is a danger notice above the footer, with the server's words behind
 * Show Details; the draft stays. The panel owns the requests: `onSave` and `onReset` resolve once the
 * row shows the result (the panel then closes the dialog) and reject with what went wrong.
 *
 * `option` is the agent as last read. A refresh while the dialog is open (a machine came or went)
 * passes a new object, and the draft drops whatever the agent no longer offers, saying which fields
 * it changed.
 */
export function AgentDefaultsDialog({
  option,
  onSave,
  onReset,
  onClose,
  returnFocusRef,
}: {
  option: AgentHarnessDefaultOption;
  onSave: (config: AgentHarnessDefaultConfig) => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const [draft, setDraft] = useState<AgentHarnessDefaultConfig>(() => repairDraft(option, option.preference ?? {}));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const [effortError, setEffortError] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const pendingRef = useRef<Pending>(null);
  const effortFieldRef = useRef<HTMLDivElement>(null);
  const openedWith = useRef(option);

  useEffect(() => {
    if (openedWith.current === option) return;
    openedWith.current = option;
    const repaired = repairDraft(option, draftRef.current);
    const notice = draftRepairNotice(repairedDraftFields(draftRef.current, repaired));
    setDraft(repaired);
    if (notice) setRepairNotice(notice);
    // The missing-effort error is about a model the repair may have removed, or whose efforts it did.
    if (!needsEffort(option, repaired)) setEffortError(null);
  }, [option]);

  const models = uniqueModels(option);
  const efforts = effortsForDraft(option, draft);
  const permissionModes = permissionModesForDraft(option, draft);
  // An effort belongs to a model when the agent lists models, so it waits for one.
  const effortWaitsForModel = models.length > 0 && !draft.model;
  const showEffort = models.length > 0 || efforts.length > 0;
  const offersPermissionModes = option.installations.some((installation) => installation.permissionModes.length > 0);
  const busy = pending !== null;
  const discovered = option.installations.length > 0;

  const update = (next: AgentHarnessDefaultConfig) => {
    setRepairNotice(null);
    setFailure(null);
    setDraft(next);
  };

  const run = async (kind: Exclude<Pending, null>, action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = kind;
    setPending(kind);
    setFailure(null);
    try {
      await action();
    } catch (caught) {
      setFailure({
        title: kind === "save" ? "Defaults Not Saved" : "Defaults Not Reset",
        sentence: kind === "save"
          ? "Wollipog couldn't save these defaults. Your choices are still here, so you can try again."
          : "Wollipog couldn't go back to its defaults for this agent. Try again.",
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const save = () => {
    // A model that has efforts needs one (§8.5: the primary stays enabled and reveals the error).
    if (needsEffort(option, draft)) {
      setEffortError("Choose a reasoning effort for this model.");
      effortFieldRef.current?.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    const chosen = !!(draft.model || draft.effort || draft.permissionMode);
    // Every field on Wollipog Default is the same as having no defaults saved.
    if (!chosen) {
      if (option.preference) void run("reset", onReset);
      else onClose();
      return;
    }
    void run("save", () => onSave(draft));
  };

  const close = () => {
    if (pendingRef.current) return;
    onClose();
  };

  return (
    <Modal
      title={`${option.name} Defaults`}
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      tertiary={option.preference ? (
        <BusyButton
          className="btn ghost"
          busy={pending === "reset"}
          progress="Going back to Wollipog defaults…"
          disabled={pending === "save"}
          onClick={() => void run("reset", onReset)}
        >
          Use Wollipog Defaults
        </BusyButton>
      ) : undefined}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <BusyButton
            className="btn primary"
            type="submit"
            form="agent-defaults-form"
            busy={pending === "save"}
            progress="Saving defaults…"
            disabled={pending === "reset"}
          >
            Save Defaults
          </BusyButton>
        </>
      )}
    >
      <form
        id="agent-defaults-form"
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {!discovered && (
          <Notice tone="warning" compact role="status">
            This agent is no longer discovered on any machine. Use Wollipog defaults to clear what is saved.
          </Notice>
        )}
        {/* Always in the DOM, so the polite region exists before it has something to say. */}
        <div role="status" aria-atomic="true" className={repairNotice ? undefined : "sr-only"}>
          {repairNotice && <Notice tone="info" compact>{repairNotice}</Notice>}
        </div>
        <div className="agent-defaults-fields">
          {models.length > 0 && (
            <div className="field">
              <span>Model</span>
              <Select
                label="Model"
                value={draft.model ?? UNSET}
                disabled={busy}
                describedBy={HELPER_ID}
                options={[
                  { value: UNSET, label: "Wollipog Default", description: "The model the agent picks for itself." },
                  ...models.map((model) => ({ value: model.id, label: model.displayName ?? model.id })),
                ]}
                onChange={(model) => {
                  const next: AgentHarnessDefaultConfig = { ...draft };
                  if (model) next.model = model;
                  else delete next.model;
                  if (next.effort && !effortsForDraft(option, next).includes(next.effort)) delete next.effort;
                  if (next.permissionMode && !permissionModesForDraft(option, next).includes(next.permissionMode)) {
                    delete next.permissionMode;
                  }
                  if (!next.model || !next.effort) setEffortError(null);
                  update(next);
                }}
              />
            </div>
          )}
          {showEffort && (
            <div className="field" ref={effortFieldRef}>
              <span>Reasoning Effort</span>
              <Select
                label="Reasoning Effort"
                value={draft.effort ?? UNSET}
                disabled={busy || effortWaitsForModel}
                invalid={!!effortError}
                describedBy={effortError ? EFFORT_ERROR_ID : effortWaitsForModel ? EFFORT_HELPER_ID : HELPER_ID}
                options={[
                  { value: UNSET, label: "Wollipog Default", description: "The effort the agent picks for itself." },
                  ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
                ]}
                onChange={(effort) => {
                  const next: AgentHarnessDefaultConfig = { ...draft };
                  if (effort) next.effort = effort;
                  else delete next.effort;
                  if (next.permissionMode && !permissionModesForDraft(option, next).includes(next.permissionMode)) {
                    delete next.permissionMode;
                  }
                  setEffortError(null);
                  update(next);
                }}
              />
              {/* Why the field is unavailable, visible (§3.1), or the error that replaces it (§8.5). */}
              {effortError
                ? <FieldError id={EFFORT_ERROR_ID}>{effortError}</FieldError>
                : effortWaitsForModel && <p className="field-helper" id={EFFORT_HELPER_ID}>Choose a model first.</p>}
            </div>
          )}
          {offersPermissionModes && (
            <div className="field">
              <span>Permission Mode</span>
              <Select
                label="Permission Mode"
                value={draft.permissionMode ?? UNSET}
                disabled={busy}
                describedBy={HELPER_ID}
                options={[
                  { value: UNSET, label: "Wollipog Default", description: "The mode the agent starts in on its own." },
                  ...permissionModes.map((mode) => ({ value: mode, label: permissionModeDisplayLabel(mode, option.driver) })),
                ]}
                onChange={(permissionMode) => {
                  const next: AgentHarnessDefaultConfig = { ...draft };
                  if (permissionMode) next.permissionMode = permissionMode;
                  else delete next.permissionMode;
                  update(next);
                }}
              />
            </div>
          )}
        </div>
        <p className="field-helper" id={HELPER_ID}>Changes apply to new sessions.</p>
        {failure && (
          <Notice tone="danger" role="alert" title={failure.title} details={<code>{failure.detail}</code>}>
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
