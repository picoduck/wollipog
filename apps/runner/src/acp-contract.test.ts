import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  ACP_SDK_VERSION,
  ACP_CLIENT_VERSION,
  acpInitializeRequest,
  negotiateAcpInitialize,
} from "./acp-contract.js";

test("ACP baseline is pinned to the SDK schema without inventing a new wire version", async () => {
  assert.equal(ACP_PROTOCOL_VERSION, 1);
  assert.equal(ACP_PROTOCOL_VERSION, PROTOCOL_VERSION);
  assert.equal(ACP_SDK_VERSION, "1.2.1");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.devDependencies["@agentclientprotocol/sdk"], ACP_SDK_VERSION);
  assert.equal(pkg.version, ACP_CLIENT_VERSION);
  assert.deepEqual(acpInitializeRequest(), {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "wollipog", version: "0.1.0" },
  });
  const caps = acpInitializeRequest().clientCapabilities as Record<string, unknown>;
  for (const preview of ["auth", "elicitation", "nes", "plan", "positionEncodings"]) {
    assert.equal(preview in caps, false, `${preview} must not be advertised as stable`);
  }
});

test("negotiation projects stable capabilities and retains bounded agent diagnostics", () => {
  const got = negotiateAcpInitialize({
    protocolVersion: 1,
    agentInfo: {
      name: "  gemini-cli\nagent  ",
      title: "Gemini ACP",
      version: "1.2.3",
      secretVendorMetadata: "must not survive",
    },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: {
        list: {},
        delete: {},
        additionalDirectories: {},
        resume: {},
        close: {},
      },
      auth: { logout: {} },
    },
  });

  assert.deepEqual(got.agentInfo, {
    name: "gemini-cli agent",
    title: "Gemini ACP",
    version: "1.2.3",
  });
  assert.deepEqual(got.authMethods, []);
  assert.deepEqual(got.stable, {
    loadSession: true,
    promptImage: true,
    promptAudio: true,
    promptEmbeddedContext: true,
    mcpHttp: true,
    mcpSse: true,
    sessionList: true,
    sessionDelete: true,
    sessionAdditionalDirectories: true,
    sessionResume: true,
    sessionClose: true,
    logout: true,
  });
  assert.deepEqual(got.schemaAuthority, {
    package: "@agentclientprotocol/sdk",
    version: "1.2.1",
  });
  assert.deepEqual(got.experimentalAdvertised, []);
  assert.equal("secretVendorMetadata" in (got.agentInfo as unknown as Record<string, unknown>), false);
});

test("authentication negotiation retains only bounded stable agent-managed methods", () => {
  const got = negotiateAcpInitialize({
    protocolVersion: 1,
    authMethods: [
      { id: " browser\n", name: " Browser sign-in\t", description: " Opens on agent host " },
      { id: "browser", name: "duplicate" },
      { id: "env", name: "Environment variable", type: "env_var" },
      { id: "terminal", name: "Terminal", type: "terminal" },
      { id: "agent", name: "Agent managed", type: "agent", secret: "discard" },
      { id: "", name: "invalid" },
    ],
  });
  assert.deepEqual(got.authMethods, [
    { id: "browser", name: "Browser sign-in", description: "Opens on agent host" },
    { id: "agent", name: "Agent managed", description: null },
  ]);
  assert.equal("secret" in (got.authMethods[1] as unknown as Record<string, unknown>), false);
});

test("preview capabilities are labeled for diagnostics but never promoted to stable", () => {
  const got = negotiateAcpInitialize({
    protocolVersion: 1,
    agentCapabilities: {
      mcpCapabilities: { acp: true },
      sessionCapabilities: { fork: {} },
      providers: {},
      nes: {},
    },
  });
  assert.deepEqual(got.experimentalAdvertised, ["mcp-acp", "session-fork", "providers", "nes"]);
  assert.equal(got.stable.sessionResume, false);
  assert.equal(got.stable.sessionClose, false);
  assert.equal(got.agentInfo, null);
});

test("unknown and malformed protocol versions fail closed", () => {
  assert.throws(() => negotiateAcpInitialize({}), /integer protocolVersion/);
  assert.throws(() => negotiateAcpInitialize({ protocolVersion: "1" }), /integer protocolVersion/);
  assert.throws(() => negotiateAcpInitialize({ protocolVersion: 2 }), /Unsupported ACP protocol version 2/);
});
