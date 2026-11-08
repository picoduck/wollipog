import React, { useRef, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { machineSettingsMutationError } from "../runners.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Notice } from "./Notice.js";
import { SwitchRow } from "./ui/SettingsRows.js";

const TERMS = "Provider terms assume ordinary individual usage and prohibit circumventing rate limits, so automatically rotating between your own subscriptions can be a gray area. You are responsible for ensuring this use complies with each provider's terms.";

export function conflictCurrent(cause: unknown): Record<string, unknown> | null {
  if (!(cause instanceof ApiError) || cause.status !== 409) return null;
  const value = cause.details?.current;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.revision === "number" && Number.isSafeInteger(record.revision) && record.revision >= 0 ? record : null;
}

export function RunningSessionAccountSettings({ runner, online, canEdit }: { runner: RunnerView; online: boolean; canEdit: boolean }) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const [saved, setSaved] = useState<RunnerView["automaticAccountSwitching"]>();
  const current = saved && saved.revision >= (runner.automaticAccountSwitching?.revision ?? 0) ? saved : runner.automaticAccountSwitching;
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const supported = !online || runnerSupportsProtocol(runner.protocolVersion, "automaticProviderAccountSwitch");
  const save = async () => {
    if (inFlight.current || !canEdit || !supported) return;
    inFlight.current = true; setError(null);
    const enabled = !current?.enabled;
    const expectedRevision = current?.revision ?? 0;
    try {
      if (enabled && !await confirm({ title: "Turn On Automatic Switching", message: "At a usage limit, the next turn moves to another account from the same provider.",
        details: <Notice tone="warning" compact>{TERMS}</Notice>, confirmLabel: "Turn On Automatic Switching" })) return;
      setSaving(true);
      const { automaticAccountSwitching } = await api.updateMachineAutomaticAccountSwitching(runner.runnerId, { enabled, expectedRevision });
      setSaved(automaticAccountSwitching);
      showToast(online ? "Usage-limit switching updated." : "Switching setting saved. It takes effect when a compatible runner reconnects.", { tone: "success" });
    } catch (cause) {
      const value = conflictCurrent(cause);
      const conflict = value && typeof value.enabled === "boolean";
      if (conflict) setSaved({ enabled: value.enabled as boolean, revision: value.revision as number });
      setError(conflict ? "The setting changed in another client. The switch now shows the saved value. Choose again to change it." : machineSettingsMutationError(cause));
    } finally { inFlight.current = false; setSaving(false); }
  };
  return <>
    <div className="surface">
      <SwitchRow title="Switch Accounts at a Usage Limit" checked={current?.enabled ?? false}
        description="Can move a running session's next turn." busy={saving} busyLabel="Saving the switching setting…"
        disabled={!canEdit || !supported} disabledReason={!canEdit ? "Only an organization owner or admin who can manage this machine can change account settings."
          : !supported ? "Update the runner to change usage-limit switching." : undefined}
        onClick={() => void save()} />
    </div>
    {error && <Notice compact tone="danger" title="Couldn't Save the Switching Setting" role="alert">{error}</Notice>}
  </>;
}
