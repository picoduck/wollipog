import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignLaunchPreflight, CreateSessionRequest, FullControlLaunchRequest, SessionView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { FullControlBlockedError, launchFullControlCampaign } from "./FullControlPreparation.js";

const ready = { ready: true, digest: "b".repeat(64), capabilities: [], summary: { blockers: [] } } as unknown as CampaignLaunchPreflight;
const request: CreateSessionRequest = { runnerId: "r", workspaceId: "w", projectId: "p", projectLocationId: "l", agentId: "claude",
  role: "orchestrator", useWorktree: true, executionTargetId: "host-worktree", launchSurface: "native_tui",
  acpSessionContext: { additionalDirectories: ["/elsewhere"] } };

function api(preflight: (input: FullControlLaunchRequest) => Promise<{ preflight: CampaignLaunchPreflight }>) {
  const sent = { preflights: [] as FullControlLaunchRequest[], admissions: [] as FullControlLaunchRequest[] };
  const client = {
    fullControlLaunchPreflight: async (input: FullControlLaunchRequest) => { sent.preflights.push(structuredClone(input)); return preflight(input); },
    createFullControlCampaign: async (input: FullControlLaunchRequest) => { sent.admissions.push(structuredClone(input)); return { id: "root" } as SessionView; },
  } as unknown as ApiClient;
  return { client, sent };
}

test("a Full Control launch forwards Run On and Harness to the server and never sends ACP session context (#2940)", async () => {
  const { client, sent } = api(async () => ({ preflight: ready }));
  await launchFullControlCampaign(client, request);
  for (const launch of [sent.preflights[0]!, sent.admissions[0]!]) {
    const session = launch.overrides!.session!;
    assert.equal(session.executionTargetId, "host-worktree");
    assert.equal(session.useWorktree, true);
    assert.equal(session.launchSurface, "native_tui", "the server refuses Native TUI in words; it is never silently Direct");
    assert.equal(Object.hasOwn(session, "acpSessionContext"), false);
  }
  const { client: plain, sent: plainSent } = api(async () => ({ preflight: ready }));
  await launchFullControlCampaign(plain, { runnerId: "r", workspaceId: "w", agentId: "claude" });
  const session = plainSent.preflights[0]!.overrides!.session!;
  assert.equal(Object.hasOwn(session, "executionTargetId"), false, "no choice sends no target, so the host default stays");
  assert.equal(Object.hasOwn(session, "launchSurface"), false);
});

test("the server's placement refusal is the inline sentence, and nothing is admitted (#2940)", async () => {
  const reason = "Full Control needs the Direct harness, because Native TUI doesn't track usage or show approval cards. Choose Direct under Harness.";
  const { client, sent } = api(async () => { throw new ApiError(`Full Control launch is blocked: ${reason}`, 409); });
  await assert.rejects(launchFullControlCampaign(client, request),
    (error: unknown) => error instanceof FullControlBlockedError && error.message === reason);
  assert.equal(sent.preflights.length, 1, "a refusal is not retried");
  assert.equal(sent.admissions.length, 0);
});
