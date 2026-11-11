import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { dispatch, type McpDeps } from "./session-management-mcp.js";
import { classifyPiControlCatalog, piControlRoleInventory, piControlRouteKind, piInertActivationGaps, type PiControlCatalogTool } from "./pi-inert-control-routes.js";

test("every actual role-filtered Agent Control tool is classified, without claiming remote containment", async () => {
  const ordinary = await piControlRoleInventory("ordinary"), orchestrator = await piControlRoleInventory("orchestrator"), evidence = await piControlRoleInventory("evidence");
  assert.equal(ordinary.routes.length, 63); assert.equal(orchestrator.routes.length, 68); assert.equal(evidence.routes.length, 2);
  assert.equal(new Set([...ordinary.routes, ...orchestrator.routes, ...evidence.routes].map(route => route.name)).size, 95);
  for (const inventory of [ordinary, orchestrator, evidence]) {
    assert.deepEqual(inventory.routes.filter(route => route.kind === "unknown"), [], "new tools require a route audit");
    assert.ok(inventory.routes.filter(route => route.kind === "remote-control-plane").every(route => route.transitiveEffects === "unproven"));
    assert.ok(piInertActivationGaps(inventory).includes("remote-control-plane-effects"));
    assert.ok(piInertActivationGaps(inventory).includes("immutable-loaded-import-closure"));
  }
  assert.equal(ordinary.routes.find(route => route.name === "wait_pull_request")?.kind, "local-subprocess");
  assert.equal(ordinary.routes.find(route => route.name === "attach_session_artifact")?.kind, "local-file-read");
  assert.equal(orchestrator.routes.some(route => route.name === "attach_session_artifact"), false);
});

test("catalog order does not change its frozen identity; unknown additions and schema changes cannot inherit it", async () => {
  const deps: McpDeps = { cpUrl: "http://inert.invalid", selfSessionId: "synthetic", token: "synthetic", fetch: async () => { throw Error("NO_NETWORK"); } };
  const reply = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps);
  const tools = reply.result.tools as PiControlCatalogTool[];
  const expected = classifyPiControlCatalog(tools);
  fc.assert(fc.property(fc.shuffledSubarray(tools, { minLength: tools.length, maxLength: tools.length }), shuffled => {
    assert.deepEqual(classifyPiControlCatalog(shuffled), expected);
  }));
  const changed = structuredClone(tools); changed[0]!.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
  assert.notDeepEqual(classifyPiControlCatalog(changed), expected);
  assert.throws(() => classifyPiControlCatalog([...tools, tools[0]!]), /refused/u);
  assert.equal(piControlRouteKind("unknown_future_exec"), "unknown");
  const extra = classifyPiControlCatalog([{ name: "unknown_future_exec", description: "inert", inputSchema: {} }]);
  assert.ok(piInertActivationGaps({ role: "ordinary", routes: extra, catalogSha256: "inert" }).includes("unknown-tool-route"));
});

test("the actual wait tool reaches its two local command backends; remote mutation remains an API delegation", async () => {
  const effects: string[] = [];
  const deps: McpDeps = { cpUrl: "http://inert.invalid", selfSessionId: "synthetic", token: "synthetic", controlPlaneProtocolVersion: PROTOCOL_VERSION,
    fetch: async (url, init) => {
      effects.push(`HTTP:${init?.method}:${new URL(url).pathname}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ worktree: { id: "inert", path: "/inert", branch: "inert" } }) };
    },
    gh: async () => { effects.push("gh"); return { stdout: "", stderr: "authentication required", code: 4, timedOut: false }; },
    glab: async () => { effects.push("glab"); return { stdout: "", stderr: "authentication required", code: 4, timedOut: false }; },
  };
  const call = (name: string, args: unknown) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, deps);
  await call("wait_pull_request", { pullRequest: "https://github.com/inert/repo/pull/7" });
  assert.ok(effects.includes("gh")); assert.ok(!effects.includes("glab")); assert.ok(!effects.some(effect => effect.startsWith("HTTP")));
  effects.length = 0;
  await call("wait_pull_request", { pullRequest: "https://gitlab.example.invalid/inert/repo/-/merge_requests/7" });
  assert.ok(effects.includes("glab")); assert.ok(!effects.includes("gh"));
  effects.length = 0;
  await call("create_worktree", { branch: "inert" });
  assert.deepEqual(effects, ["HTTP:POST:/api/sessions/synthetic/worktrees"]);
});

test("the artifact route reads only its explicit inert file and delegates upload to a stub, without local commands", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-inert-artifact-")));
  try {
    const file = join(root, "inert.png"), bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); writeFileSync(file, bytes);
    const calls: string[] = [];
    const result = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attach_session_artifact", arguments: { path: file } } }, {
      cpUrl: "http://inert.invalid", selfSessionId: "synthetic", token: "synthetic", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      fetch: async (url) => { calls.push(new URL(url).pathname); return { ok: true, status: 200, text: async () => JSON.stringify({ artifactId: "inert",
        sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length }) }; },
      gh: async () => { assert.fail("artifact spawned gh"); }, glab: async () => { assert.fail("artifact spawned glab"); },
    });
    assert.ok(!result.result.isError, JSON.stringify(result));
    assert.ok(calls.some(path => path.includes("artifact")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
