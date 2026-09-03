import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carriesTokenParam,
  extractBearer,
  hashToken,
  isAuthenticatedAgentControlClaim,
  isAuthenticatedConductorClaim,
  isAuthenticatedPolicyHookClaim,
  isAgentControlApiRouteAllowed,
  isConductorApiRouteAllowed,
  isPolicyHookApiRouteAllowed,
  isTrustedLoopback,
  newDeviceToken,
  redactTokenInUrl,
  requiresDeviceAuth,
  shouldTouchDevice,
  tokenMatchesHash,
} from "./auth.js";

test("policy hook claims bind one active Claude session to one exact POST route", () => {
  const base = {
    credentialValid: true,
    claimedSessionId: "s_claude",
    session: { id: "s_claude", driver: "claude-code", status: "running" },
  };
  assert.equal(isAuthenticatedPolicyHookClaim(base), true);
  assert.equal(isAuthenticatedPolicyHookClaim({ ...base, credentialValid: false }), false);
  assert.equal(isAuthenticatedPolicyHookClaim({ ...base, claimedSessionId: "other" }), false);
  assert.equal(isAuthenticatedPolicyHookClaim({ ...base, session: { ...base.session, driver: "codex" } }), false);
  assert.equal(isAuthenticatedPolicyHookClaim({ ...base, session: { ...base.session, status: "idle" } }), true);
  assert.equal(isAuthenticatedPolicyHookClaim({ ...base, session: { ...base.session, status: "stopped" } }), false);
  assert.equal(isPolicyHookApiRouteAllowed("POST", "/api/sessions/:id/policy-hook"), true);
  assert.equal(isPolicyHookApiRouteAllowed("GET", "/api/sessions/:id/policy-hook"), false);
  assert.equal(isPolicyHookApiRouteAllowed("POST", "/api/sessions/:id/approve"), false);
});

test("conductor REST claims require an active exact-runner credential and an exact live conductor session", () => {
  const base = {
    credentialValid: true,
    claimedSessionId: "s_conductor",
    session: { id: "s_conductor", agentId: "conductor", status: "running" },
  };
  assert.equal(isAuthenticatedConductorClaim(base), true);
  assert.equal(isAuthenticatedConductorClaim({ ...base, credentialValid: false }), false);
  assert.equal(isAuthenticatedConductorClaim({ ...base, claimedSessionId: "s_other" }), false);
  assert.equal(isAuthenticatedConductorClaim({ ...base, session: { ...base.session, agentId: "claude" } }), false);
  for (const status of ["idle", "completed", "failed", "stopped"]) {
    assert.equal(isAuthenticatedConductorClaim({ ...base, session: { ...base.session, status } }), false, status);
  }
});

test("general agent-control claims require an exact active session and purpose-bound credential", () => {
  const base = {
    credentialValid: true,
    claimedSessionId: "s_codex",
    session: { id: "s_codex", status: "running" },
  };
  assert.equal(isAuthenticatedAgentControlClaim(base), true);
  assert.equal(isAuthenticatedAgentControlClaim({ ...base, credentialValid: false }), false);
  assert.equal(isAuthenticatedAgentControlClaim({ ...base, claimedSessionId: "s_other" }), false);
  for (const status of ["idle", "completed", "failed", "stopped"]) {
    assert.equal(isAuthenticatedAgentControlClaim({ ...base, session: { ...base.session, status } }), false, status);
  }
});

test("conductor REST access is method- and route-scoped to its published MCP tools", () => {
  for (const [method, route] of [
    ["GET", "/api/compatibility"],
    ["GET", "/api/runners"],
    ["GET", "/api/sessions"],
    ["GET", "/api/sessions/:id/events"],
    ["POST", "/api/sessions"],
    ["POST", "/api/sessions/:id/prompt"],
    ["POST", "/api/sessions/:id/worktrees"],
    ["POST", "/api/sessions/:id/worktrees/attach"],
    ["POST", "/api/sessions/:id/worktrees/select"],
    ["POST", "/api/sessions/:id/worktrees/discard"],
    ["POST", "/api/runs"],
    ["GET", "/api/governance/policies"],
    ["PUT", "/api/governance/policies/:policyId"],
    ["POST", "/api/workflows/:workflowId/versions"],
    ["POST", "/api/workflow-instances/:instanceId/nodes/:nodeId/dispatch"],
    ["POST", "/api/artifacts/screenshots"],
  ] as const) {
    assert.equal(isConductorApiRouteAllowed(method, route), true, `${method} ${route}`);
  }

  for (const [method, route] of [
    ["DELETE", "/api/sessions/:id"],
    ["POST", "/api/sessions/:id/approve"],
    ["POST", "/api/sessions/:id/git"],
    ["GET", "/api/devices"],
    ["POST", "/api/devices"],
    ["DELETE", "/api/runners/:id"],
    ["GET", "/api/governance/approval-queue"],
    ["POST", "/api/automations"],
    ["GET", "/api/sessions/:id/export"],
    ["GET", "/api/artifacts/:artifactId/export"],
    ["GET", "/api/new-future-surface"],
  ] as const) {
    assert.equal(isConductorApiRouteAllowed(method, route), false, `${method} ${route}`);
  }
});

test("general CLI/MCP access shares the closed manager route allowlist", () => {
  assert.equal(isAgentControlApiRouteAllowed("GET", "/api/compatibility"), true);
  assert.equal(isAgentControlApiRouteAllowed("GET", "/api/sessions"), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/prompt"), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/worktrees"), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/worktrees/attach"), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/worktrees/select"), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/worktrees/discard"), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/approve"), false);
  assert.equal(isAgentControlApiRouteAllowed("GET", "/api/devices"), false);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/new-future-surface"), false);
});

test("requiresDeviceAuth: every client needs a token for /api/* and /ui only", () => {
  // Fed the CANONICAL matched-route path (req.routeOptions.url), so it is a clean pattern —
  // percent-encoded raw URLs are decoded by the router before this ever sees them.
  assert.equal(requiresDeviceAuth("/api/sessions"), true);
  assert.equal(requiresDeviceAuth("/api/boxes/:id/update-runner"), true);
  assert.equal(requiresDeviceAuth("/api"), true); // bare /api collection route
  assert.equal(requiresDeviceAuth("/ui"), true);
  // Exempt: the runner channel (own token), health probe, and the static app shell.
  assert.equal(requiresDeviceAuth("/runner"), false);
  assert.equal(requiresDeviceAuth("/healthz"), false);
  assert.equal(requiresDeviceAuth("/"), false);
  assert.equal(requiresDeviceAuth("/assets/index-abc.js"), false);
  // A non-/api route named to look like one doesn't match the prefix.
  assert.equal(requiresDeviceAuth("/apix"), false);
});

test("isTrustedLoopback: any known proxy header downgrades a loopback peer to untrusted", () => {
  const lb = (ip: string | undefined | null) => ip === "127.0.0.1";
  assert.equal(isTrustedLoopback("127.0.0.1", {}, lb), true);
  assert.equal(isTrustedLoopback("10.0.0.5", {}, lb), false);
  // A reverse proxy forwarding to 127.0.0.1 spoofs the peer IP — any of these headers means proxy.
  for (const h of [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "forwarded",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "x-client-ip",
  ]) {
    assert.equal(isTrustedLoopback("127.0.0.1", { [h]: "x" }, lb), false, `${h} must downgrade`);
  }
});

test("redactTokenInUrl scrubs every token param (decode-aware, case-insensitive)", () => {
  assert.equal(redactTokenInUrl("/ui?token=secret"), "/ui?token=<redacted>");
  assert.equal(redactTokenInUrl("/ui?x=1&token=secret"), "/ui?x=1&token=<redacted>");
  // Duplicated params are both scrubbed.
  assert.equal(redactTokenInUrl("/ui?token=a&y=2&token=b"), "/ui?token=<redacted>&y=2&token=<redacted>");
  assert.equal(redactTokenInUrl("/ui?TOKEN=SEcret"), "/ui?TOKEN=<redacted>");
  // A percent-encoded KEY still decodes to `token` (URLSearchParams would accept it), so redact.
  assert.equal(redactTokenInUrl("/ui?to%6ben=secret"), "/ui?to%6ben=<redacted>");
  // A token value doesn't swallow following params or a fragment.
  assert.equal(redactTokenInUrl("/ui?token=abc&z=9"), "/ui?token=<redacted>&z=9");
  assert.equal(redactTokenInUrl("/ui?token=abc#frag"), "/ui?token=<redacted>#frag");
  assert.equal(redactTokenInUrl("/api/runners"), "/api/runners"); // nothing to redact
});

test("carriesTokenParam: detects the token key in every spelling /ui auth accepts", () => {
  assert.equal(carriesTokenParam("/ui?token=x"), true);
  assert.equal(carriesTokenParam("/board?x=1&token=x"), true);
  assert.equal(carriesTokenParam("/ui?to%6ben=x"), true); // decodes to token
  assert.equal(carriesTokenParam("/ui?TOKEN=x"), true);
  assert.equal(carriesTokenParam("/?token=x"), true);
  // Not a token param.
  assert.equal(carriesTokenParam("/board"), false);
  assert.equal(carriesTokenParam("/board?tokens=x"), false); // different key
  assert.equal(carriesTokenParam("/board?xtoken=x"), false);
  assert.equal(carriesTokenParam("/board?x=token"), false); // token in a VALUE is fine
});

test("extractBearer parses the Authorization header case-insensitively", () => {
  assert.equal(extractBearer("Bearer abc123"), "abc123");
  assert.equal(extractBearer("bearer  abc123 "), "abc123");
  assert.equal(extractBearer("Basic abc123"), null);
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer(""), null);
});

test("newDeviceToken: 256-bit, URL-safe, unique; hashToken is stable sha256 hex", () => {
  const a = newDeviceToken();
  const b = newDeviceToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  assert.equal(hashToken("t"), hashToken("t"));
  assert.notEqual(hashToken("t"), hashToken("u"));
  assert.match(hashToken("t"), /^[0-9a-f]{64}$/);
  assert.equal(tokenMatchesHash("t", hashToken("t")), true);
  assert.equal(tokenMatchesHash("u", hashToken("t")), false);
  assert.equal(tokenMatchesHash("t", "not-a-hash"), false);
});

test("shouldTouchDevice throttles last-seen writes to once a minute", () => {
  assert.equal(shouldTouchDevice(null, 1000), true);
  assert.equal(shouldTouchDevice(1000, 30_000), false);
  assert.equal(shouldTouchDevice(1000, 61_001), true);
});
