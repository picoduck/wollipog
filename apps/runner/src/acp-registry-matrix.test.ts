import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/acp/registry-priority-2026-07-12.json", import.meta.url), "utf8")) as {
  source: string;
  generatedAt: string;
  agents: Array<{
    id: string;
    version: string;
    initialize: string;
    protocolVersion: number;
    authMethods: string[];
    capabilities: string[];
  }>;
};

test("official ACP matrix snapshot keeps the three prioritized Registry adapters conformance-ranked", () => {
  assert.match(fixture.source, /^https:\/\/github\.com\/agentclientprotocol\/registry\//);
  assert.equal(fixture.generatedAt, "2026-07-12T07:37:30+00:00");
  assert.deepEqual(fixture.agents.map((agent) => agent.id), ["cursor", "gemini", "opencode"]);
  assert.ok(fixture.agents.every((agent) => agent.initialize === "success" && agent.protocolVersion === 1));
  assert.deepEqual(fixture.agents.find((agent) => agent.id === "cursor")?.capabilities, ["loadSession", "sessionList"]);
  assert.deepEqual(fixture.agents.find((agent) => agent.id === "gemini")?.authMethods, ["agent"]);
  assert.deepEqual(fixture.agents.find((agent) => agent.id === "opencode")?.capabilities, [
    "loadSession", "sessionList", "sessionFork", "sessionResume",
  ]);
});
