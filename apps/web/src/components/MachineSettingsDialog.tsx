import React, { useId, useRef, useState } from "react";
import { runnerCapabilityRequirement, runnerSupportsProtocol, type BoxView, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  capacityError,
  CAPACITY_HELPER,
  DELETE_BLOCKED,
  fieldChanged,
  fieldLabel,
  fieldOrder,
  installationGroups,
  machineSettingsSnapshot,
  nameError,
  offlineSentence,
  SAVED_TOAST,
  unsavedSentence,
  withField,
  type InstallationGroup,
  type MachineSettingsField,
  type MachineSettingsSnapshot,
  type MachineSettingsTarget,
  type MachineSettingsValues,
} from "../machine-settings.js";
import { machineSettingsMutationError, runnerDisplay } from "../runners.js";
import { Modal } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { confirmDeleteMachine } from "./MachineDetail.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, Select } from "./ui/ChoiceControls.js";

const READ_ONLY = "Only this machine's owner or an organization admin can change these settings.";

interface SaveFailure {
  sentence: string;
  details: Array<{ label: string; message: string }>;
}

/** The saved maps follow the machine for entries the dialog has not saved itself: a provider or an
 * installation group that appeared while it was open starts unchanged. */
function mergedSnapshot(live: MachineSettingsSnapshot, saved: MachineSettingsSnapshot): MachineSettingsSnapshot {
  return {
    values: {
      ...saved.values,
      installations: { ...live.values.installations, ...saved.values.installations },
    },
    revisions: saved.revisions,
  };
}

/**
 * Machine Settings (#2991): one `<form>` with one Save Changes (§8.6, Dialog). Owners and admins
 * see every field; a machine's own manager sees Capacity Limit. Account settings live in Provider Accounts.
 *
 * Save Changes sends only the fields that differ from the last saved snapshot, each through its
 * existing endpoint and revision, in `fieldOrder`. A field that saved becomes the new baseline even
 * when a later one fails, so the danger notice names only what wasn't saved and Save Changes
 * retries only that. `at` opens the dialog with focus, and so the view, in Capacity Limit or Agent
 * Installations.
 */
export function MachineSettingsDialog({
  runner,
  box,
  canManageMachines,
  at,
  onClose,
  onDelete,
}: {
  runner: RunnerView | undefined;
  box?: BoxView;
  /** An organization owner or admin: Machine Name, Agent Installations and Delete Machine… too. */
  canManageMachines: boolean;
  at?: MachineSettingsTarget;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const ids = useId();
  const formId = `machine-settings-${ids}`;
  const runnerId = runner?.runnerId ?? box?.runnerId ?? "";
  const display = runnerDisplay(runner, box, runnerId);
  const [opened] = useState(() => machineSettingsSnapshot(runner, box));
  const [saved, setSaved] = useState(opened);
  const [draft, setDraft] = useState(opened.values);
  const [nameErrorText, setNameErrorText] = useState<string | null>(null);
  const [capacityErrorText, setCapacityErrorText] = useState<string | null>(null);
  const [edited, setEdited] = useState({ name: false, capacity: false });
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const capacityRef = useRef<HTMLInputElement>(null);
  const installationsRef = useRef<HTMLFieldSetElement>(null);

  const baseline = mergedSnapshot(machineSettingsSnapshot(runner, box), saved);
  const form: MachineSettingsValues = {
    ...draft,
    installations: { ...baseline.values.installations, ...draft.installations },
  };

  const canManageRunner = runner?.canManage === true;
  const capacitySupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "machineRunnerCapacity");
  const reviewerSecuritySupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "reviewerSecurityPolicy");
  const installationSupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "harnessInstallations");
  const targetInstallationSupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "targetHarnessInstallations");
  const groups: InstallationGroup[] = canManageMachines && runner ? installationGroups(runner) : [];
  const fields = fieldOrder({
    name: canManageMachines,
    capacity: !!runner,
    reviewerSecurity: reviewerSecuritySupported,
    installations: groups.map((group) => group.key),
  });
  const offline = !!runner && runner.status !== "online";
  const deleteBlocked = !box && runner?.status === "online";

  const update = (next: Partial<MachineSettingsValues>) => {
    if (savingRef.current) return;
    setFailure(null);
    setDraft((current) => ({ ...current, ...next }));
  };

  /** An installation group that appeared after the dialog opened follows the machine
   * until it is first edited; then its value and revision as shown are frozen into the saved
   * snapshot, so a later change from another client is a conflict rather than an overwrite. */
  const freeze = (entry: { group: string }) => {
    setSaved(current => {
      if (entry.group in current.values.installations) return current;
      return { ...current, values: { ...current.values, installations: {
        ...current.values.installations, [entry.group]: baseline.values.installations[entry.group] ?? null,
      } } };
    });
  };

  const close = () => {
    if (!savingRef.current) onClose();
  };

  /** Sends one field and returns the snapshot with it saved. */
  const saveField = async (field: MachineSettingsField, from: MachineSettingsSnapshot): Promise<MachineSettingsSnapshot> => {
    switch (field.kind) {
      case "name":
        await api.updateMachine(runnerId, { displayName: form.name.trim() });
        return { ...from, values: withField(from.values, form, field) };
      case "capacity": {
        const { capacity } = await api.updateMachineCapacity(runnerId, {
          configuredUnits: Number(form.capacity.trim()),
          expectedRevision: from.revisions.capacity,
        });
        return {
          values: { ...from.values, capacity: capacity.configuredUnits.toString() },
          revisions: { ...from.revisions, capacity: capacity.revision },
        };
      }
      case "reviewerSecurity": {
        const { reviewerSecurity } = await api.updateMachineReviewerSecurity(runnerId, {
          policy: form.reviewerSecurity, expectedRevision: from.revisions.reviewerSecurity,
        });
        return {
          values: { ...from.values, reviewerSecurity: reviewerSecurity.policy },
          revisions: { ...from.revisions, reviewerSecurity: reviewerSecurity.revision },
        };
      }
      case "installation": {
        const group = groups.find((candidate) => candidate.key === field.group);
        const chosen = form.installations[field.group];
        const row = group?.rows.find((candidate) => candidate.value === chosen);
        if (!group || !chosen || !row) throw new Error("This installation is no longer available for selection");
        const installationId = group.kind === "target"
          ? (await api.selectTargetHarnessInstallation(runnerId, group.targetId, group.agentId, chosen)).selection.installationId
          : (await api.selectHarnessInstallation(runnerId, row.agentId ?? "", chosen)).selection.installationId;
        return { ...from, values: { ...from.values, installations: { ...from.values.installations, [field.group]: installationId } } };
      }
    }
  };

  const submit = async () => {
    if (savingRef.current) return;
    const changed = fields.filter((field) => fieldChanged(field, form, baseline.values));
    // Every changed field is validated on submit, and focus moves to the first invalid one (§8.5).
    const nameProblem = changed.some((field) => field.kind === "name") ? nameError(form.name) : null;
    const capacityProblem = changed.some((field) => field.kind === "capacity") ? capacityError(form.capacity) : null;
    setNameErrorText(nameProblem);
    setCapacityErrorText(capacityProblem);
    if (nameProblem || capacityProblem) {
      (nameProblem ? nameRef : capacityRef).current?.focus();
      return;
    }
    if (changed.length === 0) {
      onClose();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    let next = baseline;
    const failed: Array<{ field: MachineSettingsField; cause: unknown }> = [];
    for (const field of changed) {
      try {
        next = await saveField(field, next);
      } catch (cause) {
        failed.push({ field, cause });
      }
    }
    savingRef.current = false;
    setSaving(false);
    setSaved(next);
    if (failed.length === 0) {
      showToast(SAVED_TOAST, { tone: "success" });
      onClose();
      return;
    }
    const sentences = [...new Set(failed.map(({ cause }) => machineSettingsMutationError(cause)))];
    setFailure({
      sentence: `${unsavedSentence(failed.map(({ field }) => fieldLabel(field, groups)))} ${sentences.length === 1
        ? sentences[0] : "Show Details says why for each."}`,
      details: failed.map(({ field, cause }) => ({
        label: fieldLabel(field, groups),
        message: cause instanceof Error ? cause.message : String(cause),
      })),
    });
  };

  // The deletion runs inside the confirmation, which keeps a failure in view (§7.4).
  const deleteMachine = async () => {
    const deleted = await confirmDeleteMachine(confirm, { name: display.name, kind: box ? "ssh" : "native", onDelete });
    if (deleted) onClose();
  };

  const nameIds = { input: `${ids}-name`, error: `${ids}-name-error` };
  const capacityIds = { input: `${ids}-capacity`, helper: `${ids}-capacity-helper`, error: `${ids}-capacity-error` };
  const installationsHelperId = `${ids}-installations-helper`;
  const deleteNoteId = `${ids}-delete-note`;
  const capacityEditable = capacitySupported && canManageRunner;
  const initialFocusRef = at === "capacity" && capacityEditable ? capacityRef
    : at === "installations" && groups.length > 0 ? installationsRef : undefined;

  const installationGroupDisabled = (group: InstallationGroup) => !canManageRunner ||
    (group.kind === "target" ? !targetInstallationSupported : !installationSupported);

  return (
    <Modal
      title="Machine Settings"
      description={display.name}
      onClose={close}
      size="md"
      {...(initialFocusRef ? { initialFocusRef } : {})}
      tertiary={canManageMachines ? (
        <div className="machine-settings-delete">
          <button
            type="button"
            className="btn ghost danger"
            disabled={deleteBlocked || saving}
            aria-describedby={deleteBlocked ? deleteNoteId : undefined}
            onClick={() => void deleteMachine()}
          >
            Delete Machine…
          </button>
          {deleteBlocked && <span className="machine-settings-delete-note" id={deleteNoteId}>{DELETE_BLOCKED}</span>}
        </div>
      ) : undefined}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={saving}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={formId} busy={saving} progress="Saving machine settings…">
            Save Changes
          </BusyButton>
        </>
      )}
    >
      <form
        id={formId}
        className="form machine-settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {offline && <Notice tone="neutral" compact>{offlineSentence(display.name)}</Notice>}
        {runner && !canManageRunner && <Notice tone="neutral" compact>{READ_ONLY}</Notice>}

        {canManageMachines && (
          <div className="field">
            <div className="field-head"><label htmlFor={nameIds.input}>Machine Name</label></div>
            <input
              ref={nameRef}
              id={nameIds.input}
              value={form.name}
              autoComplete="off"
              readOnly={saving}
              aria-invalid={nameErrorText ? true : undefined}
              aria-describedby={nameErrorText ? nameIds.error : undefined}
              onChange={(event) => {
                setEdited((current) => ({ ...current, name: true }));
                if (nameErrorText && !nameError(event.target.value)) setNameErrorText(null);
                update({ name: event.target.value });
              }}
              onBlur={() => {
                if (edited.name && fieldChanged({ kind: "name" }, form, baseline.values)) setNameErrorText(nameError(form.name));
              }}
            />
            {nameErrorText && <FieldError id={nameIds.error}>{nameErrorText}</FieldError>}
          </div>
        )}

        {runner && (
          <div className="field">
            <div className="field-head"><label htmlFor={capacityIds.input}>Capacity Limit</label></div>
            <input
              ref={capacityRef}
              id={capacityIds.input}
              className="w-xs"
              type="number"
              inputMode="numeric"
              min={1}
              max={256}
              step={1}
              value={form.capacity}
              disabled={!capacityEditable}
              readOnly={saving}
              aria-invalid={capacityErrorText ? true : undefined}
              aria-describedby={capacityErrorText ? `${capacityIds.helper} ${capacityIds.error}` : capacityIds.helper}
              onChange={(event) => {
                setEdited((current) => ({ ...current, capacity: true }));
                if (capacityErrorText && !capacityError(event.target.value)) setCapacityErrorText(null);
                update({ capacity: event.target.value });
              }}
              onBlur={() => {
                if (edited.capacity && fieldChanged({ kind: "capacity" }, form, baseline.values)) {
                  setCapacityErrorText(capacityError(form.capacity));
                }
              }}
            />
            {/* The helper stays as the error joins it under the field (#2991). */}
            <p className="field-helper" id={capacityIds.helper}>{capacitySupported ? CAPACITY_HELPER
              : runnerCapabilityRequirement(runner.protocolVersion, "machineRunnerCapacity", "runner capacity changes")}</p>
            {capacityErrorText && <FieldError id={capacityIds.error}>{capacityErrorText}</FieldError>}
          </div>
        )}

        {runner && (
          <div className="field">
            <div className="field-head"><span>Reviewer Executable Policy</span></div>
            <Select<import("@wollipog/protocol").ReviewerSecurityPolicy>
              label="Reviewer Executable Policy"
              describedBy={`${ids}-reviewer-security-help`}
              value={form.reviewerSecurity}
              disabled={saving || !canManageRunner || !reviewerSecuritySupported}
              options={[
                { value: "strict", label: "Strict", description: "Verify ownership, write permissions, and private group membership." },
                { value: "personal_machine", label: "Personal Machine", description: "Trust group-writable paths owned by your account without checking group membership. Use when you trust other local accounts." },
              ]}
              onChange={(reviewerSecurity) => update({ reviewerSecurity })}
            />
            <p className="field-helper" id={`${ids}-reviewer-security-help`}>{reviewerSecuritySupported
              ? "Applies to reviewers and their Git, forge, and interpreter tools. Both policies reject world-writable paths and locations agents can write. Changes apply to the next review; running reviews continue."
              : runnerCapabilityRequirement(runner.protocolVersion, "reviewerSecurityPolicy", "reviewer executable policy changes")}</p>
          </div>
        )}

        {groups.length > 0 && (
          <fieldset
            ref={installationsRef}
            className="machine-settings-fieldset machine-settings-installations"
            tabIndex={-1}
            aria-describedby={!installationSupported ? installationsHelperId : undefined}
          >
            <legend>Agent Installations</legend>
            {!installationSupported && runner && (
              <p className="field-helper" id={installationsHelperId}>{runnerCapabilityRequirement(
                runner.protocolVersion, "harnessInstallations", "harness installation selection",
              )}</p>
            )}
            {groups.map((group, index) => {
              const disabled = installationGroupDisabled(group);
              const labelId = `${ids}-installations-${index}`;
              return (
                <div className="field" key={group.key}>
                  <span id={labelId}>{group.label}</span>
                  <ChoiceRows<string>
                    label={group.label}
                    labelledBy={labelId}
                    value={form.installations[group.key] ?? null}
                    onChange={(installationId) => {
                      if (savingRef.current) return;
                      freeze({ group: group.key });
                      update({ installations: { ...draft.installations, [group.key]: installationId } });
                    }}
                    options={group.rows.map((row) => ({
                      value: row.value,
                      title: row.path,
                      ...(row.version ? { meta: `v${row.version}` } : {}),
                      description: row.sentence,
                      disabled: disabled || row.disabled,
                      // A missing saved choice, or a target installation that is unavailable, says why.
                      ...(row.disabled ? { disabledReason: row.sentence } : {}),
                    }))}
                  />
                </div>
              );
            })}
          </fieldset>
        )}

        {failure && (
          <Notice
            tone="danger"
            role="alert"
            details={(
              <ul className="machine-settings-failures">
                {failure.details.map((item) => <li key={item.label}>{item.label}: <code>{item.message}</code></li>)}
              </ul>
            )}
          >
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
