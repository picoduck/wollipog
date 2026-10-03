import React, { useEffect, useRef, useState } from "react";
import type { ArtifactUploadPreference, ArtifactUploadSettingsView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useInstanceScope } from "../instance-scope.js";
import { Notice } from "./Notice.js";
import { SelectRow } from "./ui/SettingsRows.js";

const OPTIONS = [
  { value: "manual", label: "Manual", description: "Upload only when the task or project asks for it." },
  { value: "wollipog_automatic", label: "Use Wollipog Automatically", description: "Authorize private uploads of relevant task evidence, including screenshots and videos." },
  { value: "external_hosting", label: "Use External Hosting", description: "Prefer the task's external hosting workflow." },
] as const;

function failure(cause: unknown): { message: string; unsupported: boolean } {
  const unsupported = cause instanceof ApiError && (cause.status === 404 || cause.status === 405 || cause.status === 501);
  return {
    unsupported,
    message: unsupported
      ? "This control plane does not support artifact upload preferences. Update Wollipog to change this setting."
      : cause instanceof Error ? cause.message : "Could not save the artifact upload preference.",
  };
}

export function ArtifactUploadSettings() {
  const instanceScope = useInstanceScope();
  return <ArtifactUploadSettingsEditor key={instanceScope} />;
}

function ArtifactUploadSettingsEditor() {
  const api = useApi();
  const currentApi = useRef(api);
  currentApi.current = api;
  const generation = useRef(0);
  const [settings, setSettings] = useState<ArtifactUploadSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ReturnType<typeof failure> | null>(null);
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
      if (generation.current === started && currentApi.current === api) setError(failure(cause));
    }).finally(() => {
      if (generation.current === started && currentApi.current === api) setLoading(false);
    });
    return () => { generation.current++; };
  }, [api, retry]);

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
      if (generation.current === started && currentApi.current === api) setError(failure(cause));
    } finally {
      if (generation.current === started && currentApi.current === api) setSaving(false);
    }
  };

  return <>
    <SelectRow
      title="Artifact Uploads"
      description={<>Saved for your sessions on this instance. Applies when sessions launch or resume; live sessions keep their current instructions until then. Explicit task and project hosting requirements take priority. Native TUI sessions do not receive this guidance automatically; use explicit task instructions or the opt-in using-wollipog skill.</>}
      options={OPTIONS}
      value={settings?.preference ?? "manual"}
      disabled={!settings || loading || saving || !!error?.unsupported}
      onChange={(value) => { void save(value as ArtifactUploadPreference); }}
      menuWidth={360}
    />
    {loading && <p className="muted sm" role="status">Loading artifact upload preference…</p>}
    {saving && <p className="muted sm" role="status">Saving artifact upload preference…</p>}
    {saved && <p className="muted sm" role="status">Artifact upload preference saved.</p>}
    {error && <Notice tone="danger" role="alert" actions={!error.unsupported && (
      <button type="button" className="btn ghost sm" onClick={() => setRetry((value) => value + 1)}>Retry</button>
    )}>{error.message}</Notice>}
  </>;
}
