import React, { useEffect, useRef, useState } from "react";
import type { DecisionModelSettingsView, DecisionModelTestResult } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { HarnessTargetDialog } from "./HarnessTargetDialog.js";
import { ActionRow, SAVED_MS, SelectRow, SettingsGroup, type RowFailure } from "./ui/SettingsRows.js";
import {
  DECISION_MODEL_DISCLOSURE,
  DECISION_MODEL_LOAD_FAILED,
  DECISION_MODEL_NO_PERMISSION,
  decisionModelSourceOptions,
  decisionModelTargetSummary,
  decisionTestSummary,
  type DecisionModelSource,
} from "./decision-model.js";
import { plainFailure, type PlainFailure } from "./session-titles.js";

const TEST_DESCRIPTION = "Runs one fixed decision and reports its verdict, latency and attempts.";
/** The Model Source row's busy announcement while the setting loads; the select keeps its label. */
const LOADING_ANNOUNCEMENT = "Loading the Decision Model…";

/**
 * Settings › Orchestrator › Decision Model (#4101), for the organization: a Model Source row
 * (Automatic or Chosen Agent), the chosen agent with Edit…, and Test Decision Model.
 *
 * Automatic saves at once with the Saved check (§8.6). Chosen Agent opens the agent dialog, and the
 * stored source changes only when that dialog saves. Every member reads the setting; only an
 * organization owner or admin changes or tests it.
 */
export function DecisionModelPanel() {
  const api = useApi();
  const currentApi = useRef(api);
  currentApi.current = api;
  const mounted = useRef(true);
  const generation = useRef(0);
  const editRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [settings, setSettings] = useState<DecisionModelSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<(PlainFailure & { action: "load" | "save" }) | null>(null);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<"source" | "edit" | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ result: DecisionModelTestResult } | { failure: PlainFailure } | null>(null);

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
    setDialog(null);
    void api.decisionModelSettings().then((next) => {
      if (current()) setSettings(next);
    }).catch((cause: unknown) => {
      if (current()) setError({ ...plainFailure(cause, DECISION_MODEL_LOAD_FAILED, ""), action: "load" });
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { generation.current++; };
  }, [api, retry]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /** Whether a change started now still belongs to what is shown. */
  const owner = () => {
    const requestApi = api;
    const started = generation.current;
    return () => mounted.current && currentApi.current === requestApi && generation.current === started;
  };

  const useAutomatic = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    const current = owner();
    try {
      const next = await api.useAutomaticDecisionModel();
      if (current()) {
        setSettings(next);
        setSaved(true);
      }
    } catch (cause) {
      if (current()) setError({ ...plainFailure(cause, "The Decision Model wasn't saved."), action: "save" });
    } finally {
      if (current()) setSaving(false);
    }
  };

  const choose = (source: DecisionModelSource) => {
    if (!settings) return;
    if (source === "automatic") {
      if (settings.source !== "automatic") void useAutomatic();
    } else {
      setDialog("source");
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTest(null);
    const current = owner();
    try {
      const result = await api.testDecisionModel();
      if (current()) setTest({ result });
    } catch (cause) {
      if (current()) setTest({ failure: plainFailure(cause, "The test didn't run.") });
    } finally {
      if (current()) setTesting(false);
    }
  };

  const groupFailure: RowFailure | null = error ? {
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    onRetry: () => {
      if (error.action === "save") void useAutomatic();
      else setRetry((value) => value + 1);
    },
  } : null;

  const canManage = settings?.canManage === true;
  const options = decisionModelSourceOptions(settings);
  const summary = settings ? decisionModelTargetSummary(settings) : null;
  const sourceTrigger = {
    get current() {
      return headingRef.current?.closest("section")?.querySelector<HTMLElement>(".setting-row-control button") ?? null;
    },
  };
  const testDescription = testing
    ? "Testing… This can take up to a minute and a half."
    : test && "result" in test
      ? decisionTestSummary(test.result)
      : test
        ? test.failure.message
        : TEST_DESCRIPTION;

  return (
    <>
      <SettingsGroup
        title="Decision Model"
        scope="This Organization"
        headingRef={headingRef}
        failure={groupFailure}
        intro="The model that answers bounded questions for Full Control campaigns. When it can't decide, the campaign owner does."
        foot={DECISION_MODEL_DISCLOSURE}
      >
        <SelectRow
          title="Model Source"
          description={settings ? options.find((option) => option.value === settings.source)?.description : undefined}
          options={options}
          value={settings?.source ?? "automatic"}
          disabled={!settings || loading || saving || !canManage}
          disabledReason={settings && !canManage ? DECISION_MODEL_NO_PERMISSION : undefined}
          busy={loading || saving}
          busyLabel={loading ? LOADING_ANNOUNCEMENT : undefined}
          saved={saved}
          onChange={(value) => choose(value as DecisionModelSource)}
          menuWidth={360}
        />
        {settings && summary && (
          <ActionRow
            title={summary.title}
            description={summary.description}
            actionLabel="Edit…"
            hasPopup="dialog"
            buttonRef={editRef}
            disabled={!canManage || saving}
            onAction={() => setDialog("edit")}
          />
        )}
        <ActionRow
          title="Test Decision Model"
          description={settings && !canManage ? DECISION_MODEL_NO_PERMISSION : testDescription}
          actionLabel="Run Test"
          disabled={!settings || !canManage || testing || saving}
          onAction={() => void runTest()}
        />
      </SettingsGroup>
      {settings && dialog && (
        <HarnessTargetDialog
          title="Agent for Decisions"
          description="This agent answers every campaign's Decision Model questions, with no tools."
          machineHelper="Decision inputs go to this machine's agent and its provider."
          progress="Saving the Decision Model…"
          failureSentence="Couldn't save the Decision Model."
          machines={settings.machines}
          {...(settings.target ? { selection: settings.target } : {})}
          returnFocusRef={dialog === "edit" ? editRef : sourceTrigger}
          onClose={() => setDialog(null)}
          onSave={async (target) => {
            if (!target) return;
            const current = owner();
            const next = await api.configureDecisionModel({
              runnerId: target.runnerId,
              agentId: target.agentId,
              driver: target.driver === "codex" ? "codex-app-server" : target.driver,
              model: target.model,
              effort: target.effort,
            });
            if (!current()) return;
            setSettings(next);
            setError(null);
            setSaved(true);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
