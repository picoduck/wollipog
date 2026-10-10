import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, SessionView, WorkflowArtifactKind, WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { BrowserPanel } from "../components/BrowserPanel.js";
import { SESSION_TOOL_ICONS } from "../components/RightPanel.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Browser tool (#2854) in a side panel column: 400px on a desktop and the whole width on a
 * phone, under a stand-in for the panel's 48px header. `?theme=light` switches the theme;
 * `?artifacts=list|loading|empty|error` chooses what the artifact list answers (a list by default).
 * An opened artifact's bytes are real and match their checksum (#2855); `?preview=loading` never
 * answers and `?preview=mismatch` answers with bytes that fail it.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const session: SessionView = {
  id: "browser-panel-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "claude", agentName: "Claude", title: "Preview the Dashboard", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const now = Date.now();
const minute = 60_000;
const encoder = new TextEncoder();

/** Text padded with trailing spaces to the size the row shows, so the list reads as it did. */
function padded(text: string, sizeBytes: number): Uint8Array {
  const bytes = encoder.encode(text);
  if (bytes.byteLength >= sizeBytes) return bytes;
  const out = new Uint8Array(sizeBytes).fill(0x20);
  out.set(bytes);
  return out;
}

const REPORT = `# Review of the Browser panel rebuild

The Browser tool now opens an artifact under one header, with the title from its leading edge.

## Findings

- **No blockers.** Every acceptance criterion has a DOM or browser test.
- The address row stays on one line down to a 320px panel.
- Downloads keep the authenticated fetch and the byte check.

## Checked

| Area | Result |
| --- | --- |
| Artifacts tab | Passed |
| Web Preview | Passed |

\`\`\`ts
const verified = await verifyArtifactPreviewBlob(artifact, blob);
\`\`\`
`;

const HTML = `<!doctype html><html><head><style>
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: #1f2328; background: #f6f8fa; }
header { padding: 16px 20px; background: #0b5cad; color: #fff; font-weight: 600; }
main { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 16px 20px; }
.card { padding: 12px; border: 1px solid #d0d7de; border-radius: 8px; background: #fff; }
.card b { display: block; font-size: 22px; }
</style></head><body><header>Release Dashboard</header><main>
<div class="card">Builds<b>128</b></div><div class="card">Failures<b>3</b></div>
<div class="card">Median Time<b>4m 12s</b></div><div class="card">Flaky Tests<b>1</b></div>
</main><script>document.body.style.background = "red";</script></body></html>`;

const LOG = Array.from({ length: 4_000 }, (_, index) => {
  const at = `12:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`;
  return index % 97 === 0
    ? `${at} ▶ apps/web/src/components/ArtifactPreview.anatomy.dom.test.tsx › the artifact preview's bodies › JSON reads in the diff's token classes inside a code well whose Wrap Lines toggles`
    : `${at} ✔ apps/web/src/components/BrowserPanel.dom.test.tsx › test ${index} (${(index % 13) + 2}ms)`;
}).join("\n");

const VERDICT = JSON.stringify({
  verdict: "pass", reviewer: "codex", round: 2, blocking: 0,
  findings: [{ id: "CR-1.1", severity: "minor", resolved: true }], flaky: false, notes: null,
});

const PATCH = `diff --git a/apps/web/src/components/BrowserPanel.tsx b/apps/web/src/components/BrowserPanel.tsx
--- a/apps/web/src/components/BrowserPanel.tsx
+++ b/apps/web/src/components/BrowserPanel.tsx
@@ -1,3 +1,3 @@
-<form className="browser-address">
+<form className="toolbar browser-address" noValidate>
`;

/** A 1280×800 capture with transparent margins, drawn here so its bytes and checksum are real. */
async function screenshotBytes(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#1e2430";
  context.fillRect(80, 60, 1120, 680);
  context.fillStyle = "#2f6feb";
  context.fillRect(80, 60, 1120, 64);
  context.fillStyle = "#e6edf3";
  context.font = "600 28px system-ui, sans-serif";
  context.fillText("Settings", 112, 102);
  context.fillStyle = "#3d4757";
  for (let row = 0; row < 6; row += 1) context.fillRect(112, 160 + row * 88, 1056, 64);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ArtifactFixture { kind: WorkflowArtifactKind; name: string; mimeType: string; ageMs: number; bytes: Uint8Array }

const fixtures: Record<string, ArtifactFixture> = {
  a1: { kind: "review_report", name: "Review of the Browser panel rebuild", mimeType: "text/markdown", ageMs: 4 * minute, bytes: padded(REPORT, 6_212) },
  a2: { kind: "html_preview", name: "Dashboard preview", mimeType: "text/html", ageMs: 12 * minute, bytes: padded(HTML, 1_741) },
  a3: { kind: "test_log", name: "web unit suite.log", mimeType: "text/plain", ageMs: 38 * minute, bytes: padded(LOG, 284_311) },
  a4: { kind: "verdict", name: "verdict.json", mimeType: "application/json", ageMs: 2 * 60 * minute, bytes: padded(VERDICT, 912) },
  // Drawn before the first render (see `start`).
  a5: { kind: "screenshot", name: "Settings at 390px, dark theme.png", mimeType: "image/png", ageMs: 3 * 60 * minute, bytes: new Uint8Array() },
  a6: { kind: "video", name: "Checkout flow.webm", mimeType: "video/webm", ageMs: 26 * 60 * minute, bytes: new Uint8Array(3_811_220) },
  a7: { kind: "patch", name: "fix-address-row.patch", mimeType: "text/x-diff", ageMs: 3 * 24 * 60 * minute, bytes: padded(PATCH, 4_420) },
};

/** Filled by `start` before the first render, once every fixture's checksum is known. */
let artifacts: WorkflowArtifactView[] = [];

async function describeFixtures(): Promise<WorkflowArtifactView[]> {
  fixtures.a5!.bytes = await screenshotBytes();
  return Promise.all(Object.entries(fixtures).map(async ([id, fixture]) => ({
    artifactId: id, sessionId: session.id, kind: fixture.kind, name: fixture.name, mimeType: fixture.mimeType,
    encoding: fixture.kind === "screenshot" || fixture.kind === "video" ? "base64" as const : fixture.kind === "verdict" ? "json" as const : "utf8" as const,
    sizeBytes: fixture.bytes.byteLength, sha256: await sha256(fixture.bytes),
    createdBy: { kind: "agent" as const, id: session.id }, createdAt: now - fixture.ageMs,
  })));
}

const scenario = params.get("artifacts") ?? "list";
const listArtifacts = async (_sessionId: string, cursor?: string): Promise<WorkflowArtifactPage> => {
  if (scenario === "loading") return new Promise(() => undefined);
  if (scenario === "empty") return { artifacts: [] };
  if (scenario === "error") throw new Error("GET /api/sessions/browser-panel-e2e/artifacts failed: 503 Service Unavailable");
  return cursor ? { artifacts: artifacts.slice(5) } : { artifacts: artifacts.slice(0, 5), nextCursor: "page-2" };
};

const preview = params.get("preview");
const exportArtifact = async (artifactId: string): Promise<Blob> => {
  const fixture = fixtures[artifactId];
  if (!fixture) throw new Error(`GET /api/artifacts/${artifactId}/export failed: 404 Not Found`);
  if (preview === "loading") return new Promise(() => undefined);
  // The same length and type, one byte different: only the checksum can tell.
  const bytes = preview === "mismatch" ? fixture.bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte)) : fixture.bytes;
  return new Blob([bytes as BlobPart], { type: fixture.mimeType });
};

const client: ApiClient = { ...api, sessionWorkflowArtifacts: listArtifacts, artifactExport: exportArtifact };

/** The store only has to connect: nothing here reads a runner. */
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
  instanceId: "browser-panel-e2e",
  runtimeKey: "browser-panel-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

const BrowserIcon = SESSION_TOOL_ICONS.browser;

function Fixture() {
  const phone = window.innerWidth <= 760;
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <main className="app" style={{ height: "100vh", display: "flex", justifyContent: "flex-end", background: "var(--bg)" }}>
            <aside id="right-panel" className="rpanel" aria-label="Side Panel" style={{ width: phone ? "100%" : 400, height: "100vh" }}>
              <div className="rpanel-head">
                <span className="rpanel-switcher">
                  <span className="rpanel-switcher-icon" aria-hidden="true"><BrowserIcon /></span>
                  <span className="rpanel-switcher-name">Browser</span>
                </span>
              </div>
              <div className="rpanel-body">
                <BrowserPanel session={session} />
              </div>
            </aside>
          </main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  );
}

void describeFixtures().then((described) => {
  artifacts = described;
  createRoot(document.getElementById("root")!).render(<Fixture />);
});
