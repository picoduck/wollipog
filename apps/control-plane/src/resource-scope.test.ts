import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceScope } from "@wollipog/protocol";
import { scopeAudienceContained } from "./resource-scope.js";

const organization = (id = "org"): ResourceScope => ({
  organizationId: id,
  owner: { kind: "organization", organizationId: id },
});
const user = (id: string, organizationId = "org"): ResourceScope => ({
  organizationId,
  owner: { kind: "user", userId: id },
});
const team = (id: string, organizationId = "org"): ResourceScope => ({
  organizationId,
  owner: { kind: "team", teamId: id },
});

test("scope audience containment is conservative and organization-bounded", () => {
  const cases: Array<[string, ResourceScope, ResourceScope, boolean]> = [
    ["organization to same organization", organization(), organization(), true],
    ["user to organization", user("one"), organization(), true],
    ["team to organization", team("one"), organization(), true],
    ["user to same user", user("one"), user("one"), true],
    ["user to different user", user("one"), user("two"), false],
    ["team to same team", team("one"), team("one"), true],
    ["team to different team", team("one"), team("two"), false],
    ["user to team", user("one"), team("one"), false],
    ["team to user", team("one"), user("one"), false],
    ["different organization", user("one", "other"), organization(), false],
  ];
  for (const [name, narrower, wider, expected] of cases) {
    assert.equal(scopeAudienceContained(narrower, wider), expected, name);
  }
});
