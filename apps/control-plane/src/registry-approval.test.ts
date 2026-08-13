import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { validateRegistryApproval } from "./registry-approval.js";

function agent(status: NonNullable<AgentDefinition["registry"]>["installStatus"]): AgentDefinition {
  return {
    id: "gemini",
    name: "Gemini CLI",
    command: "npx",
    args: ["--yes", "@google/gemini-cli@0.50.0", "--acp"],
    env: {},
    driver: "acp",
    available: status === "approved",
    registry: {
      id: "gemini",
      schemaVersion: "1.0.0",
      adapterVersion: "0.50.0",
      description: "Gemini",
      transport: "stdio",
      distribution: "npx",
      installPreview: "npx --yes @google/gemini-cli@0.50.0 --acp",
      installStatus: status,
      authentication: "required-live-verification",
    },
  };
}

const body = { action: "approve", schemaVersion: "1.0.0", adapterVersion: "0.50.0", confirmation: "explicit" } as const;

test("Registry approval requires explicit confirmation bound to the current metadata", () => {
  assert.deepEqual(validateRegistryApproval([agent("approval-required")], "gemini", body), {
    ok: true,
    action: "approve",
    schemaVersion: "1.0.0",
    adapterVersion: "0.50.0",
  });
  assert.equal(validateRegistryApproval([agent("approval-required")], "gemini", { ...body, confirmation: false }).status, 400);
  assert.match(validateRegistryApproval([agent("approval-required")], "gemini", { ...body, adapterVersion: "0.51.0" }).error, /changed/);
});

test("manual-only entries cannot be approved and only approved entries can be revoked", () => {
  assert.match(validateRegistryApproval([agent("manual-only")], "gemini", body).error, /cannot be automatically approved/);
  assert.match(validateRegistryApproval([agent("approval-required")], "gemini", { ...body, action: "revoke" }).error, /not currently approved/);
  assert.equal(validateRegistryApproval([agent("approved")], "gemini", { ...body, action: "revoke" }).ok, true);
});
