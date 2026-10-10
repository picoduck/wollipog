import type { Page, WebSocketRoute } from "@playwright/test";
import { PROTOCOL_VERSION, type RunnerView, type SessionView, type UiSnapshotMessage } from "@wollipog/protocol";

/** Deterministic public synthetic data; never connects to a real control plane. */
export async function installInboxFixture(page: Page) {
  const capabilities = { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true };
  const runner: RunnerView = {
    runnerId: "synthetic-runner", hostname: "synthetic-machine", os: "linux", version: "1", status: "online",
    agents: [{ id: "synthetic-agent", name: "Synthetic Agent", command: "synthetic", args: [], env: {},
      driver: "codex-app-server", context: { kind: "native" }, available: true, capabilities }],
    workspaces: [{ id: "synthetic-workspace", name: "Synthetic Project", path: "/synthetic/project" }],
    connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION, agentsRefreshed: true,
  };
  const sessions: SessionView[] = Array.from({ length: 20 }, (_, index) => ({
    id: `synthetic-${index + 1}`, runnerId: runner.runnerId, workspaceId: "synthetic-workspace",
    workspaceName: "Synthetic Project", agentId: "synthetic-agent", agentName: "Synthetic Agent",
    title: `Synthetic Session ${index + 1}`, status: "idle", column: "review", runId: null,
    useWorktree: false, worktreePath: null, archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1,
    eventEpoch: 0, messageCount: 0, preview: "A deterministic session preview.", pendingApproval: null,
    driver: "codex-app-server", model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
  }));
  const snapshot: UiSnapshotMessage = { type: "snapshot", runners: [runner], boxes: [], sessions, runs: [], pods: [] };
  await page.addInitScript(() => {
    window.__WOLLIPOG_SAME_ORIGIN__ = 1;
    localStorage.setItem("wollipog.deviceToken", "synthetic-pairing-token");
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/identity") body = { context: { userId: "synthetic-user", organizationId: "synthetic-org", role: "owner" }, memberships: [], teams: [], devices: [] };
    else if (path === "/api/instance") body = { instanceId: "synthetic-instance", appVersion: "1" };
    else if (path.endsWith("/events")) body = { events: [], eventEpoch: 0, nextAfter: 0, hasMoreCached: false, hasMoreOlder: false, cacheComplete: true };
    else if (path.endsWith("/shells")) body = { shells: [{ shellId: "synthetic-shell", sessionId: "synthetic-1", name: "Synthetic Shell", createdAt: 1, pty: true, kind: "shell", status: "running" }] };
    else if (path.endsWith("/synthetic-shell/history")) body = { shellId: "synthetic-shell", chunks: [{ seq: 1, data: "Synthetic terminal output\r\n", stream: "stdout" }], nextAfter: 1, hasMore: false, truncatedBefore: false };
    else if (path.endsWith("/synthetic-shell/resize")) body = { ok: true };
    else if (path.endsWith("/capabilities")) body = capabilities;
    else if (path.endsWith("/session-commands")) body = { commands: [] };
    else if (/^\/api\/sessions\/synthetic-\d+$/.test(path)) body = { session: sessions.find((session) => path.endsWith(`/${session.id}`)) };
    else if (path === "/api/automations") body = { automations: [] };
    else if (path === "/api/skills") body = { skills: [] };
    else if (path === "/api/sessions") body = { sessions, hasMore: false };
    if (body === undefined) await route.fulfill({ status: 404, json: { error: "Unsupported synthetic endpoint" } });
    else await route.fulfill({ json: body });
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ui**", (socket) => {
    sockets.push(socket);
    socket.send(JSON.stringify(snapshot));
  });
  return {
    disconnect: () => { for (const socket of sockets) socket.close({ code: 1006 }); },
    updateSession: (id: string, update: Partial<SessionView>) => {
      const session = sessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown synthetic session: ${id}`);
      Object.assign(session, update);
      for (const socket of sockets) socket.send(JSON.stringify({ type: "session_upsert", session }));
    },
  };
}
