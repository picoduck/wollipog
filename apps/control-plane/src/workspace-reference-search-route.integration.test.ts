import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

/* GET /api/sessions/:id/workspace-references/search through the real control plane and a fake runner
 * socket (#4254): the route's validation of q, match and fuzzyWithDirectories, the request it forwards,
 * the echo it returns, and its failure statuses. The service's echo and limit rules are pinned in
 * sessions.test.ts. */

const DEVICE_TOKEN = "device-workspace-search-owner";
const RUNNER_TOKEN = "wollipogr_" + "w".repeat(43);
const OLD_RUNNER_TOKEN = "wollipogr_" + "o".repeat(43);
const runner = (runnerId: string): RunnerMetadata => ({ runnerId, hostname: "fixture", os: "linux", version: "test", agents: [], workspaces: [] });

type Frame = Record<string, unknown>;
type Reply = Frame | "hold";

/** A connected runner socket that records every workspace search and answers it with `reply`. */
async function connectRunner(url: string, runnerId: string, token: string, protocolVersion: number, logs: () => string) {
  const socket = new WebSocket(`${url.replace(/^http/u, "ws")}/runner`);
  const frames: Frame[] = [];
  const searches: Frame[] = [];
  let reply: (request: Frame) => Reply = () => ({ ok: true, results: [] });
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data)) as Frame;
    frames.push(value);
    if (value.type !== "search_workspace_references") return;
    searches.push(value);
    const answer = reply(value);
    if (answer === "hold") return;
    socket.send(JSON.stringify({ type: "search_workspace_references_result", requestId: value.requestId, ...answer }));
  });
  await new Promise<void>((done, reject) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`runner connection failed: ${logs()}`)), { once: true });
  });
  socket.send(JSON.stringify({ type: "register", token, protocolVersion, runner: runner(runnerId), liveSessions: [] }));
  for (let waited = 0; !frames.some((frame) => frame.type === "registered"); waited += 25) {
    if (waited > 10_000) throw new Error(`runner ${runnerId} was not registered: ${logs()}`);
    await delay(25);
  }
  return {
    socket,
    searches,
    answer(next: (request: Frame) => Reply) { reply = next; },
    /** The recorded searches without their generated request ids. */
    forwarded() {
      return searches.map(({ requestId, ...rest }) => {
        assert.match(String(requestId), /^wsr_search_/u);
        return rest;
      });
    },
  };
}

test("workspace search route validates, forwards and echoes its options and keeps its failure statuses (#4254)", { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-search-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));

  const seed = ControlPlaneDb.open(database);
  try {
    const local = seed.localIdentityContext();
    seed.createDevice({ id: "device-owner", name: "Search Test", tokenHash: hashToken(DEVICE_TOKEN), userId: local.userId,
      organizationId: local.organizationId, now: 1 });
    for (const [runnerId, token, protocolVersion, credentialId] of [
      ["r", RUNNER_TOKEN, PROTOCOL_VERSION, "rcred_42540000000000000000000000000001"],
      ["old", OLD_RUNNER_TOKEN, RUNNER_CAPABILITY_MIN_PROTOCOL.workspaceReferences - 1, "rcred_42540000000000000000000000000002"],
    ] as const) {
      seed.registerRunner(runner(runnerId), 1, protocolVersion);
      seed.issueRunnerCredential({
        credentialId, runnerId, organizationId: local.organizationId, ownerKind: "organization", ownerId: local.organizationId,
        label: "Workspace search fixture", tokenHash: hashToken(token), createdByUserId: local.userId,
        now: Date.now(), expiresAt: Date.now() + 120_000,
      });
    }
    for (const [id, runnerId] of [["s", "r"], ["old-s", "old"]] as const) {
      seed.createSession({ id, runnerId, workspaceId: null, agentId: null, title: id, useWorktree: false, driver: "claude-code",
        config: {}, scope: { organizationId: local.organizationId, owner: { kind: "user", userId: local.userId } }, now: 2 });
    }
  } finally { seed.close(); }

  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database, CONTROL_PLANE_TOKEN: "workspace-search-fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
        child.kill("SIGKILL"); await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 400 && !healthy; i++) {
    try { healthy = (await fetch(url + "/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!healthy) await delay(50);
  }
  assert.ok(healthy, logs);

  const search = async (query: string, sessionId = "s") => {
    const response = await fetch(`${url}/api/sessions/${sessionId}/workspace-references/search${query}`, {
      signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  // Offline before any runner connects: 409, with nothing to ask.
  assert.deepEqual(await search("?q=app&match=fuzzy"), { status: 409, body: { error: "runner is offline" } });

  const live = await connectRunner(url, "r", RUNNER_TOKEN, PROTOCOL_VERSION, () => logs);
  sockets.push(live.socket);

  // Validation: each refusal names its rule and never reaches the runner.
  const qMessage = { error: "q must contain 1-256 characters" };
  const matchMessage = { error: "match must be fuzzy when given" };
  const foldersMessage = { error: "fuzzyWithDirectories must be true when given" };
  const invalid: Array<[query: string, body: Record<string, unknown>]> = [
    ["", qMessage],
    ["?q=", qMessage],
    ["?q=%20%20%09", qMessage],
    [`?q=${"a".repeat(257)}`, qMessage],
    ["?q=a&q=b", qMessage],
    ["?q=app&match=substring", matchMessage],
    ["?q=app&match=FUZZY", matchMessage],
    ["?q=app&match=", matchMessage],
    ["?q=app&match=fuzzy&match=fuzzy", matchMessage],
    ["?q=app&fuzzyWithDirectories=false", foldersMessage],
    ["?q=app&fuzzyWithDirectories=1", foldersMessage],
    ["?q=app&fuzzyWithDirectories=", foldersMessage],
    ["?q=app&match=fuzzy&fuzzyWithDirectories=yes", foldersMessage],
  ];
  for (const [query, body] of invalid) {
    assert.deepEqual(await search(query), { status: 400, body }, query || "(no query)");
  }
  // The session-scope check runs before the route: an unknown session is a 404 whatever its options.
  assert.deepEqual(await search("?q=app&match=substring", "no-such-session"), { status: 404, body: { error: "session not found" } });
  assert.deepEqual(live.forwarded(), [], "a refused search is never forwarded");

  // Forwarding: the runner request carries an option only when given; the reply echoes it only when
  // the runner applied it.
  const results = [{ path: "src/app.ts", isDirectory: false }];
  live.answer((request) => ({
    ok: true, results,
    ...(request.match ? { match: request.match } : {}),
    ...(request.fuzzyWithDirectories ? { match: "fuzzy", fuzzyWithDirectories: true } : {}),
  }));
  const boundary = "a".repeat(256);
  assert.deepEqual(await search(`?q=${boundary}`), { status: 200, body: { results, truncated: false } });
  assert.deepEqual(await search("?q=src%2Fapp"), { status: 200, body: { results, truncated: false } });
  assert.deepEqual(await search("?q=sapp&match=fuzzy"),
    { status: 200, body: { results, truncated: false, match: "fuzzy" } });
  assert.deepEqual(await search("?q=sapp&fuzzyWithDirectories=true"),
    { status: 200, body: { results, truncated: false, match: "fuzzy", fuzzyWithDirectories: true } });
  assert.deepEqual(await search("?q=sapp&match=fuzzy&fuzzyWithDirectories=true"),
    { status: 200, body: { results, truncated: false, match: "fuzzy", fuzzyWithDirectories: true } });
  assert.deepEqual(live.forwarded(), [
    { type: "search_workspace_references", sessionId: "s", query: boundary },
    { type: "search_workspace_references", sessionId: "s", query: "src/app" },
    { type: "search_workspace_references", sessionId: "s", query: "sapp", match: "fuzzy" },
    { type: "search_workspace_references", sessionId: "s", query: "sapp", fuzzyWithDirectories: true },
    { type: "search_workspace_references", sessionId: "s", query: "sapp", match: "fuzzy", fuzzyWithDirectories: true },
  ]);

  // An older runner answers without the echo: a plain substring answer, with its truncation and limit.
  live.answer(() => ({ ok: true, results, truncated: true, limit: "entries" }));
  assert.deepEqual(await search("?q=sapp&match=fuzzy"),
    { status: 200, body: { results, truncated: true, limit: "entries" } });
  assert.deepEqual(await search("?q=sapp&fuzzyWithDirectories=true"),
    { status: 200, body: { results, truncated: true, limit: "entries" } });
  live.answer(() => ({ ok: true, results, truncated: "yes", match: "fuzzy", limit: "files" }));
  assert.deepEqual(await search("?q=sapp&match=fuzzy"),
    { status: 200, body: { results, truncated: false, match: "fuzzy" } });

  // Failure statuses.
  assert.deepEqual(await search("?q=app", "no-such-session"), { status: 404, body: { error: "session not found" } });
  live.answer(() => ({ ok: false, error: "workspace root is unavailable" }));
  assert.deepEqual(await search("?q=app&match=fuzzy"), { status: 502, body: { error: "workspace root is unavailable" } });
  live.answer(() => ({ ok: false }));
  assert.deepEqual(await search("?q=app"), { status: 502, body: { error: "could not search workspace paths" } });

  const old = await connectRunner(url, "old", OLD_RUNNER_TOKEN, RUNNER_CAPABILITY_MIN_PROTOCOL.workspaceReferences - 1, () => logs);
  sockets.push(old.socket);
  const unsupported = await search("?q=app&fuzzyWithDirectories=true", "old-s");
  assert.equal(unsupported.status, 409);
  assert.match(String(unsupported.body.error), /workspace references/u);
  assert.equal(unsupported.body.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.workspaceReferences);
  assert.deepEqual(old.forwarded(), [], "an unsupported runner is never asked");

  // A runner that drops the connection mid-search fails the in-flight request: 504. The 20 second
  // runner deadline maps to the same status (sessions.test.ts covers it without the wait).
  const before = live.searches.length;
  live.answer(() => "hold");
  const pending = search("?q=app&match=fuzzy");
  for (let i = 0; i < 200 && live.searches.length === before; i++) await delay(10);
  assert.equal(live.searches.length, before + 1, "the held search reached the runner");
  live.socket.close();
  const dropped = await pending;
  assert.equal(dropped.status, 504);
  assert.match(String(dropped.body.error), /runner disconnected before the request completed/u);

  let offline = await search("?q=app");
  for (let i = 0; i < 100 && offline.status !== 409; i++) { await delay(20); offline = await search("?q=app"); }
  assert.deepEqual(offline, { status: 409, body: { error: "runner is offline" } });
});
