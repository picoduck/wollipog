import React, { useEffect, useRef, useState } from "react";
import type { ArtifactUploadPreference, ArtifactUploadSettingsView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useInstanceScope } from "../instance-scope.js";
import { ChevronRightIcon } from "./Icons.js";
import { SAVED_MS, SelectRow, SettingsGroup, type RowFailure } from "./ui/SettingsRows.js";

const OPTIONS = [
  { value: "manual", label: "Manual", description: "Upload only when the task or project asks for it." },
  { value: "wollipog_automatic", label: "Use Wollipog Automatically", description: "Authorize private uploads of relevant task evidence, including screenshots and videos." },
  { value: "external_hosting", label: "Use External Hosting", description: "Prefer the task's external hosting workflow." },
] as const;

/** The disabled reason for a server that predates the preference (§11.3). */
export const ARTIFACT_UPLOADS_UNSUPPORTED = "Update Wollipog to change this setting.";

/** A request that never reached Wollipog: a browser's own words for a failed fetch say nothing useful. */
export const ARTIFACT_UPLOADS_UNREACHABLE = "Couldn't reach Wollipog. Check the connection, then try again.";

type Failure = { unsupported: true } | { unsupported: false; message: string; detail?: string };

function failure(cause: unknown, action: "load" | "save"): Failure {
  if (cause instanceof ApiError && (cause.status === 404 || cause.status === 405 || cause.status === 501)) {
    return { unsupported: true };
  }
  // Not an answer from the server (a `TypeError` from fetch, or anything else thrown before one).
  if (!(cause instanceof ApiError)) return { unsupported: false, message: ARTIFACT_UPLOADS_UNREACHABLE };
  const detail = cause.message.trim() || undefined;
  return {
    unsupported: false,
    message: action === "load" ? "Couldn't load Artifact Uploads. Try again." : "Artifact Uploads wasn't saved. Try again.",
    ...(detail ? { detail } : {}),
  };
}

export function ArtifactUploadSettings() {
  const instanceScope = useInstanceScope();
  return <ArtifactUploadSettingsEditor key={instanceScope} />;
}

/**
 * Settings › Behavior › Evidence: one instant row (§8.2, §8.6). The chosen option's sentence is the
 * row's description and the rest is under About Artifact Uploads. A load or save shows the row's busy
 * line, a confirmed change its Saved check, and a failure the group's danger notice with Retry. A
 * server that predates the preference leaves the row disabled with the reason to update.
 */
function ArtifactUploadSettingsEditor() {
  const api = useApi();
  const currentApi = useRef(api);
  currentApi.current = api;
  const generation = useRef(0);
  const [settings, setSettings] = useState<ArtifactUploadSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<(Failure & { action: "load" | "save"; preference?: ArtifactUploadPreference }) | null>(null);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const started = ++generation.current;
    setSettings(null);
    setLoading(true);
    setError(null);
    setSaved(false);
    setSaving(false);
    void api.artifactUploadSettings().then((next) => {
      if (generation.current === started && currentApi.current === api) setSettings(next);
    }).catch((cause: unknown) => {
      if (generation.current === started && currentApi.current === api) setError({ ...failure(cause, "load"), action: "load" });
    }).finally(() => {
      if (generation.current === started && currentApi.current === api) setLoading(false);
    });
    return () => { generation.current++; };
  }, [api, retry]);

  // The check is a moment, not a state (§8.6).
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const save = async (preference: ArtifactUploadPreference) => {
    if (!settings || saving || preference === settings.preference) return;
    const started = ++generation.current;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await api.updateArtifactUploadSettings({ preference });
      if (generation.current === started && currentApi.current === api) {
        setSettings(next);
        setSaved(true);
      }
    } catch (cause) {
      if (generation.current === started && currentApi.current === api) {
        setError({ ...failure(cause, "save"), action: "save", preference });
      }
    } finally {
      if (generation.current === started && currentApi.current === api) setSaving(false);
    }
  };

  const unsupported = error?.unsupported === true;
  // Retry repeats what failed: the change itself, or the read.
  const groupFailure: RowFailure | null = error && !error.unsupported ? {
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    onRetry: () => {
      if (error.action === "save" && error.preference) void save(error.preference);
      else setRetry((value) => value + 1);
    },
  } : null;
  const value = settings?.preference ?? "manual";
  return (
    <SettingsGroup
      title="Evidence"
      scope="Your Account"
      failure={groupFailure}
      foot={(
        <details className="disclosure">
          <summary><ChevronRightIcon size={14} className="disclosure-chevron" />About Artifact Uploads</summary>
          <div className="disclosure-body">
            <p>Saved for your sessions on this instance. Applies when sessions launch or resume; live sessions keep their current instructions until then.</p>
            <p>Explicit task and project hosting requirements take priority.</p>
            <p>Native TUI sessions do not receive this guidance automatically; use explicit task instructions or the opt-in using-wollipog skill.</p>
          </div>
        </details>
      )}
    >
      <SelectRow
        title="Artifact Uploads"
        // Unknown until the read answers, so no option's sentence stands in for it.
        description={settings ? OPTIONS.find((option) => option.value === value)?.description : undefined}
        options={OPTIONS}
        value={value}
        disabled={!settings || loading || saving || unsupported}
        disabledReason={unsupported ? ARTIFACT_UPLOADS_UNSUPPORTED : undefined}
        busy={loading || saving}
        // A save keeps the confirmed choice's sentence with the spinner before it; a read has none yet.
        busyLabel={loading ? "Loading your choice…" : undefined}
        saved={saved}
        onChange={(next) => { void save(next as ArtifactUploadPreference); }}
        menuWidth={360}
      />
    </SettingsGroup>
  );
}
