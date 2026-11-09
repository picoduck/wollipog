import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignExcludedLocation, CampaignLaunchPreflight, CreateSessionRequest, FullControlLaunchRequest, SessionView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { FullControlBlockedError, launchFullControlCampaign, locationGatesWarning, type FullControlLocationWarning } from "./FullControlPreparation.js";

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

const OLD = "The Location's runner can't perform this campaign's gates. Update and restart it to protocol version 327 or newer.";
const excluded = (locationId: string, name: string, failure: CampaignExcludedLocation["failure"], reason: string): CampaignExcludedLocation => ({ locationId, name, failure, reason });

test("a start that leaves out a Location for its runner's version says so, naming the version, and admits nothing differently (#4319)", async () => {
  const warned = { summary: { blockers: [], excludedLocations: [excluded("a", "Old Mac", "runner_below_gates", OLD), excluded("b", "Notes", "not_repository", "not a repository")] } };
  const { client, sent } = api(async () => ({ preflight: { ...ready, ...warned } as unknown as CampaignLaunchPreflight }));
  const warnings: FullControlLocationWarning[] = [];
  await launchFullControlCampaign(client, request, (warning) => warnings.push(warning));
  assert.deepEqual(warnings, [{ message: "Old Mac isn't in this campaign yet.", detail: `${OLD} Campaign Status lists it until it can join.` }]);
  assert.equal(sent.admissions.length, 1, "a left-out Location never blocks a start");
});

test("no warning comes before the start succeeds, or twice when the server's facts moved (#4319)", async () => {
  const warned = { summary: { blockers: [], excludedLocations: [excluded("a", "Old Mac", "runner_below_gates", OLD)] } };
  const { client, sent } = api(async () => ({ preflight: { ...ready, ...warned } as unknown as CampaignLaunchPreflight }));
  const warnings: FullControlLocationWarning[] = [];
  const create = client.createFullControlCampaign;
  let attempts = 0;
  client.createFullControlCampaign = async (input) => {
    attempts += 1;
    if (attempts === 1) throw new ApiError("launch preflight changed; refresh and review the exact proposal again", 409);
    return create(input);
  };
  await launchFullControlCampaign(client, request, (warning) => warnings.push(warning));
  assert.equal(warnings.length, 1);
  client.createFullControlCampaign = async () => { throw new ApiError("Full Control launch is blocked: nothing started.", 409); };
  await assert.rejects(launchFullControlCampaign(client, request, (warning) => warnings.push(warning)));
  assert.equal(warnings.length, 1, "a refused start warns about nothing");
  assert.equal(sent.admissions.length, 1);
});

test("a campaign whose runners are all current gets no warning, even with other exclusions (#4319)", () => {
  assert.equal(locationGatesWarning([]), null);
  assert.equal(locationGatesWarning([excluded("b", "Notes", "not_repository", "not a repository"), excluded("c", "Away", "runner_offline", "offline")]), null);
  assert.deepEqual(locationGatesWarning([excluded("a", "Old Mac", "runner_below_gates", OLD), excluded("d", "Desk", "runner_below_gates", OLD)]), {
    message: "2 Locations aren't in this campaign yet.", detail: `Old Mac, Desk: ${OLD} Campaign Status lists them until they can join.` });
});

test("the server's placement refusal is the inline sentence, and nothing is admitted (#2940)", async () => {
  const reason = "Full Control needs the Direct harness, because Native TUI doesn't track usage or show approval cards. Choose Direct under Harness.";
  const { client, sent } = api(async () => { throw new ApiError(`Full Control launch is blocked: ${reason}`, 409); });
  await assert.rejects(launchFullControlCampaign(client, request),
    (error: unknown) => error instanceof FullControlBlockedError && error.message === reason);
  assert.equal(sent.preflights.length, 1, "a refusal is not retried");
  assert.equal(sent.admissions.length, 0);
});
