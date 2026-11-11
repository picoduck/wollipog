import assert from "node:assert/strict";
import {test} from "node:test";
import {currentDiscordUpdatePolicy, currentDiscordUpdateRoutePolicy} from "../integrations/openclaw-discord/policy.mjs";

const binding = {requesterId: "234", accountId: "fixture", destination: "channel:123", updates: {botTokenEnv: "BOT_FIXTURE"}};
const env = {BOT_FIXTURE: "synthetic-bot-fixture"};
const config = () => ({tools: {profile: "minimal"}, channels: {discord: {enabled: true, groupPolicy: "allowlist", dmPolicy: "allowlist",
  allowFrom: ["234"], accounts: {fixture: {enabled: true, token: {source: "env", id: "BOT_FIXTURE"}}},
  guilds: {"567": {users: ["234"], channels: {"123": {enabled: true}}}}}}});

test("delayed Discord updates require the current explicit requester/channel/account policy, never a wildcard or shared-channel inheritance", () => {
  assert.equal(currentDiscordUpdatePolicy(config(), binding, "567", undefined, env), true);
  assert.equal(currentDiscordUpdatePolicy(config(), {...binding, requesterId: "456"}, "567", undefined, env), false);
  assert.equal(currentDiscordUpdatePolicy(config(), {...binding, destination: "channel:456"}, "567", undefined, env), false);
  for (const change of [
    value => {value.channels.discord.enabled = false;},
    value => {value.channels.discord.accounts.fixture.token.id = "WRONG_FIXTURE";},
    value => {value.channels.discord.accounts.fixture.enabled = false;},
    value => {value.channels.discord.groupPolicy = "open";},
    value => {value.channels.discord.guilds["567"].users = ["*"];},
    value => {value.channels.discord.guilds["567"].channels["123"].enabled = false;},
    value => {value.channels.discord.guilds["567"].channels["123"].users = ["456"];},
    value => {value.tools.alsoAllow = ["exec"];},
    value => {value.mcp = {servers: {broad: {command: "fixture"}}};},
  ]) {const current = config(); change(current); assert.equal(currentDiscordUpdatePolicy(current, binding, "567", undefined, env), false);}
});

test("DM delayed updates require an explicit current allowlist; pairing or broad open policy cannot silently extend standing authority", () => {
  assert.equal(currentDiscordUpdatePolicy(config(), {...binding, destination: "user:234"}, null, undefined, env), true);
  const current = config();
  current.channels.discord.dmPolicy = "pairing";
  assert.equal(currentDiscordUpdatePolicy(current, binding, null, undefined, env), false);
  current.channels.discord.dmPolicy = "allowlist"; current.channels.discord.allowFrom = ["*"];
  assert.equal(currentDiscordUpdatePolicy(current, binding, null, undefined, env), false);
});

test("background delivery re-resolves the current OpenClaw agent, account and conversation instead of inheriting a stale route", () => {
  const bound = {...binding, agentId: "assistant-fixture", sessionKey: "agent:assistant-fixture:discord:channel:123"};
  const route = {agentId: bound.agentId, accountId: bound.accountId, sessionKey: bound.sessionKey};
  let resolved = route;
  const api = {runtime: {config: {current: config}, channel: {routing: {resolveAgentRoute(input) {
    assert.equal(input.peer.id, "123"); assert.deepEqual(input.memberRoleIds, ["789"]); return resolved;
  }}}}};
  assert.equal(currentDiscordUpdateRoutePolicy(api, bound, "567", undefined, ["789"], env), true);
  for (const replacement of [{agentId: "different-fixture"}, {accountId: "different-fixture"}, {sessionKey: "wrong-conversation-fixture"}]) {
    resolved = {...route, ...replacement};
    assert.equal(currentDiscordUpdateRoutePolicy(api, bound, "567", undefined, ["789"], env), false);
  }
});
