import React, { useRef, useState } from "react";
import { runnerSupportsProtocol, type ProviderAccountDefinition, type RunnerView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { accountStatusLabel } from "../machine-settings.js";
import { maskedAccountTitles } from "../personal-identifiers.js";
import { machineSettingsMutationError } from "../runners.js";
import { AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { Modal } from "./Modal.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";
import { SwitchRow } from "./ui/SettingsRows.js";

const TERMS = "Provider terms assume ordinary individual usage and prohibit circumventing rate limits, so automatically rotating between your own subscriptions can be a gray area. You are responsible for ensuring this use complies with each provider's terms.";

/** Keep the opened revision, even when a new machine report arrives while editing. */
export function ProviderAccountSettingsDialog({ runner, provider, onClose, onSaved }: {
  runner: RunnerView;
  provider: ProviderAccountDefinition["provider"];
  onClose: () => void;
  onSaved: (value: NonNullable<RunnerView["providerAccountDefaults"]>[number]) => void;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const [opened] = useState(() => runner.providerAccountDefaults?.find(value => value.provider === provider));
  const [baseline, setBaseline] = useState({ accountId: opened?.accountId ?? "", revision: opened?.revision ?? 0 });
  const [choice, setChoice] = useState(baseline.accountId);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const accounts = (runner.providerAccounts ?? []).filter(account => account.provider === provider);
  const [revealed, toggleReveal] = useAccountIdentifierReveal(JSON.stringify([runner.runnerId, provider, choice, accounts.map(account => [account.id, account.label])]));
  const titles = maskedAccountTitles(accounts.map(account => account.label));
  const label = provider === "claude" ? "Claude" : "Codex";
  const dirty = choice !== baseline.accountId;
  const online = runner.status === "online" && runner.canManage === true && runnerSupportsProtocol(runner.protocolVersion, "providerAccounts");
  const close = async () => {
    if (inFlight.current) return;
    if (dirty && !await confirm({ title: "Discard Changes", message: "Your account choice hasn't been saved.", confirmLabel: "Discard Changes", tone: "danger" })) return;
    onClose();
  };
  const save = async () => {
    if (inFlight.current || !dirty || !online || conflict) return;
    inFlight.current = true; setSaving(true); setError(null);
    try {
      const { providerAccountDefault } = await api.updateMachineProviderAccountDefault(runner.runnerId, provider, {
        accountId: choice || null, expectedRevision: baseline.revision,
      });
      onSaved(providerAccountDefault);
      showToast("New-session account settings saved.", { tone: "success" });
      onClose();
    } catch (cause) {
      setError(machineSettingsMutationError(cause));
      setConflict(cause instanceof ApiError && cause.status === 409);
    } finally { inFlight.current = false; setSaving(false); }
  };
  const options = [
    { value: "", label: "No Saved Default", description: "Uses the agent's configured account, or the first available account." },
    ...(!accounts.some(account => account.id === baseline.accountId) && baseline.accountId ? [{
      value: baseline.accountId, label: "Saved Account Not Found", description: "Choose another account or clear the saved default.",
    }] : []),
    ...accounts.filter(account => account.profile?.access !== "not_granted" || account.id === baseline.accountId).map(account => ({
      value: account.id, label: revealed ? account.label : titles[accounts.indexOf(account)]!,
      description: account.profile?.access === "not_granted" ? "Its profile isn't granted to this control plane." : accountStatusLabel(account.authStatus),
    })),
  ];
  return <Modal title={`New ${label} Sessions`} description="Running sessions aren't affected." size="sm" phoneSheet="full"
    onClose={() => void close()} footer={<>
      <span className="provider-settings-state" role="status">{dirty ? "Unsaved Changes" : "No Changes"}</span>
      <button type="button" className="btn" disabled={saving} onClick={() => void close()}>Cancel</button>
      <BusyButton className="btn primary" busy={saving} progress="Saving the account choice…" disabled={!dirty || !online || conflict}
        onClick={() => void save()}>Save</BusyButton>
    </>}>
    <div className="field">
      <div className="field-head"><span>Account</span>
        <AccountIdentifierRevealButton label="Emails" revealed={revealed} onToggle={toggleReveal} />
      </div>
      <Select label="Account" value={choice} options={options} disabled={saving || !online}
        onChange={value => { setChoice(value); setError(null); }} />
      <p className="field-helper">{choice
        ? "New sessions that don't choose an account use this account in native execution contexts. If it can't run, choose another account."
        : "No machine default is saved. Each agent keeps its configured account or uses the first available account."}</p>
    </div>
    {!online && <p className="field-helper">This machine is offline. Reconnect it to save changes.</p>}
    {error && <Notice tone="danger" title="Couldn't Save the Account Choice" role="alert">{error}</Notice>}
    {conflict && <button type="button" className="btn" onClick={() => {
      const saved = runner.providerAccountDefaults?.find(value => value.provider === provider);
      setBaseline({ accountId: saved?.accountId ?? "", revision: saved?.revision ?? 0 });
      setChoice(saved?.accountId ?? ""); setError(null); setConflict(false);
    }}>Reload Saved Choice</button>}
  </Modal>;
}

export function RunningSessionAccountSettings({ runner, online }: { runner: RunnerView; online: boolean }) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState({ enabled: false, revision: 0 });
  const [draft, setDraft] = useState(false);
  const [saved, setSaved] = useState<RunnerView["automaticAccountSwitching"]>();
  const current = saved && saved.revision >= (runner.automaticAccountSwitching?.revision ?? 0) ? saved : runner.automaticAccountSwitching;
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const supported = runnerSupportsProtocol(runner.protocolVersion, "automaticProviderAccountSwitch");
  const dirty = draft !== opened.enabled;
  const close = async () => {
    if (inFlight.current) return;
    if (dirty && !await confirm({ title: "Discard Changes", message: "Your switching setting hasn't been saved.", confirmLabel: "Discard Changes", tone: "danger" })) return;
    setEditing(false);
  };
  const save = async () => {
    if (inFlight.current || !dirty || !online || conflict || !runner.canManage || !supported) return;
    inFlight.current = true;
    if (draft && !await confirm({ title: "Turn On Automatic Switching", message: "At a usage limit, the next turn moves to another account from the same provider.",
      details: <Notice tone="warning" compact>{TERMS}</Notice>, confirmLabel: "Turn On Automatic Switching" })) {
      inFlight.current = false; return;
    }
    setSaving(true); setError(null);
    try {
      const { automaticAccountSwitching } = await api.updateMachineAutomaticAccountSwitching(runner.runnerId, { enabled: draft, expectedRevision: opened.revision });
      setSaved(automaticAccountSwitching); setEditing(false);
      showToast("Running session settings saved.", { tone: "success" });
    } catch (cause) {
      setError(machineSettingsMutationError(cause));
      setConflict(cause instanceof ApiError && cause.status === 409);
    } finally { inFlight.current = false; setSaving(false); }
  };
  const reload = () => {
    const value = { enabled: current?.enabled ?? false, revision: current?.revision ?? 0 };
    setOpened(value); setDraft(value.enabled); setError(null); setConflict(false);
  };
  return <>
    <div className="provider-settings-heading provider-running-settings">
      <div><h4>Running Sessions</h4><p className="section-note">{current?.enabled
        ? "At a usage limit, the next turn can move to another account."
        : "At a usage limit, a session stays on its account."}</p></div>
      {runner.canManage && <button type="button" className="btn" disabled={!online || !supported} aria-label="Change Running Sessions"
        onClick={() => { reload(); setEditing(true); }}>Change…</button>}
    </div>
    {!supported && <p className="section-note">Update the runner to change usage-limit switching.</p>}
    {editing && <Modal title="Running Sessions" description="Applies independently of new-session account choices." size="sm" phoneSheet="full"
      onClose={() => void close()} footer={<>
        <span className="provider-settings-state" role="status">{dirty ? "Unsaved Changes" : "No Changes"}</span>
        <button type="button" className="btn" disabled={saving} onClick={() => void close()}>Cancel</button>
        <BusyButton className="btn primary" busy={saving} progress="Saving the switching setting…" disabled={!dirty || !online || conflict || !runner.canManage || !supported}
          onClick={() => void save()}>Save</BusyButton>
      </>}>
      <SwitchRow title="Switch Accounts at a Usage Limit" checked={draft} disabled={saving || !online || !runner.canManage || !supported}
        description="The next turn can use another account from the same provider. Existing handoff and cooldown checks still apply."
        onClick={() => { setDraft(!draft); setError(null); }} />
      {error && <Notice tone="danger" title="Couldn't Save Running Session Settings" role="alert">{error}</Notice>}
      {conflict && <button type="button" className="btn" onClick={reload}>Reload Saved Choice</button>}
    </Modal>}
  </>;
}
