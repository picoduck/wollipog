import React, { useEffect, useRef, useState } from "react";
import type { SessionNamingMode, SessionNamingSettingsView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ActionRow, SAVED_MS, SelectRow, SettingsGroup, type RowFailure } from "./ui/SettingsRows.js";
import { TitleAgentDialog } from "./TitleAgentDialog.js";
import { TitleEndpointDialog } from "./TitleEndpointDialog.js";
import {
  LOAD_FAILED,
  TITLE_SOURCE_NO_PERMISSION,
  fallbackSentence,
  plainFailure,
  setupSummary,
  titleSourceOptions,
  type PlainFailure,
} from "./session-titles.js";

type Dialog = "agent" | "endpoint";

/**
 * Settings › Behavior › Session Titles (#3025), for the organization: one Title Source row, and once
 * an agent or an endpoint is set up, one row that says which, with Edit….
 *
 * First Message saves at once with the Saved check (§8.6). Agent and Custom Endpoint open their setup
 * dialog, and the stored source changes only when that dialog saves: Cancel leaves the previous one
 * selected and stored. A load or an instant save that fails is the group's danger notice with Retry,
 * in plain words; a dialog's failure stays in the dialog.
 *
 * The API projection is secret-free: the group can say a key is saved but never receives one.
 */
export function SessionTitlesPanel() {
  const api = useApi();
  const currentApi = useRef(api);
  currentApi.current = api;
  const mounted = useRef(true);
  const generation = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState<SessionNamingSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<(PlainFailure & { action: "load" | "save" }) | null>(null);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<{ kind: Dialog; from: "source" | "edit" } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const started = ++generation.current;
    const current = () => generation.current === started && currentApi.current === api;
    setSettings(null);
    setLoading(true);
    setError(null);
    setSaved(false);
    setSaving(false);
    setDialog(null);
    void api.sessionNamingSettings().then((next) => {
      if (current()) setSettings(next);
    }).catch((cause: unknown) => {
      if (current()) setError({ ...plainFailure(cause, LOAD_FAILED, ""), action: "load" });
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { generation.current++; };
  }, [api, retry]);

  // The check is a moment, not a state (§8.6).
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /** Whether a change started now still belongs to what is shown: a reload or another instance ends it. */
  const owner = () => {
    const requestApi = api;
    const started = generation.current;
    return () => mounted.current && currentApi.current === requestApi && generation.current === started;
  };
  /** Runs a change against the API it started with; a reload or another instance drops its answer. */
  const request = async <T,>(operation: (requestApi: typeof api) => Promise<T>): Promise<T | undefined> => {
    const current = owner();
    const result = await operation(api);
    return current() ? result : undefined;
  };
  /** A dialog's change: the settings it returns are shown, and the dialog closes. Failures reject to it. */
  const applyFromDialog = async (operation: (requestApi: typeof api) => Promise<SessionNamingSettingsView>) => {
    const next = await request(operation);
    if (!next) return;
    setSettings(next);
    setError(null);
    setSaved(true);
    setDialog(null);
  };
  /** A key action inside the endpoint dialog: the dialog stays open on the new state. */
  const applyInDialog = async (operation: (requestApi: typeof api) => Promise<SessionNamingSettingsView>) => {
    const next = await request(operation);
    if (next) setSettings(next);
  };

  const saveFirstMessage = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    // Its failure and its end are as much the old instance's as its answer.
    const current = owner();
    try {
      const next = await request((requestApi) => requestApi.updateSessionNamingSettings({ mode: "prompt_text_only" }));
      if (next) {
        setSettings(next);
        setSaved(true);
      }
    } catch (cause) {
      if (current()) setError({ ...plainFailure(cause, "The title source wasn't saved."), action: "save" });
    } finally {
      if (current()) setSaving(false);
    }
  };

  const choose = (mode: SessionNamingMode) => {
    if (!settings || mode === settings.mode && mode === "prompt_text_only") return;
    if (mode === "prompt_text_only") void saveFirstMessage();
    else setDialog({ kind: mode === "session_agent_account" ? "agent" : "endpoint", from: "source" });
  };

  // Retry repeats what failed: the read, or the change itself.
  const groupFailure: RowFailure | null = error ? {
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    onRetry: () => {
      if (error.action === "save") void saveFirstMessage();
      else setRetry((value) => value + 1);
    },
  } : null;

  const canManage = settings?.canManage === true;
  const summary = settings ? setupSummary(settings) : null;
  const fallback = settings ? fallbackSentence(settings) : null;
  const options = titleSourceOptions(settings);
  // Unknown until the read answers, so no option's sentence stands in for it.
  const sourceDescription = settings
    ? (!summary && fallback) || options.find((option) => option.value === settings.mode)?.description
    : undefined;
  // The Title Source trigger, which a dialog opened from it returns focus to. Select keeps its trigger
  // to itself, and it is the group's first control.
  const sourceTrigger = {
    get current() {
      return headingRef.current?.closest("section")?.querySelector<HTMLElement>(".setting-row-control button") ?? null;
    },
  };
  const returnFocusRef = dialog?.from === "edit" ? editRef : sourceTrigger;

  return (
    <>
      <SettingsGroup title="Session Titles" scope="Your Account" headingRef={headingRef} failure={groupFailure}>
        <SelectRow
          title="Title Source"
          description={sourceDescription}
          options={options}
          value={settings?.mode ?? "prompt_text_only"}
          disabled={!settings || loading || saving || !canManage}
          disabledReason={settings && !canManage ? TITLE_SOURCE_NO_PERMISSION : undefined}
          busy={loading || saving}
          busyLabel={loading ? "Loading the title source…" : undefined}
          saved={saved}
          onChange={(value) => choose(value as SessionNamingMode)}
          menuWidth={360}
        />
        {settings && summary && (
          <ActionRow
            title={summary.title}
            description={fallback ?? summary.description}
            actionLabel="Edit…"
            hasPopup="dialog"
            buttonRef={editRef}
            disabled={!canManage || saving}
            onAction={() => setDialog({ kind: settings.mode === "session_agent_account" ? "agent" : "endpoint", from: "edit" })}
          />
        )}
      </SettingsGroup>
      {settings && dialog?.kind === "agent" && (
        <TitleAgentDialog
          settings={settings}
          returnFocusRef={returnFocusRef}
          onClose={() => setDialog(null)}
          onSave={(target) => applyFromDialog((requestApi) => target
            ? requestApi.configureSessionNamingHarness(target)
            : requestApi.updateSessionNamingSettings({ mode: "session_agent_account" }))}
        />
      )}
      {settings && dialog?.kind === "endpoint" && (
        <TitleEndpointDialog
          settings={settings}
          returnFocusRef={returnFocusRef}
          onClose={() => setDialog(null)}
          onSave={(config) => applyFromDialog((requestApi) => config
            ? requestApi.configureSessionNamingCustomModel(config)
            : requestApi.updateSessionNamingSettings({ mode: "custom_model_endpoint" }))}
          onReplaceKey={(apiKey) => applyInDialog((requestApi) => requestApi.replaceSessionNamingCustomModelApiKey({ apiKey }))}
          onDeleteKey={() => applyInDialog((requestApi) => requestApi.deleteSessionNamingCustomModelApiKey())}
          onTest={async () => {
            const result = await request((requestApi) => requestApi.testSessionNamingCustomModel());
            if (!result) throw new Error("The settings changed while testing.");
            return result;
          }}
        />
      )}
    </>
  );
}
