import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { ASSISTANT_DECISION_CATEGORIES, type AssistantThread } from "@wollipog/protocol";
import { assistantThreadAccessSentence, assistantThreadHarnessLabel } from "../assistant-threads.js";
import { launchedWorkIds, type LaunchedWork } from "../assistant-launched-work.js";
import { formatCalendarTime } from "../format.js";
import { formatUsd } from "../guardrail-values.js";
import { RIGHT_PANEL_DEFAULT_WIDTH } from "../right-panel.js";
import { shortcutLayerActive } from "../shortcuts.js";
import { useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { AssistantThreadDecisionHistory } from "./AssistantDecisionHistory.js";
import { AssistantThreadHistory } from "./AssistantThreadHistory.js";
import { AssistantWorkPanel } from "./AssistantWorkCards.js";
import { ASSISTANT_PANEL_TABS, type AssistantPanelState } from "./assistant-panel-state.js";
import { CloseIcon, Maximize2Icon, Minimize2Icon } from "./Icons.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { TabList } from "./Tabs.js";
import { useIsMobile } from "./useIsMobile.js";
import { useSidePanelLayout } from "./useSidePanelLayout.js";

export function AssistantThreadPanel({ state, thread, work, model, effort, onSettings, onDelegation, onOverlayChange }: {
  state: AssistantPanelState;
  thread: AssistantThread;
  work: LaunchedWork;
  model?: string;
  effort?: string;
  onSettings: () => void;
  onDelegation: () => void;
  onOverlayChange: (overlay: boolean) => void;
}) {
  const id = useId();
  const phone = useIsMobile();
  const { asideRef, effectiveWidth, overlaysAtWidth } = useSidePanelLayout(state.open, phone, RIGHT_PANEL_DEFAULT_WIDTH);
  const expanded = state.open && state.expanded && !phone;
  const overlay = state.open && !expanded && overlaysAtWidth;
  const covering = overlay || expanded || phone;
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [decisionCount, setDecisionCount] = useState<string | null>(null);
  const decisionHistorySupported = useStoreSelector((store) => store.assistantDecisionHistorySupported);
  useLayoutEffect(() => {
    onOverlayChange(overlay);
    return () => onOverlayChange(false);
  }, [overlay, onOverlayChange]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (state.open && !wasOpen.current) {
      returnFocus.current = active instanceof HTMLElement ? active : null;
    }
    if (state.open && covering && !asideRef.current?.contains(active)) {
      asideRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
    if (!state.open && wasOpen.current && active === document.body) {
      const target = returnFocus.current;
      if (target?.isConnected && target !== document.body && target.getClientRects().length > 0) target.focus();
      else document.querySelector<HTMLElement>("[data-assistant-panel-toggle]")?.focus();
    }
    wasOpen.current = state.open;
  }, [asideRef, state.open, covering]);

  if (!state.open) return null;
  const labels = { Work: launchedWorkIds(work).length, Decisions: decisionHistorySupported ? decisionCount : null, Details: null };
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = ASSISTANT_PANEL_TABS.indexOf(state.tab);
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (current + 1) % ASSISTANT_PANEL_TABS.length; break;
      case "ArrowLeft": next = (current + ASSISTANT_PANEL_TABS.length - 1) % ASSISTANT_PANEL_TABS.length; break;
      case "Home": next = 0; break;
      case "End": next = ASSISTANT_PANEL_TABS.length - 1; break;
      default: return;
    }
    event.preventDefault();
    state.show(ASSISTANT_PANEL_TABS[next]!);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return <>
    {overlay && <div className="rpanel-scrim" aria-hidden="true" onClick={state.close} />}
    {expanded && !overlaysAtWidth && <div className="rpanel-spacer" aria-hidden="true" style={{ width: effectiveWidth }} />}
    <aside ref={asideRef} id="right-panel" className="rpanel assistant-thread-panel" aria-label="Side Panel"
      data-presentation={phone ? "sheet" : expanded ? "expanded" : overlay ? "overlay" : "docked"}
      style={expanded ? undefined : { width: effectiveWidth }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || shortcutLayerActive(document, false, event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        if (expanded) state.setExpanded(false);
        else state.close();
      }}>
      <div className="rpanel-head">
        <TabList label="Thread Panel" onKeyDown={onTabKeyDown}>
          {ASSISTANT_PANEL_TABS.map((tab) => <button key={tab} type="button" role="tab" className="tab"
            id={id + tab} aria-controls={id + tab + "-panel"} aria-selected={state.tab === tab}
            tabIndex={state.tab === tab ? 0 : -1} onClick={() => state.show(tab)}>
            {tab}{labels[tab] != null && <> <span className="count">{labels[tab]}</span></>}
          </button>)}
        </TabList>
        {!phone && <button type="button" className="icon-btn" onClick={() => state.setExpanded(!expanded)}
          title={expanded ? "Restore Panel" : "Expand Panel"} aria-label={expanded ? "Restore Panel" : "Expand Panel"}>
          {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </button>}
        <button type="button" className="icon-btn" onClick={state.close} title="Close Panel" aria-label="Close Panel">
          <CloseIcon />
        </button>
      </div>
      {ASSISTANT_PANEL_TABS.map((tab) => <div key={tab} className="rpanel-body" role="tabpanel"
        id={id + tab + "-panel"} aria-labelledby={id + tab} tabIndex={state.tab === tab ? 0 : -1} hidden={state.tab !== tab}>
        {tab === "Decisions" && <>
          <DelegationSummary thread={thread} onDelegation={onDelegation} />
          {decisionHistorySupported
            ? <AssistantThreadDecisionHistory threadId={thread.id} onCount={setDecisionCount} />
            : <p className="muted">This control plane does not support delegated decision history.</p>}
        </>}
        {tab === "Work" && <AssistantWorkPanel work={work} beforeReview={() => {
          if (covering) flushSync(state.close);
        }} />}
        {tab === "Details" && <ThreadDetails thread={thread} model={model} effort={effort} onSettings={onSettings} />}
      </div>)}
    </aside>
  </>;
}

function DelegationSummary({ thread, onDelegation }: { thread: AssistantThread; onDelegation: () => void }) {
  const grant = thread.decisionDelegation?.grant;
  const expiresAt = grant?.expiresAt;
  const now = useTimelineClock(expiresAt != null);
  const scope = grant?.categories.length === Object.keys(ASSISTANT_DECISION_CATEGORIES).length &&
    grant.projects === "all" && grant.campaigns === "all" ? "Delegate All" : "Selected Decisions";
  return <div className="assistant-delegation-summary">
    <strong>{grant ? scope : "Not Delegated"}</strong>
    {grant && <p className="muted">
      {expiresAt != null && expiresAt <= now ? "Expired" : "Active"}
      {expiresAt == null ? " · No Expiration" : " · " + (expiresAt <= now ? "Expired " : "Expires ") + formatCalendarTime(expiresAt, now)}
    </p>}
    {thread.status !== "archived" && thread.decisionDelegation && <button type="button" className="btn sm" onClick={onDelegation}>
      {grant ? "Manage…" : "Delegate…"}
    </button>}
  </div>;
}

function ThreadDetails({ thread, model, effort, onSettings }: {
  thread: AssistantThread;
  model?: string;
  effort?: string;
  onSettings: () => void;
}) {
  return <div className="assistant-panel-details">
    <dl className="facts">
      <div><dt>Harness</dt><dd>{assistantThreadHarnessLabel(thread.harness)}</dd></div>
      <div><dt>Model</dt><dd>{model ?? "Not Recorded"}</dd></div>
      <div><dt>Effort</dt><dd>{effort ?? "Not Recorded"}</dd></div>
      <div><dt>Account</dt><dd>{thread.providerAccountLabel
        ? <PersonalIdentifier value={thread.providerAccountLabel} sensitive label="Account" />
        : "Machine Sign-In"}</dd></div>
      <div><dt>Access</dt><dd>{assistantThreadAccessSentence(thread.access)}</dd></div>
      <div><dt>Started</dt><dd><time dateTime={new Date(thread.createdAt).toISOString()}>{formatCalendarTime(thread.createdAt)}</time></dd></div>
    </dl>
    {thread.usage && <>
      <ThreadUsageMeter label="Budget" value={thread.usage.costUsd} format={formatUsd} unlimited="No Budget" />
      <ThreadUsageMeter label="Session Launches" value={thread.usage.launchedSessions} format={String}
        unlimited="No Launch Limit" paused={thread.launchPaused} />
    </>}
    {!!thread.earlierConversations?.length && <AssistantThreadHistory entries={thread.earlierConversations} />}
    <button type="button" className="btn" onClick={onSettings}>Thread Settings…</button>
  </div>;
}

export function ThreadUsageMeter({ label, value: { used, limit }, format, unlimited, paused, hideLabel }: {
  label: string;
  value: { used: number; limit: number | null };
  format: (value: number) => string;
  unlimited: string;
  paused?: boolean;
  hideLabel?: boolean;
}) {
  const total = limit == null ? unlimited : format(limit);
  const summary = label === "Budget"
    ? limit == null ? `${format(used)} spent · ${total}` : `${format(used)} of ${total} spent`
    : paused || limit === 0 ? `${used} launched · Launches Paused`
      : limit == null ? `${used} launched · ${total}` : `${used} of ${total} sessions launched`;
  return <div className="assistant-panel-meter">
    {!hideLabel && <strong>{label}</strong>}
    <span>{summary}</span>
    {limit != null && limit > 0 && <div className="meter is-progress" role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-valuetext={summary}>
      <span style={{ width: Math.min(100, 100 * used / limit) + "%" }} />
    </div>}
  </div>;
}

