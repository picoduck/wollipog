import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { overlayAcpAuthStatus } from "./acp-auth-status.js";

const agents: AgentDefinition[] = [
  { id: "gemini", name: "Gemini", command: "gemini", args: ["--acp"], driver: "acp" },
  { id: "claude", name: "Claude", command: "claude", args: [], driver: "claude-code", authStatus: "authenticated" },
];
const capabilities = {
  logout: true,
  loadSession: true,
  sessionList: true,
  sessionDelete: false,
  sessionResume: true,
  sessionClose: true,
};

test("runtime ACP auth readiness survives discovery without rewriting native agents", () => {
  const got = overlayAcpAuthStatus(agents, new Map([
    ["gemini", { status: "unauthenticated" as const, capabilities }],
    ["claude", { status: "unauthenticated" as const, capabilities }],
  ]));
  assert.equal(got[0]?.authStatus, "unauthenticated");
  assert.deepEqual(got[0]?.acp, capabilities);
  assert.equal(got[1]?.authStatus, "authenticated");
  assert.equal(got[1], agents[1], "non-ACP definitions retain identity and native readiness");
});
