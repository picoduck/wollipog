import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeMediaReviewerArgs, claudeMediaReviewerInitRefusal, claudeMediaReviewerPreInitNotice, ClaudeMediaReviewerStream, CLAUDE_MEDIA_REVIEWER_TOOLS,
  mediaReviewerCredentialPath, readMediaReviewerCredential } from "./claude-media-reviewer.js";

// Shape captured from the pinned 2.1.296 CLI started with --bare --tools "" --strict-mcp-config and
// only the relay server, with an invalid key (no model call): the provider's own startup proof.
const init = {
  type: "system", subtype: "init", session_id: "s1", cwd: "/review",
  tools: ["mcp__media__review_video_evidence_frame", "mcp__media__submit_video_evidence_verdict"],
  mcp_servers: [{ name: "media", status: "connected", source: "dynamic" }], model: "claude-opus-5-5",
  permissionMode: "dontAsk", slash_commands: [], apiKeySource: "ANTHROPIC_API_KEY", claude_code_version: "2.1.296",
  agents: ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"], skills: [],
  plugins: [{ name: "cc-plugin-agents-md", path: "builtin" }, { name: "cc-plugin-telemetry", path: "builtin" }],
};
const expected = { model: "claude-opus-5-5" };

test("startup proof accepts exactly the two scoped media tools and refuses every wider or different surface", () => {
  assert.equal(claudeMediaReviewerInitRefusal(init, expected), null);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a built-in tool", { tools: [...init.tools, "Read"] }],
    ["only one media tool", { tools: [init.tools[0]] }],
    ["a duplicated tool", { tools: [init.tools[0], init.tools[0]] }],
    ["a sibling MCP tool", { tools: [...init.tools, "mcp__fs__read_file"] }],
    ["a second MCP server", { mcp_servers: [...init.mcp_servers, { name: "fs", status: "connected" }] }],
    ["a failed relay", { mcp_servers: [{ name: "media", status: "failed" }] }],
    ["another version", { claude_code_version: "2.1.297" }],
    ["another model", { model: "claude-sonnet-5-5" }],
    ["another permission mode", { permissionMode: "bypassPermissions" }],
    ["the operator's own login", { apiKeySource: "none" }],
    ["a slash command", { slash_commands: ["review"] }],
    ["a skill", { skills: ["frontend-design"] }],
    ["a user plugin", { plugins: [{ name: "x", path: "/home/u/.claude/plugins/x" }] }],
    ["no session identity", { session_id: "" }],
  ];
  for (const [label, change] of cases) assert.ok(claudeMediaReviewerInitRefusal({ ...init, ...change }, expected), label);
  assert.ok(claudeMediaReviewerInitRefusal({ type: "assistant" }, expected));
});

test("the provider stream refuses non-media tool use and re-verifies every per-turn init", () => {
  const ok = new ClaudeMediaReviewerStream(expected);
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  assert.equal(ok.push(line(init)), null);
  assert.equal(ok.push(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: CLAUDE_MEDIA_REVIEWER_TOOLS[0] }] } })), null);
  assert.equal(ok.push(line({ type: "result", session_id: "s1", total_cost_usd: 0.5, is_error: false, result: "{}",
    modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } } })), null);
  assert.equal(ok.push(line(init)), null, "a second user turn re-announces the same session");
  assert.deepEqual({ ...ok.result }, { initialized: true, toolCalls: 1, priced: true, turns: 1, costUsd: 0.5, finalText: "{}" });

  for (const [label, events] of [
    ["built-in tool", [init, { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash" }] } }]],
    ["server tool", [init, { type: "assistant", message: { content: [{ type: "server_tool_use", id: "t", name: "web_search" }] } }]],
    ["session replaced", [init, { ...init, session_id: "s2" }]],
    ["widened later turn", [init, { ...init, tools: [...init.tools, "Read"] }]],
    ["cost regressed", [init, { type: "result", session_id: "s1", total_cost_usd: 1, modelUsage: {} }, { type: "result", session_id: "s1", total_cost_usd: 0.5, modelUsage: {} }]],
  ] as const) {
    const stream = new ClaudeMediaReviewerStream(expected);
    const refusal = (events as readonly unknown[]).map((event) => stream.push(line(event))).find(Boolean);
    assert.ok(refusal, label);
  }
  const unpriced = new ClaudeMediaReviewerStream(expected);
  unpriced.push(line(init));
  unpriced.push(line({ type: "result", session_id: "s1", total_cost_usd: 0.2, modelUsage: { "claude-haiku-5-5": { costUSD: 0.2 } } }));
  assert.equal(unpriced.result.priced, false, "usage attributed to another model is not this reviewer's priced usage");
  // A later fully priced turn cannot restore pricing lost earlier in the same process.
  unpriced.push(line(init));
  unpriced.push(line({ type: "result", session_id: "s1", total_cost_usd: 0.4, is_error: false,
    modelUsage: { "claude-opus-5-5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.4 } } }));
  assert.equal(unpriced.result.turns, 2);
  assert.equal(unpriced.result.priced, false, "pricing failure is latched for the whole window");
});

test("the pinned CLI's single pre-init UI notice is tolerated in exactly its measured shape, and nothing else is (#3849)", () => {
  // Measured on 2.1.296 and 2.1.314 under the reviewer's --bare argv: one notice, then init, same session.
  const sid = "cf08b4b2-74a9-40e6-807d-7520e14f81a7";
  const notice = { type: "system", subtype: "ui_invalidate", event: "ui.render", uuid: "e8818344-f227-44cb-9b01-35f117a6151f", session_id: sid };
  const started = { ...init, session_id: sid };
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  assert.equal(claudeMediaReviewerPreInitNotice(notice), sid);

  const ok = new ClaudeMediaReviewerStream(expected);
  assert.equal(ok.push(line(notice)), null);
  assert.equal(ok.result.initialized, false, "the notice proves nothing; init is still the startup proof");
  assert.equal(ok.push(line(started)), null);
  assert.equal(ok.push(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: CLAUDE_MEDIA_REVIEWER_TOOLS[0] }] } })), null);
  assert.equal(ok.push(line({ type: "result", session_id: sid, total_cost_usd: 0.5, is_error: false, result: "{}",
    modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } } })), null);
  assert.deepEqual({ ...ok.result }, { initialized: true, toolCalls: 1, priced: true, turns: 1, costUsd: 0.5, finalText: "{}" });
  // Releases that emit no notice (2.1.277 and below) still start directly with init.
  assert.equal(new ClaudeMediaReviewerStream(expected).push(line(started)), null);

  for (const [label, events] of [
    ["a second notice", [notice, notice, started]],
    ["a notice for another session", [notice, init]],
    ["a notice with content", [{ ...notice, message: { content: [{ type: "text", text: "x" }] } }, started]],
    ["a notice with tools", [{ ...notice, tools: ["Bash"] }, started]],
    ["a notice missing its uuid", [{ type: "system", subtype: "ui_invalidate", event: "ui.render", session_id: sid }, started]],
    ["another UI event", [{ ...notice, event: "ui.prompt" }, started]],
    ["another system subtype", [{ ...notice, subtype: "status" }, started]],
    ["an unbounded identifier", [{ ...notice, session_id: "x".repeat(4096) }, { ...init, session_id: "x".repeat(4096) }]],
    ["an assistant turn before init", [{ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: CLAUDE_MEDIA_REVIEWER_TOOLS[0] }] } }, started]],
    ["a result before init", [notice, { type: "result", session_id: sid, total_cost_usd: 0, modelUsage: {} }, started]],
    ["a widened init after the notice", [notice, { ...started, tools: [...init.tools, "Read"] }]],
  ] as const) {
    const stream = new ClaudeMediaReviewerStream(expected);
    const refusal = (events as readonly unknown[]).map((event) => stream.push(line(event))).find(Boolean);
    assert.ok(refusal, label);
    assert.equal(stream.result.toolCalls, 0, label);
  }
  for (const value of [null, [], "ui_invalidate", { ...notice, type: "user" }]) assert.equal(claudeMediaReviewerPreInitNotice(value), null);
});

test("provider argv disables built-in tools and loads only the relay, with no credential", () => {
  const argv = claudeMediaReviewerArgs({ providerCommand: "/provider", mcpConfig: "/relay/mcp.json", model: "claude-opus-5-5",
    effort: "high", maxBudgetUsd: 2.5 });
  assert.deepEqual(argv.slice(0, 3), ["/provider", "--bare", "-p"]);
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv[argv.indexOf("--mcp-config") + 1], "/relay/mcp.json");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(argv[argv.indexOf("--max-budget-usd") + 1], "2.500000");
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(argv.includes(flag));
  assert.ok(!argv.some((arg) => /sk-ant|ANTHROPIC/u.test(arg)));
  assert.throws(() => claudeMediaReviewerArgs({ providerCommand: "/provider", mcpConfig: "/relay/mcp.json", model: "x --tools default" }));
  assert.throws(() => claudeMediaReviewerArgs({ providerCommand: "/provider", mcpConfig: "/relay/mcp.json", model: "m", maxBudgetUsd: 0 }));
});

test("the dedicated reviewer key must be a private runner-owned regular file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "media-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = mediaReviewerCredentialPath(root, "claude");
  mkdirSync(join(root, "media-reviewer", "claude"), { recursive: true, mode: 0o700 });
  const key = "sk-ant-api03-" + "a".repeat(40);
  writeFileSync(path, key + "\n", { mode: 0o600 });
  assert.equal(readMediaReviewerCredential(path), key);
  chmodSync(path, 0o640);
  assert.throws(() => readMediaReviewerCredential(path), /private/u);
  chmodSync(path, 0o600);
  writeFileSync(path, "sk-ant-oat01-oauth-token-not-an-api-key", { mode: 0o600 });
  assert.throws(() => readMediaReviewerCredential(path), /malformed/u);
  const link = join(root, "link");
  symlinkSync(path, link);
  assert.throws(() => readMediaReviewerCredential(link), /private/u);
  assert.throws(() => mediaReviewerCredentialPath(root, "../other"), /safe path/u);
});
