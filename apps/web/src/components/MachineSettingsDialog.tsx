import React, { useId, useRef, useState } from "react";
import { runnerCapabilityRequirement, runnerSupportsProtocol, type BoxView, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import {
  accountStatusLabel,
  capacityError,
  CAPACITY_HELPER,
  defaultAccountLabel,
  defaultAccountProviders,
  DEFAULT_ACCOUNTS_HELPER,
  DELETE_BLOCKED,
  fieldChanged,
  fieldLabel,
  fieldOrder,
  installationGroups,
  machineSettingsSnapshot,
  missingDefaultAccount,
  nameError,
  offlineSentence,
  SAVED_TOAST,
  SWITCHING_DESCRIPTION,
  unsavedSentence,
  withField,
  type DefaultAccountProvider,
  type InstallationGroup,
  type MachineSettingsField,
  type MachineSettingsSnapshot,
  type MachineSettingsTarget,
  type MachineSettingsValues,
} from "../machine-settings.js";
import { machineSettingsMutationError, runnerDisplay } from "../runners.js";
import { AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { Modal } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { confirmDeleteMachine } from "./MachineDetail.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, Select } from "./ui/ChoiceControls.js";
import { SwitchRow } from "./ui/SettingsRows.js";

const READ_ONLY = "Only this machine's owner or an organization admin can change these settings.";
const TERMS = "Provider terms assume ordinary individual usage and prohibit circumventing rate limits, so automatically rotating between your own subscriptions can be a gray area. You are responsible for ensuring this use complies with each provider's terms.";

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
      defaultAccounts: { ...live.values.defaultAccounts, ...saved.values.defaultAccounts },
      installations: { ...live.values.installations, ...saved.values.installations },
    },
    revisions: {
      ...saved.revisions,
      defaultAccounts: { ...live.revisions.defaultAccounts, ...saved.revisions.defaultAccounts },
    },
  };
}

/**
 * Machine Settings (#2991): one `<form>` with one Save Changes (§8.6, Dialog). Owners and admins
 * see every field; a machine's own manager sees Capacity Limit, the switch and Default Accounts.
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
    defaultAccounts: { ...baseline.values.defaultAccounts, ...draft.defaultAccounts },
    installations: { ...baseline.values.installations, ...draft.installations },
  };

  const canManageRunner = runner?.canManage === true;
  const capacitySupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "machineRunnerCapacity");
  const switchSupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "automaticProviderAccountSwitch");
  const installationSupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "harnessInstallations");
  const targetInstallationSupported = !!runner && runnerSupportsProtocol(runner.protocolVersion, "targetHarnessInstallations");
  const accounts = runner?.providerAccounts ?? [];
  const providers = runner && runnerSupportsProtocol(runner.protocolVersion, "providerAccounts")
    ? defaultAccountProviders(runner) : [];
  const groups: InstallationGroup[] = canManageMachines && runner ? installationGroups(runner) : [];
  const fields = fieldOrder({
    name: canManageMachines,
    capacity: !!runner,
    switching: !!runner,
    defaultAccounts: providers,
    installations: groups.map((group) => group.key),
  });
  const offline = !!runner && runner.status !== "online";
  const deleteBlocked = !box && runner?.status === "online";

  const [revealed, toggleReveal] = useAccountIdentifierReveal(JSON.stringify([
    runnerId,
    providers.map((provider) => [provider, form.defaultAccounts[provider]]),
    accounts.map((account) => [account.id, account.label]),
  ]));
  const titles = maskedAccountTitles(accounts.map((account) => account.label));

  const update = (next: Partial<MachineSettingsValues>) => {
    if (savingRef.current) return;
    setFailure(null);
    setDraft((current) => ({ ...current, ...next }));
  };

  /** A provider or installation group that appeared after the dialog opened follows the machine
   * until it is first edited; then its value and revision as shown are frozen into the saved
   * snapshot, so a later change from another client is a conflict rather than an overwrite. */
  const freeze = (entry: { provider: DefaultAccountProvider } | { group: string }) => {
    setSaved((current) => {
      if ("provider" in entry) {
        if (entry.provider in current.values.defaultAccounts) return current;
        return {
          values: { ...current.values, defaultAccounts: {
            ...current.values.defaultAccounts, [entry.provider]: baseline.values.defaultAccounts[entry.provider] ?? "",
          } },
          revisions: { ...current.revisions, defaultAccounts: {
            ...current.revisions.defaultAccounts, [entry.provider]: baseline.revisions.defaultAccounts[entry.provider] ?? 0,
          } },
        };
      }
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
      case "switching": {
        const { automaticAccountSwitching } = await api.updateMachineAutomaticAccountSwitching(runnerId, {
          enabled: form.switching,
          expectedRevision: from.revisions.switching,
        });
        return {
          values: { ...from.values, switching: automaticAccountSwitching.enabled },
          revisions: { ...from.revisions, switching: automaticAccountSwitching.revision },
        };
      }
      case "defaultAccount": {
        const { providerAccountDefault } = await api.updateMachineProviderAccountDefault(runnerId, field.provider, {
          accountId: form.defaultAccounts[field.provider] || null,
          expectedRevision: from.revisions.defaultAccounts[field.provider] ?? 0,
        });
        return {
          values: { ...from.values, defaultAccounts: { ...from.values.defaultAccounts, [field.provider]: providerAccountDefault.accountId ?? "" } },
          revisions: { ...from.revisions, defaultAccounts: { ...from.revisions.defaultAccounts, [field.provider]: providerAccountDefault.revision } },
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
    // Turning switching on is an opt-in to the provider-terms warning; turning it off is not.
    if (changed.some((field) => field.kind === "switching") && form.switching && !baseline.values.switching) {
      const approved = await confirm({
        title: "Turn On Automatic Switching",
        message: `When an account on ${display.name} reaches its usage limit, the next turn moves to another account from the same provider.`,
        details: <Notice tone="warning" compact>{TERMS}</Notice>,
        confirmLabel: "Turn On Automatic Switching",
      });
      if (!approved) return;
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
  const accountsHelperId = `${ids}-accounts-helper`;
  const installationsHelperId = `${ids}-installations-helper`;
  const deleteNoteId = `${ids}-delete-note`;
  const capacityEditable = capacitySupported && canManageRunner;
  const initialFocusRef = at === "capacity" && capacityEditable ? capacityRef
    : at === "installations" && groups.length > 0 ? installationsRef : undefined;

  const accountOptions = (provider: DefaultAccountProvider) => {
    const savedId = baseline.values.defaultAccounts[provider] ?? "";
    const candidates = accounts.filter((account) => account.provider === provider);
    return [
      { value: "", label: "No Default", description: "Uses the agent's configured account, or the first one available." },
      ...(runner && missingDefaultAccount(runner, provider, savedId) ? [{
        value: savedId,
        label: "Saved Account Not Found",
        description: "It's no longer on this machine. Choose another account.",
      }] : []),
      // A profile only other control planes may use can't be saved as the default (#3240); one
      // saved before stays listed, saying why.
      ...candidates.filter((account) => account.profile?.access !== "not_granted" || account.id === savedId).map((account) => ({
        value: account.id,
        label: revealed ? account.label : titles[accounts.indexOf(account)]!,
        description: account.profile?.access === "not_granted"
          ? "Its provider profile isn't granted to this control plane."
          : accountStatusLabel(account.authStatus),
      })),
    ];
  };

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
          <div className="machine-settings-switch">
            <SwitchRow
              title="Switch Accounts Automatically"
              description={SWITCHING_DESCRIPTION}
              checked={form.switching}
              disabled={!switchSupported || !canManageRunner}
              {...(!switchSupported ? {
                disabledReason: runnerCapabilityRequirement(runner.protocolVersion, "automaticProviderAccountSwitch",
                  "automatic account switching changes"),
              } : {})}
              onClick={() => update({ switching: !form.switching })}
            />
          </div>
        )}

        {providers.length > 0 && (
          <fieldset className="machine-settings-fieldset">
            <legend>Default Accounts</legend>
            {accounts.some((account) => isPersonalIdentifier(account.label)) && (
              <AccountIdentifierRevealButton label="Emails" revealed={revealed} onToggle={toggleReveal} withText />
            )}
            {providers.map((provider) => {
              const label = defaultAccountLabel(provider);
              return (
                <div className="field" key={provider}>
                  <span>{label}</span>
                  <Select<string>
                    label={label}
                    value={form.defaultAccounts[provider] ?? ""}
                    disabled={!canManageRunner}
                    describedBy={accountsHelperId}
                    options={accountOptions(provider)}
                    onChange={(accountId) => {
                      if (savingRef.current) return;
                      freeze({ provider });
                      update({ defaultAccounts: { ...draft.defaultAccounts, [provider]: accountId } });
                    }}
                  />
                </div>
              );
            })}
            <p className="field-helper" id={accountsHelperId}>{DEFAULT_ACCOUNTS_HELPER}</p>
          </fieldset>
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
