import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OwnerManagementInventory, type OwnerOperationCoverage } from "./owner-management-inventory.js";
import { ASSISTANT_CONNECTION_OPERATIONS } from "./assistant-connection-operations.js";
import { ASSISTANT_CAMPAIGN_MANAGEMENT, ASSISTANT_CAMPAIGN_HUMAN_ROUTES, ASSISTANT_RESIDUAL_MANAGEMENT, ASSISTANT_RESIDUAL_HUMAN_ROUTES, ASSISTANT_CAMPAIGN_ALIASES } from "./assistant-campaign-management.js";
import { CAMPAIGN_SESSION_PROTOCOL_ROUTES, RESIDUAL_SESSION_PROTOCOL_ROUTES } from "./campaign-session-protocol.js";

test("parity gate observes generated owner routes and fails unregistered or undocumented operations", async () => {
  const app = Fastify(), inventory = new OwnerManagementInventory();
  inventory.attach(app);
  for (const action of ["rotate", "revoke"]) app.post(`/api/assistant-connections/:id/${action}`, () => ({}));
  app.post("/api/sessions/:id/config", () => ({}));
  app.get("/api/projects", () => ({}));
  app.put("/api/runners/:id/capacity", () => ({}));
  app.post("/api/automations", () => ({}));
  app.post("/api/skills/:id/versions", () => ({}));
  app.get("/api/skill-groups", () => ({}));
  app.get("/health", () => ({}));
  try {
    const coverage: Record<string, OwnerOperationCoverage> = {};
    assert.equal(inventory.list().length, 8);
    assert.throws(() => inventory.assertComplete(coverage, new Set()), /POST \/api\/automations/);
    for (const route of inventory.list()) coverage[route] = {tools: ["fixture_tool"]};
    assert.throws(() => inventory.assertComplete(coverage, new Set()), /not registered/);
    inventory.assertComplete(coverage, new Set(["fixture_tool"]));
    coverage["POST /api/sessions/:id/config"] = {tools: []};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["fixture_tool"])), /actual registered tool/);
    coverage["POST /api/sessions/:id/config"] = {exclusion: "human_authority", reason: "", remedy: ""};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["fixture_tool"])), /reason and supported remedy/);
  } finally {await app.close();}
});

test("session-protocol classification cannot absorb an owner route or omit its registered read counterpart", async () => {
  const app = Fastify(), inventory = new OwnerManagementInventory();
  inventory.attach(app);
  app.post("/api/sessions/:id/waits", () => ({}));
  app.post("/api/sessions/:id/pull-request-watch", () => ({}));
  app.post("/api/sessions/:id/config", () => ({}));
  const protocol = {exclusion: "session_protocol" as const, reason: "Matching self-session credential is required; owner HTTP is refused.",
    remedy: "Read state using session_watch_get; the genuine session runtime performs these writes.", ownerTools: ["session_watch_get"]};
  const coverage: Record<string, OwnerOperationCoverage> = {
    "POST /api/sessions/:id/waits": protocol,
    "POST /api/sessions/:id/pull-request-watch": protocol,
    "POST /api/sessions/:id/config": {tools: ["session_config"]},
  };
  const registered = new Set(["session_watch_get", "session_config"]);
  try {
    inventory.assertComplete(coverage, registered);
    coverage["POST /api/sessions/:id/config"] = protocol;
    assert.throws(() => inventory.assertComplete(coverage, registered), /explicitly adjudicated session-credential/);
    coverage["POST /api/sessions/:id/config"] = {tools: ["session_config"]};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["session_config"])), /read counterpart session_watch_get is not registered/);
    coverage["POST /api/sessions/:id/waits"] = {...protocol, ownerTools: []};
    assert.throws(() => inventory.assertComplete(coverage, registered), /registered owner-facing read counterpart/);
    coverage["POST /api/sessions/:id/waits"] = {...protocol, ownerTools: ["session_config"]};
    assert.throws(() => inventory.assertComplete(coverage, registered), /exact registered owner-facing read counterpart session_watch_get/);
  } finally {await app.close();}
});

test("production composition inventory is exhaustive; unresolved gaps cannot count as exclusions", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url))],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production composition failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_PARITY_SNAPSHOT "));
  assert.ok(line, "Production composition did not return its route/registry inventory.");
  const snapshot = JSON.parse(line.slice("OWNER_PARITY_SNAPSHOT ".length)) as {routes: string[]; tools: string[]};
  // The Discord composition must retain the authenticated-origin session seam and both
  // management registration families. A conflict resolution must not silently drop one.
  for (const tool of ["session_launch", "command_get", "assistant_work_track", "assistant_work_read",
    "assistant_work_reconcile", "auto_list", "skill_pin_get", "session_config", "location_add",
    "session_work_get", "queue_get", "queue_edit", "queue_cancel", "session_steer", "session_invoke",
    "session_project", "session_workspace", "session_column", "session_retitle", "session_rewind", "session_fork",
    "session_reprocess", "session_delete", "session_adopt", "session_role_get", "session_role",
    "session_watch_get", "side_chat_get", "side_chat_create",
    "prompt_history", "history_preview", "attachment_history", "session_export", "session_artifacts",
    "transcript_shares", "reminder_get", "reminder_set", "reminder_remove", "shell_list", "shell_open", "shell_close"]) {
    assert.ok(snapshot.tools.includes(tool), `${tool}: production composition lost a registration family`);
  }
  for (const tool of ["session_watch", "session_wait_report", "campaign_get", "campaign_work_items", "campaign_work_item", "campaign_review_jobs", "campaign_review_job", "campaign_review_report"]) {
    assert.ok(!snapshot.tools.includes(tool), `${tool}: an owner connection must not impersonate session-runtime protocol writes`);
  }
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8")) as
    Record<string, OwnerOperationCoverage | {gap: string}>;
  for (const [tool, route] of ASSISTANT_CONNECTION_OPERATIONS) {
    assert.ok(snapshot.tools.includes(tool), `${tool}: production lost a group-5 connection operation`);
    const tools = tool === "install_name" ? ["installation_rename", tool] : [tool];
    assert.deepEqual(manifest[route], {tools}, `${route}: group-5 audit drift`);
  }
  for (const [tool, route] of [...ASSISTANT_CAMPAIGN_MANAGEMENT, ...ASSISTANT_RESIDUAL_MANAGEMENT]) {
    assert.ok(snapshot.tools.includes(tool), `${tool}: production lost a group-7 operation`);
    const aliases = ASSISTANT_CAMPAIGN_ALIASES.filter(([, canonical]) => canonical === tool).map(([alias]) => alias);
    assert.deepEqual(manifest[route], {tools: [tool, ...aliases]}, `${route}: group-7 audit drift`);
  }
  const group7Routes = new Set<string>([...ASSISTANT_CAMPAIGN_MANAGEMENT.map(([, route]) => route), ...ASSISTANT_CAMPAIGN_HUMAN_ROUTES, ...CAMPAIGN_SESSION_PROTOCOL_ROUTES]);
  const group7 = Object.entries(manifest).filter(([route]) => group7Routes.has(route));
  assert.equal(group7.length, 59);
  assert.equal(group7.filter(([, entry]) => "tools" in entry).length, 18);
  assert.equal(group7.filter(([, entry]) => "exclusion" in entry && entry.exclusion === "human_authority").length, 10);
  assert.equal(group7.filter(([, entry]) => "exclusion" in entry && entry.exclusion === "session_protocol").length, 31);
  const residualRoutes = new Set<string>([...ASSISTANT_RESIDUAL_MANAGEMENT.map(([, route]) => route), ...ASSISTANT_RESIDUAL_HUMAN_ROUTES, ...RESIDUAL_SESSION_PROTOCOL_ROUTES]);
  const residual = Object.entries(manifest).filter(([route]) => residualRoutes.has(route));
  assert.equal(residual.length, 29);
  assert.equal(residual.filter(([, entry]) => "tools" in entry).length, 3);
  assert.equal(residual.filter(([, entry]) => "exclusion" in entry && entry.exclusion === "human_authority").length, 7);
  assert.equal(residual.filter(([, entry]) => "exclusion" in entry && entry.exclusion === "session_protocol").length, 19);
  assert.deepEqual(snapshot.routes, Object.keys(manifest).sort(), "An owner-route candidate was added/removed: classify it explicitly; never regenerate to hide a gap.");
  const inventory = new OwnerManagementInventory();
  const app = Fastify();
  inventory.attach(app);
  for (const route of snapshot.routes) {
    const space = route.indexOf(" ");
    app.route({method: route.slice(0, space) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: route.slice(space + 1), handler: () => ({})});
  }
  const coverage = Object.fromEntries(Object.entries(manifest).filter(([, entry]) => !("gap" in entry))) as Record<string, OwnerOperationCoverage>;
  const gaps = inventory.gaps(coverage, new Set(snapshot.tools));
  assert.deepEqual(gaps.filter(gap => /campaign|workflow-decision|review-session|review-finding|descendant-request/u.test(gap.route)), [],
    "Every group-7 owner capability or exclusion must satisfy the actual production audit guard");
  for (const [route, entry] of Object.entries(manifest)) {
    if ("gap" in entry) assert.ok(gaps.some(gap => gap.route === route), `${route}: an unresolved gap was silently counted as coverage`);
  }
  // This is the audit contract test, not a claim of full parity. The strict acceptance command
  // calls assertComplete against this same production inventory and must fail until gaps land.
  if (gaps.length) assert.throws(() => inventory.assertComplete(coverage, new Set(snapshot.tools)), /parity is incomplete/);
});

test("campaign protocol accepts only its exact no-owner-equivalent entries and rejects owner read routes", async () => {
  const app = Fastify(), inventory = new OwnerManagementInventory();
  inventory.attach(app);
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8"));
  const coverage: Record<string, OwnerOperationCoverage> = {};
  for (const route of [...CAMPAIGN_SESSION_PROTOCOL_ROUTES, ...RESIDUAL_SESSION_PROTOCOL_ROUTES]) {
    const [method, url] = route.split(" ") as ["GET" | "POST", string];
    app.route({method, url, handler: () => ({})});
    coverage[route] = manifest[route];
  }
  try {
    inventory.assertComplete(coverage, new Set());
    const route = CAMPAIGN_SESSION_PROTOCOL_ROUTES[0];
    coverage[route] = {...manifest[route], ownerTools: ["session_watch_get"]};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["session_watch_get"])), /must not claim an equivalent owner tool/);
    coverage[route] = manifest[route];
    app.get("/api/sessions/:id/review-sessions", () => ({}));
    coverage["GET /api/sessions/:id/review-sessions"] = manifest[route];
    assert.throws(() => inventory.assertComplete(coverage, new Set()), /explicitly adjudicated session-credential/);
  } finally {await app.close();}
});

test("every campaign protocol classification is explicitly allowlisted and proved owner-403 in production HTTP", {timeout: 30_000}, () => {
  assert.equal(CAMPAIGN_SESSION_PROTOCOL_ROUTES.length, 31, "Only the 31 adjudicated group-7 routes are admitted");
  assert.equal(new Set(CAMPAIGN_SESSION_PROTOCOL_ROUTES).size, 31);
  assert.equal(RESIDUAL_SESSION_PROTOCOL_ROUTES.length, 19);
  const protocolRoutes = [...CAMPAIGN_SESSION_PROTOCOL_ROUTES, ...RESIDUAL_SESSION_PROTOCOL_ROUTES];
  assert.equal(new Set(protocolRoutes).size, 50);
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url)), "--verify-campaign-protocol"],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production protocol authorization test failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_CAMPAIGN_PROTOCOL_FENCES "));
  assert.ok(line, "Missing production owner-403 evidence");
  const evidence = JSON.parse(line.slice("OWNER_CAMPAIGN_PROTOCOL_FENCES ".length));
  assert.equal(evidence.ownerRead, 200);
  assert.equal(evidence.effects, 0);
  assert.deepEqual(evidence.ownerDeniedRoutes.sort(), protocolRoutes.sort());
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8"));
  const admitted = new Set<string>(protocolRoutes);
  const verified = new Set<string>(evidence.ownerDeniedRoutes);
  for (const [route, entry] of Object.entries(manifest) as [string, {exclusion?: string; ownerTools?: string[]}][]) {
    if (entry.exclusion !== "session_protocol" || route === "POST /api/sessions/:id/waits" || route === "POST /api/sessions/:id/pull-request-watch") continue;
    assert.ok(admitted.has(route) && verified.has(route), `${route}: classification lacks exact production owner-403 proof`);
    assert.equal(entry.ownerTools, undefined, `${route}: do not claim an owner equivalent for session protocol`);
  }
  for (const route of admitted) assert.equal(manifest[route]?.exclusion, "session_protocol", `${route}: protocol audit drift`);
});

test("real owner HTTP and Assistant MCP cannot write runtime wait/watch state under another identity", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url)), "--verify-runtime-identity"],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production identity-fence verification failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_RUNTIME_IDENTITY_FENCES "));
  assert.ok(line, "Production HTTP/MCP did not return identity-fence evidence.");
  assert.deepEqual(JSON.parse(line.slice("OWNER_RUNTIME_IDENTITY_FENCES ".length)), {ownerReads: 1, ownerWritesDenied: 2, assistantWritesDenied: 2, effects: 0});
});

test("production owner HTTP, MCP and binary image ingress use the same residual services", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url)), "--verify-residual-management"],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production residual equivalence regression; raw fixture logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_RESIDUAL_EQUIVALENCE "));
  assert.ok(line, "Missing production residual service evidence");
  assert.deepEqual(JSON.parse(line.slice("OWNER_RESIDUAL_EQUIVALENCE ".length)), {ownerRead: 200, tools: 3,
    binaryUpload: "succeeded", opaqueReference: "succeeded", grantRefused: 403});
});
