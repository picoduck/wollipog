/**
 * Panel pages harness (#2856): the real side panel on Agents over thirty workers, so a row far down
 * the list opens its page and Back returns to it.
 *
 * `extras=1` also mounts an About popover and three panel notices into the real header's action slot
 * and notice region. No tool passes either yet (Background Work, Side Chat and the Agents notices
 * add theirs in their own units), so the harness does it the way a tool would.
 * `theme=light` switches the palette.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { InfoPopover } from "../components/InfoPopover.js";
import { Notice } from "../components/Notice.js";
import { PanelNoticeRegionContext, PanelNoticeSlot } from "../components/PanelNoticeSlot.js";
import { PanelActionSlotContext, PanelHeaderActions, RightPanel, useRightPanelState } from "../components/RightPanel.js";
import { PANEL_NOTICE_RANK, type SessionNoticeEntry } from "../components/SessionNoticeSlot.js";
import { useIsMobile } from "../components/useIsMobile.js";
import { StoreProvider } from "../store.js";
import type { TimelineItem } from "../timeline.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
const extras = params.get("extras") === "1";

const NOW = Date.now();
const MINUTE = 60_000;
const session = {
  id: "s_panel_pages", runnerId: "runner-1", workspaceId: null, agentId: "claude-native", driver: "claude-code",
  title: "Split the Billing Service Into Read and Write Paths", status: "running", adopted: false, eventEpoch: 1,
  archived: false, runId: null, parentSessionId: null, pendingApproval: null, createdAt: NOW - 60 * MINUTE,
  updatedAt: NOW, lastEventAt: NOW, messageCount: 80, tokensIn: 0, tokensOut: 0, costUsd: 0,
} as SessionView;

const TASKS = ["Audit", "Migrate", "Review", "Test", "Document", "Profile"];
const AREAS = ["Invoices", "Ledger", "Refunds", "Webhooks", "Payouts"];
const items: TimelineItem[] = Array.from({ length: 30 }, (_, index) => ({
  kind: "tool_call", id: index * 2 + 1, toolCallId: `worker-${index + 1}`,
  title: `${TASKS[index % TASKS.length]} ${AREAS[index % AREAS.length]} ${index + 1}`, text: "",
  toolKind: "agent", status: index < 24 ? "completed" : "in_progress",
  startedAt: NOW - (40 - index) * MINUTE, ...(index < 24 ? { completedAt: NOW - (30 - index) * MINUTE } : {}),
}) as TimelineItem).flatMap((call, index) => [call, {
  kind: "agent_message", id: index * 2 + 2, parentToolUseId: `worker-${index + 1}`, createdAt: NOW - (20 - index) * MINUTE,
  text: `Checked ${index + 3} files in the ${AREAS[index % AREAS.length]!.toLowerCase()} module; two need a migration step.`,
} as TimelineItem]);

const client = {
  ...api,
  childSessions: () => Promise.reject(new ApiError("This fixture has no durable child-session registry.", 404)),
} as ApiClient;
const connection: UiConnectionRuntime = {
  instanceId: "panel-pages", runtimeKey: "panel-pages",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

function notice(key: string, rank: number, title: string, text: string): SessionNoticeEntry {
  return {
    key, severity: "warning", rank, title,
    render: ({ trailing }) => <Notice tone="warning" title={title} ariaLabel={title} trailing={trailing}>{text}</Notice>,
  };
}
const NOTICES = [
  notice("offline", PANEL_NOTICE_RANK.runnerOffline, "Machine Offline",
    "Workers are shown as last recorded until the machine reconnects."),
  notice("inventory", PANEL_NOTICE_RANK.inventoryError, "Background Work Unavailable",
    "The machine did not return its background jobs."),
  notice("identity", PANEL_NOTICE_RANK.ambiguousIdentity, "2 Workers Not Listed",
    "Two workers share a provider identity and cannot be listed safely."),
];

/** What a tool would render in its body: an About popover in the header and its notices. */
function Extras() {
  const [slots, setSlots] = useState<{ actions: HTMLElement; notices: HTMLElement } | null>(null);
  useEffect(() => {
    let frame = 0;
    const find = () => {
      const actions = document.querySelector<HTMLElement>("#right-panel .rpanel-actions");
      const notices = document.querySelector<HTMLElement>("#right-panel .rpanel-notices");
      if (actions && notices) setSlots({ actions, notices });
      else frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!slots) return null;
  return (
    <PanelActionSlotContext.Provider value={slots.actions}>
      <PanelHeaderActions>
        <InfoPopover tool="Agents" facts={[
          { term: "Shows", value: "Subagents, background jobs and the sessions of this run or pod" },
          { term: "Status", value: "Read from the transcript and the machine's records" },
        ]}>
          Everyone working for this session, current and finished.
        </InfoPopover>
      </PanelHeaderActions>
      <PanelNoticeRegionContext.Provider value={{ element: slots.notices, focusHead: () => undefined }}>
        <PanelNoticeSlot sessionId={session.id} entries={NOTICES} />
      </PanelNoticeRegionContext.Provider>
    </PanelActionSlotContext.Provider>
  );
}

function Fixture() {
  const state = useRightPanelState();
  // The fixture opens on Agents once, as the session's Agents control would.
  useEffect(() => { state.show("subagents"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The app's rail takes its width from the row the chat and the panel share; a phone has none.
  const phone = useIsMobile();
  return (
    <main className="app" style={{ display: "flex", height: "100dvh" }}>
      {!phone && <div aria-hidden="true" style={{ flex: "none", width: "var(--rail-w)", borderRight: "1px solid var(--border)" }} />}
      <section className="session-detail expanded" style={{ flex: 1, minWidth: 0, height: "100%" }}>
        <header className="detail-bar session-bar">
          <h1 className="detail-bar-title session-bar-title">{session.title}</h1>
          <button type="button" className="btn ghost" onClick={() => state.showSubagent(session.id, 1, "worker-27")}>
            Open Worker 27
          </button>
        </header>
        <div className="detail-columns">
          <div className="detail-chat">
            <div className="detail-main">
              <div className="detail-reader">
                <div className="detail-scroll" role="region" aria-label="Session Activity" tabIndex={-1}>
                  {Array.from({ length: 12 }, (_, index) => (
                    <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                      <div className="tl-bubble">Transcript message {index + 1}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <RightPanel
            state={state}
            session={session}
            runnerOnline
            runnerProtocolVersion={PROTOCOL_VERSION}
            onOpenSourceLocation={() => {}}
            onClearSourceLocation={() => {}}
            git={{
              status: null, observation: 0, observedAt: null, settled: true, busy: false, error: null, errorCode: null,
              refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
            }}
            onOpenTerminal={() => {}}
            onInsertSideChatDraft={() => {}}
            items={items}
          />
        </div>
      </section>
      {extras && state.open && <Extras />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <FeedbackProvider>
      <StoreProvider connection={connection}>
        <Fixture />
      </StoreProvider>
    </FeedbackProvider>
  </ApiProvider>,
);
