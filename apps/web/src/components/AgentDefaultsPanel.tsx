import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentHarnessDefaultConfig, AgentHarnessDefaultOption, AgentHarnessDefaultsView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { AgentDefaultsDialog } from "./AgentDefaultsDialog.js";
import { Spinner } from "./common.js";
import { RefreshIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { SkeletonRows } from "./QuestionPoliciesPanel.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ActionRow, SettingRow, SettingsGroup } from "./ui/SettingsRows.js";
import { agentDefaultsDescription, harnessIdentityKey, isConfigurable } from "./agent-defaults-options.js";

/** §12.3: a load that settles sooner shows nothing new. */
const SKELETON_DELAY_MS = 300;

interface LoadFailure {
  /** The server predates agent defaults (404): an update, not a retry, is what fixes it. */
  endpointMissing: boolean;
  detail: string;
}

function loadFailure(caught: unknown): LoadFailure {
  const status = caught instanceof Error && "status" in caught ? (caught as Error & { status?: unknown }).status : undefined;
  return {
    endpointMissing: status === 404,
    detail: caught instanceof Error ? caught.message : String(caught),
  };
}

/**
 * Settings › Behavior › Agent Defaults (#3024): the model, reasoning effort and permission mode each
 * agent starts new sessions with, one row per discovered agent and nothing to expand.
 *
 * Each row's Edit… opens `AgentDefaultsDialog`; an agent with nothing to choose says "Not
 * Configurable" instead. The group's head action refreshes the list, which also follows discovery
 * (`discoveryRevision`). A saved default whose agent is no longer discovered is still listed, so it
 * can be cleared.
 *
 * States (§12): skeleton rows while the first read is slow; a warning to update an older server; a
 * danger notice with Retry and Show Details for any other failure, above the rows when a refresh
 * fails; and No Agents Connected with Open Connections when nothing is discovered.
 */
export function AgentDefaultsPanel({
  discoveryRevision,
  onOpenConnections,
}: {
  /** A new object whenever discovery changes; the list is read again. */
  discoveryRevision?: object;
  onOpenConnections?: () => void;
} = {}) {
  const api = useApi();
  const activeApi = useRef(api);
  activeApi.current = api;
  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const previousDiscoveryRevision = useRef(discoveryRevision);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const [view, setView] = useState<AgentHarnessDefaultsView | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // A save or reset is in flight: a read that lands meanwhile is older than its answer.
  const mutating = useRef(false);
  const [loading, setLoading] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [failure, setFailure] = useState<LoadFailure | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const requestIsCurrent = useCallback((requestApi: typeof api, generation?: number) =>
    mounted.current && activeApi.current === requestApi &&
      (generation === undefined || loadGeneration.current === generation), []);

  const load = useCallback(async (reset: boolean): Promise<boolean> => {
    const requestApi = api;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setFailure(null);
    if (reset) setView(null);
    try {
      const next = await requestApi.agentHarnessDefaults();
      if (!requestIsCurrent(requestApi, generation)) return false;
      if (mutating.current) return false;
      setView(next);
      // The agent being edited is gone: its dialog closes, and focus falls back to Refresh.
      const editingKey = editingRef.current;
      if (editingKey && !next.defaults.some((option) => harnessIdentityKey(option) === editingKey)) setEditing(null);
      return true;
    } catch (caught) {
      if (!requestIsCurrent(requestApi, generation)) return false;
      setFailure(loadFailure(caught));
      return false;
    } finally {
      if (requestIsCurrent(requestApi, generation)) setLoading(false);
    }
  }, [api, requestIsCurrent]);

  useEffect(() => {
    setView(null);
    setEditing(null);
    mutating.current = false;
    void load(true);
    return () => { loadGeneration.current += 1; };
  }, [api, load]);

  useEffect(() => {
    if (Object.is(previousDiscoveryRevision.current, discoveryRevision)) return;
    previousDiscoveryRevision.current = discoveryRevision;
    if (viewRef.current) void load(false);
  }, [discoveryRevision, load]);

  const waiting = loading && !view && !failure;
  useEffect(() => {
    if (!waiting) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  /** Puts focus back where it was dropped, for a control that unmounted or refused it. */
  const restoreFocusIfLost = (target: () => HTMLElement | null | undefined) => {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) target()?.focus();
    });
  };

  const reload = (reset: boolean) => {
    void load(reset).then(() => restoreFocusIfLost(() => refreshRef.current));
  };

  /**
   * A save or reset. A read already in flight is dropped, since the answer here is newer; a failure
   * reads the list again, so the dialog repairs its draft against what the agent offers now.
   */
  const mutate = async (request: () => Promise<AgentHarnessDefaultsView>): Promise<void> => {
    const requestApi = api;
    const invalidateLoads = () => {
      loadGeneration.current += 1;
      setLoading(false);
      setFailure(null);
    };
    invalidateLoads();
    mutating.current = true;
    try {
      const next = await request();
      if (!requestIsCurrent(requestApi)) return;
      // Reads that started while it ran are older than this answer.
      invalidateLoads();
      mutating.current = false;
      setView(next);
      setEditing(null);
    } catch (caught) {
      if (requestIsCurrent(requestApi)) {
        mutating.current = false;
        void load(false);
      }
      throw caught;
    }
  };

  const save = (option: AgentHarnessDefaultOption, config: AgentHarnessDefaultConfig) => mutate(() =>
    api.updateAgentHarnessDefault({ agentId: option.agentId, driver: option.driver, context: option.context, config }));
  const reset = (option: AgentHarnessDefaultOption) => mutate(() =>
    api.deleteAgentHarnessDefault({ agentId: option.agentId, driver: option.driver, context: option.context }));

  const retry = (
    <BusyButton
      ref={retryRef}
      className="btn sm"
      busy={loading}
      progress="Loading agent defaults…"
      onClick={() => reload(!view)}
    >
      Retry
    </BusyButton>
  );
  const notice = failure && (failure.endpointMissing ? (
    <Notice tone="warning" role="status" title="Update Wollipog to Use Agent Defaults" actions={retry}>
      This version of Wollipog doesn't support agent defaults. Update or restart Wollipog so it matches this dashboard, then try again.
    </Notice>
  ) : (
    <Notice tone="danger" role="alert" title="Couldn't Load Agent Defaults" actions={retry} details={<code>{failure.detail}</code>}>
      {view
        ? "The agents below may be out of date. Retry to read them again."
        : "Wollipog couldn't read which agents you can set defaults for. Retry to read them again."}
    </Notice>
  ));

  const editingOption = editing ? view?.defaults.find((option) => harnessIdentityKey(option) === editing) : undefined;
  // Read when the dialog closes: the row's Edit…, or Refresh when the agent has gone. The dialog
  // unmounts before the row in the same commit, so the list decides, not whether the row is attached.
  const returnFocusRef = {
    get current(): HTMLElement | null {
      const listed = viewRef.current?.defaults.some((option) => harnessIdentityKey(option) === editing);
      return (listed && editing ? editButtons.current.get(editing) : undefined) ?? refreshRef.current;
    },
  };

  let rows;
  if (view && view.defaults.length === 0) {
    rows = (
      <div className="settings-state-surface">
        <State
          compact
          headingLevel={4}
          title="No Agents Connected"
          actions={onOpenConnections && (
            <button type="button" className="btn" onClick={onOpenConnections}>Open Connections</button>
          )}
        >
          Agents appear here once a machine with one is connected.
        </State>
      </div>
    );
  } else if (view) {
    rows = view.defaults.map((option) => {
      const key = harnessIdentityKey(option);
      // A saved default stays editable even when its agent offers nothing now, so it can be cleared.
      if (!option.preference && !isConfigurable(option)) {
        return (
          <SettingRow
            key={key}
            title={option.name}
            description="This agent has no model or permission choices."
            trailing
            control={<span className="setting-row-link-word">Not Configurable</span>}
          />
        );
      }
      return (
        <ActionRow
          key={key}
          title={option.name}
          description={agentDefaultsDescription(option)}
          actionLabel="Edit…"
          hasPopup="dialog"
          buttonRef={(node) => {
            if (node) editButtons.current.set(key, node);
            else editButtons.current.delete(key);
          }}
          onAction={() => setEditing(key)}
        />
      );
    });
  } else if (showSkeleton) {
    rows = <SkeletonRows count={3} announce="Loading agent defaults…" />;
  }

  return (
    <>
      <SettingsGroup
        title="Agent Defaults"
        scope="Your Account"
        intro="What each agent starts with. You can still change it in any session."
        action={(
          <button
            ref={refreshRef}
            type="button"
            className="icon-btn sm"
            aria-label="Refresh Agents"
            title="Refresh Agents"
            aria-disabled={loading || undefined}
            aria-busy={loading || undefined}
            onClick={() => { if (!loading) reload(false); }}
          >
            {loading ? <Spinner decorative /> : <RefreshIcon size={14} />}
          </button>
        )}
        notice={notice}
      >
        {rows}
      </SettingsGroup>
      {editingOption && (
        <AgentDefaultsDialog
          key={editing}
          option={editingOption}
          onSave={(config) => save(editingOption, config)}
          onReset={() => reset(editingOption)}
          onClose={() => setEditing(null)}
          returnFocusRef={returnFocusRef}
        />
      )}
    </>
  );
}
