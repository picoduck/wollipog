import React, { useRef, useState } from "react";
import type { InstanceProfile } from "../desktop-instances.js";
import { relativeTime } from "../format.js";
import { useInstances, type InstanceAvailability } from "../instances-context.js";
import { CloseIcon, EditIcon, PlusIcon, RefreshIcon, UpdateIcon } from "./Icons.js";
import { useFeedback } from "./FeedbackProvider.js";
import { RemoteInstanceDialog } from "./RemoteInstanceDialog.js";

type DialogState =
  | { mode: "add" }
  | { mode: "edit"; profile: InstanceProfile }
  | { mode: "repair"; profile: InstanceProfile };

const STATUS_LABELS: Record<InstanceAvailability, string> = {
  saved: "Saved",
  connecting: "Connecting",
  online: "Online",
  offline: "Offline",
  "authentication-required": "Authentication Required",
  incompatible: "Incompatible",
  "missing-credential": "Authentication Required",
};

function lastConnected(value: string | undefined): string {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? relativeTime(parsed) : "Unknown";
}

export function InstancesPanel() {
  const instances = useInstances();
  const { confirm } = useFeedback();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const run = async (profileId: string, action: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [profileId]: true }));
    setErrors((current) => {
      const { [profileId]: _drop, ...rest } = current;
      return rest;
    });
    try {
      await action();
    } catch (cause) {
      setErrors((current) => ({ ...current, [profileId]: (cause as Error).message }));
    } finally {
      setBusy((current) => ({ ...current, [profileId]: false }));
    }
  };

  const remove = async (profile: InstanceProfile) => {
    const active = profile.id === instances.activeProfile.id;
    const accepted = await confirm({
      title: `Remove “${profile.label}”?`,
      message: active
        ? "This removes the saved connection and secure credential, then switches Wollipog to This Machine. Data on the remote instance is not deleted."
        : "This removes the saved connection and secure credential. Data on the remote instance is not deleted.",
      confirmLabel: "Remove Instance",
      tone: "danger",
    });
    if (!accepted) return;
    await run(profile.id, async () => {
      await instances.removeInstance(profile.id);
      window.setTimeout(() => addButtonRef.current?.focus(), 0);
    });
  };

  return (
    <div className="instances-page">
      <div className="view-toolbar connections-toolbar">
        <span className="muted">
          {instances.registry.profiles.length} Instance{instances.registry.profiles.length === 1 ? "" : "s"}
        </span>
        <div className="toolbar-actions">
          <button ref={addButtonRef} type="button" className="btn primary" onClick={() => setDialog({ mode: "add" })}>
            <PlusIcon />
            <span>Add Remote Instance</span>
          </button>
        </div>
      </div>
      <div className="instance-grid">
        {instances.registry.profiles.map((profile) => {
          const active = profile.id === instances.activeProfile.id;
          const status = instances.statusByProfile[profile.id]?.availability
            ?? (active && instances.phase === "opening" ? "connecting" : "saved");
          const statusMessage = instances.statusByProfile[profile.id]?.message;
          const pending = Boolean(busy[profile.id]) || status === "connecting";
          const needsRepair = status === "authentication-required" || status === "missing-credential";
          return (
            <article
              key={profile.id}
              className={`instance-card status-${status}${active ? " is-current" : ""}`}
              aria-busy={pending || undefined}
            >
              <div className="instance-card-head">
                <div className="instance-card-title">
                  <span className={`instance-status-dot status-${status}`} aria-hidden="true" />
                  <h2>{profile.label}</h2>
                  {active && <span className="connection-status status-current">Current</span>}
                  <span className={`connection-status status-${status}`}>{STATUS_LABELS[status]}</span>
                </div>
              </div>
              <dl className="instance-meta">
                <div>
                  <dt>Server Address</dt>
                  <dd>{profile.kind === "local" ? "Local Control Plane" : profile.origin}</dd>
                </div>
                <div>
                  <dt>Last Connected</dt>
                  <dd>{profile.kind === "local" ? "Available" : lastConnected(profile.lastConnectedAt)}</dd>
                </div>
              </dl>
              {statusMessage && <div className="instance-card-message">{statusMessage}</div>}
              {errors[profile.id] && <div className="instance-card-error" role="alert">{errors[profile.id]}</div>}
              <div className="instance-card-actions">
                {!active && (
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={pending}
                    onClick={() => void run(profile.id, () => instances.switchInstance(profile.id))}
                  >
                    {pending ? "Switching…" : "Switch"}
                  </button>
                )}
                {active && status === "offline" && (
                  <button type="button" className="btn primary sm" disabled={pending} onClick={() => void run(profile.id, () => instances.retryActive())}>
                    <RefreshIcon />
                    <span>Retry</span>
                  </button>
                )}
                {profile.kind === "remote" && (
                  <>
                    {needsRepair && (
                      <button type="button" className="btn primary sm" disabled={pending} onClick={() => setDialog({ mode: "repair", profile })}>
                        <UpdateIcon />
                        <span>Re-Pair</span>
                      </button>
                    )}
                    <button type="button" className="btn sm" disabled={pending} onClick={() => setDialog({ mode: "edit", profile })}>
                      <EditIcon />
                      <span>Edit</span>
                    </button>
                    {!needsRepair && (
                      <button type="button" className="btn sm" disabled={pending} onClick={() => setDialog({ mode: "repair", profile })}>
                        <UpdateIcon />
                        <span>Re-Pair</span>
                      </button>
                    )}
                    <button type="button" className="btn sm danger-text" disabled={pending} onClick={() => void remove(profile)}>
                      <CloseIcon />
                      <span>Remove</span>
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {dialog?.mode === "add" && <RemoteInstanceDialog mode="add" onClose={() => setDialog(null)} />}
      {dialog?.mode === "edit" && (
        <RemoteInstanceDialog mode="edit" profile={dialog.profile} onClose={() => setDialog(null)} />
      )}
      {dialog?.mode === "repair" && (
        <RemoteInstanceDialog mode="repair" profile={dialog.profile} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
