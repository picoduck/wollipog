import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, SessionView, WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { BrowserPanel } from "../components/BrowserPanel.js";
import { EventTimeline } from "../components/EventTimeline.js";
import type { BrowserArtifactRequest } from "../components/right-panel-state.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import type { TimelineItem } from "../timeline.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * Session artifacts in the transcript and the Browser (#3924). One turn attaches eight screenshots,
 * so it shows three and a counted View All; a later turn attaches a log, which has no inline
 * preview. The transcript's Open in Browser opens the Browser beside it (over it on a phone), whose
 * list pages three at a time so a linked artifact can sit beyond the first page. Every image is a
 * real PNG whose checksum matches. `window.__ARTIFACT_GALLERY_E2E__.openLink(id)` follows an
 * artifact link the way the shell does on arrival.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const SESSION_ID = "artifact-gallery-e2e";
const session: SessionView = {
  id: SESSION_ID, runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "claude", agentName: "Claude", title: "Capture the Responsive States", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const SHOTS = [
  ["sessions-desktop", "Sessions, Desktop", "#3b82f6"],
  ["sessions-phone", "Sessions, Phone", "#10b981"],
  ["transcript-desktop", "Transcript, Desktop", "#f59e0b"],
  ["transcript-phone", "Transcript, Phone", "#ef4444"],
  ["browser-desktop", "Browser, Desktop", "#8b5cf6"],
  ["browser-phone", "Browser, Phone", "#ec4899"],
  ["settings-desktop", "Settings, Desktop", "#14b8a6"],
  ["settings-phone", "Settings, Phone", "#f97316"],
] as const;
const LOG_TEXT = "PASS apps/web/e2e/artifact-gallery.spec.ts\n  ✓ eight artifacts show three and View All\n";

/** A 1280×800 capture with a grid and a label, so a zoom and a pan read in the evidence. */
async function capture(label: string, color: string, index: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#0f172a";
  context.fillRect(0, 0, 1280, 800);
  context.strokeStyle = "rgba(255,255,255,0.12)";
  for (let x = 0; x <= 1280; x += 80) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 800); context.stroke(); }
  for (let y = 0; y <= 800; y += 80) { context.beginPath(); context.moveTo(0, y); context.lineTo(1280, y); context.stroke(); }
  context.fillStyle = color;
  context.fillRect(160, 160, 960, 480);
  context.fillStyle = "#ffffff";
  context.font = "bold 72px sans-serif";
  context.textAlign = "center";
  context.fillText(label, 640, 380);
  context.font = "40px sans-serif";
  context.fillText(`Capture ${index + 1} of ${SHOTS.length}`, 640, 460);
  context.font = "20px monospace";
  context.textAlign = "left";
  context.fillText("top-left corner", 24, 40);
  context.textAlign = "right";
  context.fillText("bottom-right corner", 1256, 776);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const fixtures = new Map<string, { bytes: Uint8Array; mimeType: string }>();
const exports: string[] = [];
const listCursors: Array<string | null> = [];

async function describeArtifacts(): Promise<WorkflowArtifactView[]> {
  const now = Date.now();
  const shots = await Promise.all(SHOTS.map(async ([id, label, color], index) => {
    const bytes = await capture(label, color, index);
    fixtures.set(id, { bytes, mimeType: "image/png" });
    return {
      artifactId: id, sessionId: SESSION_ID, kind: "screenshot", name: `${id}.png`, mimeType: "image/png",
      encoding: "base64", sizeBytes: bytes.byteLength, sha256: await sha256(bytes),
      createdBy: { kind: "agent", id: SESSION_ID }, createdAt: now - (SHOTS.length - index) * 60_000,
    } satisfies WorkflowArtifactView;
  }));
  const logBytes = new TextEncoder().encode(LOG_TEXT);
  fixtures.set("e2e-log", { bytes: logBytes, mimeType: "text/plain" });
  const log: WorkflowArtifactView = {
    artifactId: "e2e-log", sessionId: SESSION_ID, kind: "test_log", name: "artifact-gallery.log", mimeType: "text/plain",
    encoding: "utf8", sizeBytes: logBytes.byteLength, sha256: await sha256(logBytes),
    createdBy: { kind: "agent", id: SESSION_ID }, createdAt: now,
  };
  return [...shots, log];
}

let artifacts: WorkflowArtifactView[] = [];
const PAGE_SIZE = 3;
const client: ApiClient = {
  ...api,
  sessionWorkflowArtifacts: async (_sessionId: string, cursor?: string): Promise<WorkflowArtifactPage> => {
    listCursors.push(cursor ?? null);
    const start = cursor ? Number(cursor) : 0;
    const next = start + PAGE_SIZE;
    return { artifacts: artifacts.slice(start, next), ...(next < artifacts.length ? { nextCursor: String(next) } : {}) };
  },
  artifactExport: async (artifactId: string): Promise<Blob> => {
    exports.push(artifactId);
    const fixture = fixtures.get(artifactId);
    if (!fixture) throw new Error(`GET /api/artifacts/${artifactId}/export failed: 404 Not Found`);
    return new Blob([fixture.bytes as BlobPart], { type: fixture.mimeType });
  },
};

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      const snapshot: ControlPlaneToUi = {
        type: "snapshot",
        capabilities: {
          sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false,
          projects: true, createProjectLocations: true,
        },
        runners: [], boxes: [], projects: [], sessions: [], runs: [], pods: [],
      };
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}
const connection: UiConnectionRuntime = {
  instanceId: SESSION_ID, runtimeKey: `${SESSION_ID}:1`, createSocket: () => new FixtureSocket(), close() {},
};
const navigation: ViewNavigation = { current: () => ({ name: "session", id: SESSION_ID }), push() {}, listen: () => () => {} };

function timelineItems(): TimelineItem[] {
  const shots = artifacts.filter((artifact) => artifact.kind === "screenshot");
  const log = artifacts.find((artifact) => artifact.kind === "test_log")!;
  let id = 0;
  const at = (offset: number) => Date.now() - 600_000 + offset * 1_000;
  const items: TimelineItem[] = [
    { kind: "user_message", id: ++id, text: "Capture every responsive state before I review the merge.", createdAt: at(id) },
    { kind: "agent_message", id: ++id, text: "Capturing the four surfaces at desktop and phone widths.", createdAt: at(id) },
  ];
  for (const shot of shots) items.push({ kind: "artifact_attached", id: ++id, artifact: shot, createdAt: at(id) });
  items.push({ kind: "agent_message", id: ++id, text: "All eight captures are attached. The phone layouts keep the composer in view.", createdAt: at(id) });
  // The first capture delivered again, as a replayed page would: it is not drawn or counted twice.
  items.push({ kind: "artifact_attached", id: ++id, artifact: shots[0]!, createdAt: at(id) });
  items.push({ kind: "user_message", id: ++id, text: "Attach the test log too.", createdAt: at(id) });
  items.push({ kind: "artifact_attached", id: ++id, artifact: log, createdAt: at(id) });
  items.push({ kind: "agent_message", id: ++id, text: "The log is attached.", createdAt: at(id) });
  return items;
}

function Fixture() {
  const phone = window.innerWidth <= 760;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [items] = useState(timelineItems);
  const [request, setRequest] = useState<BrowserArtifactRequest | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const nextRequest = useRef(0);
  const openArtifact = useCallback((artifactId?: string) => {
    setRequest({ sessionId: SESSION_ID, ...(artifactId ? { artifactId } : {}), request: ++nextRequest.current });
    setPanelOpen(true);
  }, []);
  const onOpenArtifact = useCallback((artifact: WorkflowArtifactView) => openArtifact(artifact.artifactId), [openArtifact]);
  (window as unknown as { __ARTIFACT_GALLERY_E2E__: unknown }).__ARTIFACT_GALLERY_E2E__ = {
    openLink: (artifactId?: string) => openArtifact(artifactId),
    exports: () => [...exports],
    listCursors: () => [...listCursors],
  };
  return (
    <main className="app" style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
      <section className="detail-chat" style={{ flex: 1, minWidth: 0, display: phone && panelOpen ? "none" : "flex", flexDirection: "column" }}>
        <div ref={scrollRef} className="detail-scroll" role="region" aria-label="Session Activity"
          style={{ flex: 1, overflow: "auto", padding: "16px" }}>
          <EventTimeline items={items} historyKey={`${SESSION_ID}:0`} scrollRef={scrollRef} onOpenArtifact={onOpenArtifact} />
        </div>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          <textarea aria-label="Message" className="input" rows={2} value={draft}
            onChange={(event) => setDraft(event.target.value)} style={{ width: "100%" }} />
        </div>
      </section>
      {panelOpen && (
        <aside id="right-panel" className="rpanel" aria-label="Side Panel"
          style={{ width: phone ? "100%" : 420, height: "100dvh", borderLeft: "1px solid var(--border)" }}>
          <div className="rpanel-head">
            <span className="rpanel-switcher"><span className="rpanel-switcher-name">Browser</span></span>
            <button type="button" className="btn sm" onClick={() => setPanelOpen(false)}>Close Panel</button>
          </div>
          <div className="rpanel-body">
            <BrowserPanel session={session} openArtifact={request} onOpenArtifactHandled={(handled) =>
              setRequest((current) => current?.request === handled ? null : current)} />
          </div>
        </aside>
      )}
    </main>
  );
}

void describeArtifacts().then((described) => {
  artifacts = described;
  createRoot(document.getElementById("root")!).render(
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <Fixture />
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>,
  );
});
