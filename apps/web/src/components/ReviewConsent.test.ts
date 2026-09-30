import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEPLOY_TO_TRACKING_MACHINES_CONSENT,
  deployToAssignmentsConsent,
  switchAgentsConsent,
} from "./ReviewConsent.js";

test("each review consent names what accepting deploys (#1948)", () => {
  assert.equal(deployToAssignmentsConsent(2), "Deploy to 2 existing assignments");
  assert.equal(deployToAssignmentsConsent(1), "Deploy to 1 existing assignment");
  assert.equal(DEPLOY_TO_TRACKING_MACHINES_CONSENT, "Deploy to machines that track the latest version");
  assert.equal(switchAgentsConsent(3, "the latest version"), "Switch 3 agents to the latest version");
  assert.equal(switchAgentsConsent(1, "version skillv_0123"), "Switch 1 agent to version skillv_0123");
  // A machine whose skills could not be read still names who is affected.
  assert.equal(switchAgentsConsent(null, "the latest version"), "Switch this machine's agents to the latest version");
});
