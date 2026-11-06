/** Campaign control metadata keeps its own authoritative order (#3363). */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignControl } from "@wollipog/protocol";
import { launchOrchestratorMeta, nextCampaignControl, validControlRevision } from "./campaign-control-order.js";

const fullControl = (revision: number): CampaignControl => ({ mode: "full_control", boundary: {
  version: 1, revision, issueScopeRevision: 1, repository: "example/project", objective: "Scoped work",
  authorizedByUserId: "owner", authorizedAt: 1000, operations: ["issue_closure"], delegatablePolicyIds: [] } });
const custom: CampaignControl = { mode: "custom" };

test("an ordered update never rolls back a newer control within one scope revision", () => {
  const held = { control: custom, controlRevision: 3 };
  assert.deepEqual(nextCampaignControl(held, { control: fullControl(2), controlRevision: 2 }),
    { control: custom, controlRevision: 3, outcome: "kept_newer" }, "a delayed Full Control never revives a revoke");
  assert.deepEqual(nextCampaignControl({ control: fullControl(3), controlRevision: 3 }, { control: fullControl(2), controlRevision: 2 }),
    { control: fullControl(3), controlRevision: 3, outcome: "kept_newer" }, "an older boundary never replaces a newer one");
  assert.deepEqual(nextCampaignControl(held, { control: fullControl(4), controlRevision: 4 }),
    { control: fullControl(4), controlRevision: 4, outcome: "applied" }, "a newer control applies");
  assert.deepEqual(nextCampaignControl(held, { control: custom, controlRevision: 3 }),
    { control: custom, controlRevision: 3, outcome: "applied" }, "the same revision is idempotent");
  assert.deepEqual(nextCampaignControl(undefined, { control: fullControl(2), controlRevision: 2 }),
    { control: fullControl(2), controlRevision: 2, outcome: "applied" }, "the first ordered control applies");
});

test("an update without control leaves the held control and its order", () => {
  assert.deepEqual(nextCampaignControl({ control: fullControl(2), controlRevision: 2 }, {}),
    { control: fullControl(2), controlRevision: 2, outcome: "unchanged" });
  assert.deepEqual(nextCampaignControl(undefined, {}), { outcome: "unchanged" });
});

test("an unordered peer keeps today's behavior until ordered control is held, then may only narrow it", () => {
  assert.deepEqual(nextCampaignControl({ control: custom }, { control: fullControl(2) }),
    { control: fullControl(2), outcome: "applied" }, "an older control plane replaces unordered control as before");
  assert.deepEqual(nextCampaignControl({ control: custom, controlRevision: 3 }, { control: fullControl(2) }),
    { control: custom, controlRevision: 3, outcome: "kept_newer" }, "a stale unordered Full Control never becomes a grant");
  assert.deepEqual(nextCampaignControl({ control: fullControl(3), controlRevision: 3 }, { control: custom }),
    { control: custom, controlRevision: 3, outcome: "applied" }, "an unordered revoke narrows, keeping the order");
});

test("a control revision is a non-negative safe integer when present", () => {
  for (const value of [undefined, 0, 1, 299]) assert.equal(validControlRevision(value), true, String(value));
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null, Number.NaN]) assert.equal(validControlRevision(value), false, String(value));
});

test("a relaunch never replaces a newer held control and keeps the saved copy of a newer scope", () => {
  const scope = (revision: number) => ({ repository: "example/project", issueNumbers: [1], revision, authorizedByUserId: "owner", authorizedAt: 1 });
  const saved = { strictProjectIsolation: true, issueScope: scope(1), control: custom, controlRevision: 5 };
  assert.deepEqual(launchOrchestratorMeta(saved, { strictProjectIsolation: true, issueScope: scope(1), control: fullControl(4), controlRevision: 4 }),
    { strictProjectIsolation: true, issueScope: scope(1), control: custom, controlRevision: 5 }, "a stale relaunch control is ignored");
  assert.deepEqual(launchOrchestratorMeta(saved, { strictProjectIsolation: false, issueScope: scope(1), control: fullControl(6), controlRevision: 6 }),
    { strictProjectIsolation: false, issueScope: scope(1), control: fullControl(6), controlRevision: 6 }, "a current relaunch applies");
  assert.equal(launchOrchestratorMeta({ ...saved, issueScope: scope(2) }, { strictProjectIsolation: false, issueScope: scope(1), control: fullControl(6), controlRevision: 6 })!
    .issueScope!.revision, 2, "a saved newer scope stays, as before");
  assert.deepEqual(launchOrchestratorMeta(saved, { strictProjectIsolation: false, issueScope: scope(1) }),
    { strictProjectIsolation: false, issueScope: scope(1) }, "a relaunch without control keeps today's behavior");
  assert.equal(launchOrchestratorMeta(saved, undefined), saved);
});
