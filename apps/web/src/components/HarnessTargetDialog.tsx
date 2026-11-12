import React, { useId, useRef, useState } from "react";
import type { ConfigureSessionNamingHarnessRequest, SessionNamingHarnessMachine } from "@wollipog/protocol";
import { effortLabel } from "../format.js";
import { modelOptionLabel } from "../agent-presentation.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";
import { agentDescription, plainFailure, type PlainFailure } from "./session-titles.js";

type Field = "machine" | "agent" | "model" | "effort";

const ERRORS: Record<Field, string> = {
  machine: "Choose a machine.",
  agent: "Choose an agent.",
  model: "Choose a model.",
  effort: "Choose a reasoning effort.",
};

/** The saved choice the dialog opens on, when there is one. */
export interface HarnessTargetSelection {
  runnerId: string;
  agentId: string;
  model: string;
  effort: string;
}

/**
 * One agent on one machine, with its model and reasoning effort: Machine, Agent, then Model and
 * Reasoning Effort side by side, in a `.modal` (560px) that is a bottom sheet on phones (§7.1, §7.5).
 * Footer: Cancel and Save. Session Titles (#3025) and the Decision Model (#4101) both choose one.
 *
 * The stored choice changes only when this saves: `onSave` resolves once the panel shows the result
 * and rejects with what went wrong, which stays here above the footer with the draft (§7.3, §8.5).
 * With `followsSession`, there is nothing to choose and Save stores `null`.
 */
export function HarnessTargetDialog({
  title,
  description,
  machineHelper,
  progress,
  failureSentence,
  machines,
  selection,
  followsSession = false,
  followsSessionText,
  onSave,
  onClose,
  returnFocusRef,
}: {
  title: string;
  description: string;
  machineHelper: string;
  progress: string;
  failureSentence: string;
  machines: SessionNamingHarnessMachine[];
  selection?: HarnessTargetSelection;
  followsSession?: boolean;
  followsSessionText?: string;
  onSave: (target: ConfigureSessionNamingHarnessRequest | null) => Promise<void>;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const ids = useId();
  const [draft, setDraft] = useState(() => {
    const machine = machines.find((candidate) => candidate.runnerId === selection?.runnerId) ??
      (machines.length === 1 ? machines[0] : undefined);
    const agent = machine?.harnesses.find((candidate) => candidate.agentId === selection?.agentId) ??
      (machine?.harnesses.length === 1 ? machine.harnesses[0] : undefined);
    const model = agent?.models.find((candidate) => candidate.id === selection?.model);
    const effort = model?.efforts.includes(selection?.effort ?? "") ? selection!.effort : "";
    return { runnerId: machine?.runnerId ?? "", agentId: agent?.agentId ?? "", model: model?.id ?? "", effort };
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<PlainFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const fieldRefs = useRef<Partial<Record<Field, HTMLDivElement | null>>>({});

  const machine = machines.find((candidate) => candidate.runnerId === draft.runnerId);
  const agent = machine?.harnesses.find((candidate) => candidate.agentId === draft.agentId);
  const model = agent?.models.find((candidate) => candidate.id === draft.model);

  const update = (next: typeof draft, cleared: Field[]) => {
    setDraft(next);
    setFailure(null);
    // A choice clears its own error, and the errors of the fields it reset (§8.5).
    setErrors((previous) => {
      const remaining = { ...previous };
      for (const field of cleared) delete remaining[field];
      return remaining;
    });
  };

  const save = async () => {
    if (busyRef.current) return;
    let target: ConfigureSessionNamingHarnessRequest | null = null;
    if (!followsSession) {
      const missing: Partial<Record<Field, string>> = {};
      if (!machine) missing.machine = ERRORS.machine;
      if (!agent) missing.agent = ERRORS.agent;
      if (!model) missing.model = ERRORS.model;
      if (!draft.effort) missing.effort = ERRORS.effort;
      const first = (["machine", "agent", "model", "effort"] as const).find((field) => missing[field]);
      if (first) {
        setErrors(missing);
        // The primary stays enabled and reveals the errors; focus goes to the first (§8.5).
        fieldRefs.current[first]?.querySelector<HTMLElement>("button")?.focus();
        return;
      }
      target = {
        runnerId: machine!.runnerId,
        agentId: agent!.agentId,
        driver: agent!.driver,
        model: model!.id,
        effort: draft.effort,
      };
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(target);
    } catch (caught) {
      setFailure(plainFailure(caught, failureSentence, "Your choices are still here, so you can try again."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const close = () => {
    if (!busyRef.current) onClose();
  };

  const field = (name: Field, label: string, control: React.ReactNode, helper?: string) => {
    const errorId = `${ids}-${name}-error`;
    return (
      <div className="field" ref={(node) => { fieldRefs.current[name] = node; }}>
        <span>{label}</span>
        {control}
        {errors[name]
          ? <FieldError id={errorId}>{errors[name]}</FieldError>
          : helper && <p className="field-helper" id={`${ids}-${name}-helper`}>{helper}</p>}
      </div>
    );
  };
  const describedBy = (name: Field, helper?: boolean) =>
    errors[name] ? `${ids}-${name}-error` : helper ? `${ids}-${name}-helper` : undefined;

  return (
    <Modal
      title={title}
      description={description}
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={`${ids}-form`} busy={busy} progress={progress}>
            Save
          </BusyButton>
        </>
      )}
    >
      <form
        id={`${ids}-form`}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {followsSession ? (
          <p className="field-helper">{followsSessionText}</p>
        ) : (
          <>
            {field("machine", "Machine", (
              <Select
                label="Machine"
                value={draft.runnerId || null}
                disabled={busy}
                invalid={Boolean(errors.machine)}
                describedBy={describedBy("machine", true)}
                placeholder="Choose a machine"
                options={machines.map((candidate) => ({ value: candidate.runnerId, label: candidate.machineName }))}
                onChange={(runnerId) => {
                  const next = machines.find((candidate) => candidate.runnerId === runnerId);
                  // A machine with one agent preselects it.
                  const only = next?.harnesses.length === 1 ? next.harnesses[0]!.agentId : "";
                  update({ runnerId, agentId: only, model: "", effort: "" }, ["machine", "agent", "model", "effort"]);
                }}
              />
            ), machineHelper)}
            {field("agent", "Agent", (
              <Select
                label="Agent"
                value={draft.agentId || null}
                disabled={busy || !machine}
                invalid={Boolean(errors.agent)}
                describedBy={describedBy("agent")}
                placeholder="Choose an agent"
                emptyLabel="Choose a machine first"
                options={(machine?.harnesses ?? []).map((candidate) => ({
                  value: candidate.agentId,
                  label: candidate.name,
                  description: agentDescription(candidate),
                }))}
                onChange={(agentId) => update({ ...draft, agentId, model: "", effort: "" }, ["agent", "model", "effort"])}
              />
            ))}
            <div className="field-row">
              {field("model", "Model", (
                <Select
                  label="Model"
                  value={draft.model || null}
                  disabled={busy || !agent}
                  invalid={Boolean(errors.model)}
                  describedBy={describedBy("model")}
                  placeholder="Choose a model"
                  options={(agent?.models ?? []).map((candidate) => ({ value: candidate.id, label: modelOptionLabel(candidate, agent?.models ?? []) }))}
                  onChange={(id) => {
                    const next = agent?.models.find((candidate) => candidate.id === id);
                    const only = next?.efforts.length === 1 ? next.efforts[0]! : "";
                    update({ ...draft, model: id, effort: next?.efforts.includes(draft.effort) ? draft.effort : only }, ["model", "effort"]);
                  }}
                />
              ))}
              {field("effort", "Reasoning Effort", (
                <Select
                  label="Reasoning Effort"
                  value={draft.effort || null}
                  disabled={busy || !model}
                  invalid={Boolean(errors.effort)}
                  describedBy={describedBy("effort")}
                  placeholder="Choose an effort"
                  options={(model?.efforts ?? []).map((value) => ({ value, label: effortLabel(value) }))}
                  onChange={(effort) => update({ ...draft, effort }, ["effort"])}
                />
              ))}
            </div>
          </>
        )}
        {failure && (
          <Notice tone="danger" role="alert" details={failure.detail ? <code>{failure.detail}</code> : undefined}>
            {failure.message}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
