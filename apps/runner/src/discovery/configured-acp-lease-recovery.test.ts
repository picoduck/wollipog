import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { mergeAgents, probeConfiguredAcpAgents } from "./discover.js";

test("configured ACP rediscovery restores the same catalog identity after HOME admission clears", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-configured-acp-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialize = [
    'let input="";process.stdin.setEncoding("utf8");',
    'process.stdin.on("data",chunk=>{input+=chunk;const end=input.indexOf("\\n");if(end<0)return;',
    'const request=JSON.parse(input.slice(0,end));',
    'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{}}})+"\\n");});',
  ].join("");
  const configured: AgentDefinition = {
    id: "mock", name: "Mock", command: process.execPath, args: ["-e", initialize],
    driver: "acp", source: "config", context: { kind: "native" }, env: {},
  };
  let blocked = true;
  let admissions = 0;
  const discover = async () => mergeAgents([configured], [], await probeConfiguredAcpAgents([configured],
    () => ({ HOME: root, USERPROFILE: root, RUNNER_DATA_DIR: join(root, "data") }), {
      cwd: root,
      authorize: async () => {
        admissions++;
        if (blocked) throw new Error("fixture HOME admission refused");
        return { settle: async (proofs) => { await Promise.all(proofs); } };
      },
    }));

  let catalog = await discover();
  assert.equal(catalog.length, 1, "refusal retains the configured row rather than dropping it");
  assert.equal(catalog[0]!.id, "mock");
  assert.equal(catalog[0]!.available, false);
  assert.match(catalog[0]!.unavailableReason ?? "", /HOME ownership/u);
  blocked = false;
  assert.equal(catalog[0]!.available, false, "clearing ownership cannot mutate an already advertised catalog");
  catalog = await discover();
  assert.equal(admissions, 2, "rediscovery makes a new admission attempt");
  assert.equal(catalog[0]!.id, "mock", "rediscovery preserves the exact configured identity");
  assert.equal(catalog[0]!.available, true, catalog[0]!.unavailableReason ?? "a fresh probe restores configured availability");
  assert.equal(catalog[0]!.unavailableReason, undefined);
  assert.equal(configured.available, undefined, "the static baseline was never permanently disabled");
});
