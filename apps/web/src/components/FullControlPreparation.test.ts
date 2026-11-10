import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignExcludedLocation, CampaignLaunchPreflight, CreateSessionRequest, FullControlLaunchRequest, SessionView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { FullControlBlockedError, FullControlLocationsToReview, fullControlLocationReport, launchFullControlCampaign, type FullControlLocationReport } from "./FullControlPreparation.js";

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
const withSummary = (summary: Partial<CampaignLaunchPreflight["summary"]>) => ({ ...ready, summary: { blockers: [], ...summary } }) as unknown as CampaignLaunchPreflight;

test("a start stops to show a Location left out for its runner's version before the campaign exists, and then proceeds with that report (#4319)", async () => {
  const old = excluded("a", "Old Mac", "runner_below_gates", OLD);
  const { client, sent } = api(async () => ({ preflight: withSummary({ excludedLocations: [old, excluded("b", "Notes", "not_repository", "not a repository")] }) }));
  let report: FullControlLocationReport | null = null;
  await assert.rejects(launchFullControlCampaign(client, request), (error: unknown) => {
    assert.ok(error instanceof FullControlLocationsToReview);
    report = error.report;
    return true;
  });
  assert.deepEqual(report, { excluded: [old], limited: [] }, "only the version's exclusion: another stays in Campaign Status, as it always has");
  assert.equal(sent.admissions.length, 0, "the person hasn't approved this boundary yet");
  await launchFullControlCampaign(client, request, report);
  assert.equal(sent.admissions.length, 1, "shown once, it never blocks the start");
});

test("a start stops again when the check finds something the person wasn't shown, and a limited launch Location counts (#4319)", async () => {
  const old = excluded("a", "Old Mac", "runner_below_gates", OLD);
  const limited = { locationId: "l", name: "Laptop", reason: "limited" };
  const { client, sent } = api(async () => ({ preflight: withSummary({ excludedLocations: [old, excluded("d", "Desk", "runner_below_gates", OLD)], limitedLocations: [limited] }) }));
  await assert.rejects(launchFullControlCampaign(client, request, { excluded: [old], limited: [] }),
    (error: unknown) => error instanceof FullControlLocationsToReview && error.report.excluded.length === 2 && error.report.limited.length === 1);
  assert.equal(sent.admissions.length, 0);
  // A limit alone is still something the person approves.
  assert.deepEqual(fullControlLocationReport(withSummary({ excludedLocations: [], limitedLocations: [limited] })), { excluded: [], limited: [limited] });
});

test("a start stops again when a shown row's repository or name changed, even with the same Location and reason (#4319)", async () => {
  const shown = { ...excluded("a", "Old Mac", "runner_below_gates", OLD), repository: "old/tools" };
  const shownLimit = { locationId: "l", name: "Laptop", reason: "limited" };
  for (const [what, now] of [
    ["repository", { excluded: [{ ...shown, repository: "other/tools" }], limited: [shownLimit] }],
    ["excluded name", { excluded: [{ ...shown, name: "Old Mac Renamed" }], limited: [shownLimit] }],
    ["limited name", { excluded: [shown], limited: [{ ...shownLimit, name: "Laptop Renamed" }] }],
  ] as const) {
    const { client, sent } = api(async () => ({ preflight: withSummary({ excludedLocations: [...now.excluded], limitedLocations: [...now.limited] }) }));
    await assert.rejects(launchFullControlCampaign(client, request, { excluded: [shown], limited: [shownLimit] }),
      (error: unknown) => error instanceof FullControlLocationsToReview, what);
    assert.equal(sent.admissions.length, 0, what);
  }
  const { client, sent } = api(async () => ({ preflight: withSummary({ excludedLocations: [shown], limitedLocations: [shownLimit] }) }));
  await launchFullControlCampaign(client, request, { excluded: [shown], limited: [shownLimit] });
  assert.equal(sent.admissions.length, 1, "what was shown, unchanged, starts");
});

test("a campaign whose runners are all current starts in one action, even with other exclusions (#4319)", async () => {
  const { client, sent } = api(async () => ({ preflight: withSummary({ excludedLocations: [excluded("b", "Notes", "not_repository", "not a repository"), excluded("c", "Away", "runner_offline", "offline")] }) }));
  await launchFullControlCampaign(client, request);
  assert.equal(sent.admissions.length, 1);
  assert.equal(fullControlLocationReport(withSummary({ excludedLocations: [] })), null);
});

test("the server's placement refusal is the inline sentence, and nothing is admitted (#2940)", async () => {
  const reason = "Full Control needs the Direct harness, because Native TUI doesn't track usage or show approval cards. Choose Direct under Harness.";
  const { client, sent } = api(async () => { throw new ApiError(`Full Control launch is blocked: ${reason}`, 409); });
  await assert.rejects(launchFullControlCampaign(client, request),
    (error: unknown) => error instanceof FullControlBlockedError && error.message === reason);
  assert.equal(sent.preflights.length, 1, "a refusal is not retried");
  assert.equal(sent.admissions.length, 0);
});
