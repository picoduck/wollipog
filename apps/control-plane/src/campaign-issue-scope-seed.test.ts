/**
 * A Custom campaign's epic seed on the Decision Model (#4104, Slice C), replacing the
 * `initialCampaignEpic` regex. Every path runs against a fake harness; no test calls a real provider.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type CampaignIssueScopeView, type RunDecisionMessage, type RunnerMetadata } from "@wollipog/protocol";
import { campaignSeedHoldsDelegation, campaignSeedSubjectState, needsCampaignIssueScopeSeed, seedEpicCandidate } from "./campaign-issue-scope-seed.js";
import { firstMessageDigest } from "./campaign-launch-admission.js";
import { fakeDecisionKind, fakeDecisionRuntime, HEALTHY_VERDICTS, type FakeDecisionStep } from "./credential-screen-test-fixture.js";
import { ControlPlaneDb } from "./db.js";
import { DECISION_MAX_ATTEMPTS } from "./decision-runtime.js";
import { Hub } from "./hub.js";
import { orchestratorIssueNumbersFromInitialPrompt } from "./orchestrator-issue-scope.js";
import { EMPTY_GRANT, issues } from "./scope-grant-test-fixture.js";
import { SessionsService } from "./sessions.js";

type Reading = (message: RunDecisionMessage, attempt: number) => FakeDecisionStep | Promise<FakeDecisionStep>;
type CampaignIssueScopeCandidate = NonNullable<CampaignIssueScopeView["candidates"]>[number];
const EMPTY_FIELDS: Record<string, unknown> = { ...EMPTY_GRANT };

/** A healthy reading naming exactly these issues. */
const named = (...numbers: number[]): FakeDecisionStep => ({ verdict: "grant", reason: "The person names the epic to orchestrate.",
  fields: { ...EMPTY_GRANT, explicit: issues(...numbers) } });

/** A Custom Orchestrator created from `prompt` by its person, on a runner whose issue #40 has members. */
function harness(prompt: string, reading: Reading, members: Record<number, CampaignIssueScopeCandidate["source"][]> = { 40: ["sub_issue", "member_checklist"] }) {
  const db = ControlPlaneDb.open(":memory:");
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "planner", name: "Planner", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true,
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default", "orchestrator"] } }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const hub = new Hub(db);
  const inspections: number[] = [];
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {}; hub.sendToRunner = () => true;
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type !== "campaign_issue_scope") throw new Error("Unexpected runner command");
    if (message.operation === "synchronize") return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true,
      repository: "team/repo", revision: message.scope.revision };
    if (message.operation !== "inspect") throw new Error("Unexpected runner command");
    if (message.issues?.length) return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
      candidates: message.issues.map((number) => ({ issue: { repository: "team/repo", number }, title: `Issue ${number}`, source: "member_checklist" as const })) };
    if (message.epic !== undefined) inspections.push(message.epic);
    const epic = message.epic;
    if (epic === 13) return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: false };
    const candidates: CampaignIssueScopeCandidate[] = epic === undefined ? [] : [{ issue: { repository: "team/repo", number: epic }, title: "Epic", source: "umbrella" },
      ...(members[epic] ?? []).map((source, index) => ({ issue: { repository: "team/repo", number: epic + 1 + index }, title: "Member", source }))];
    return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo", candidates };
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const fake = fakeDecisionRuntime(db, (message, attempt) => fakeDecisionKind(message) === "scope_grant" ? reading(message, attempt)
    : { verdict: HEALTHY_VERDICTS[fakeDecisionKind(message)]! });
  svc.setDecisionRuntime(fake.runtime);
  const created = svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "planner", config: { permissionMode: "orchestrator" }, prompt },
    undefined, undefined, false, false, false, { defaultOwnerUserId: db.localIdentityContext().userId });
  assert.ok(created.ok && created.data, created.error ?? "created");
  const id = created.data.id;
  db.updateSessionStatus(id, "running", Date.now());
  const delegate = () => svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "planner", prompt: "Fix one member.", config: {} },
    undefined, undefined, false, false, false, { parentSessionId: id });
  const policy = () => db.getSession(id)!.orchestratorPolicy!;
  const occurrences = () => db.listCampaignDecisionOccurrences(id).filter((occurrence) => occurrence.kind === "scope_grant");
  return { db, svc, id, fake, inspections, policy, occurrences, delegate, settled: () => svc.campaignIssueScopeSeedSettled(id) };
}

test("only a first message that writes a digit string and names no explicit issue list gets a seed", () => {
  for (const prompt of ["Orchestrate epic #2225.", "Please coordinate GitHub epic 2225", "Work through everything under 2225 and its children"]) {
    assert.equal(needsCampaignIssueScopeSeed(prompt, orchestratorIssueNumbersFromInitialPrompt(prompt)), true, prompt);
  }
  // No digits: nothing to read, so no Decision call. An explicit list keeps its own path.
  assert.equal(needsCampaignIssueScopeSeed("Coordinate the release work.", []), false);
  assert.equal(needsCampaignIssueScopeSeed("Orchestrate issues #12 and #13.", orchestratorIssueNumbersFromInitialPrompt("Orchestrate issues #12 and #13.")), false);
  assert.equal(needsCampaignIssueScopeSeed("Release 0 changes.", []), false, "0 names no issue");
});

test("a reading seeds an epic only when it names exactly one issue and nothing else to work on", () => {
  assert.equal(seedEpicCandidate({ ...EMPTY_GRANT, explicit: issues(40) }), 40);
  assert.equal(seedEpicCandidate({ ...EMPTY_GRANT, explicit: issues(40, 41) }), null);
  assert.equal(seedEpicCandidate({ ...EMPTY_GRANT, ranges: [{ repository: "", first: 40, last: 42 }] }), null);
  assert.equal(seedEpicCandidate({ ...EMPTY_GRANT, explicit: issues(40), ranges: [{ repository: "", first: 50, last: 52 }] }), null);
  assert.equal(seedEpicCandidate({ ...EMPTY_GRANT, explicit: issues(40), selectionRequested: true }), null);
  assert.equal(seedEpicCandidate(EMPTY_GRANT), null);
  const digest = "a".repeat(64);
  assert.equal(campaignSeedHoldsDelegation({ issueScopeSeed: { state: "pending", messageDigest: digest } }), true);
  assert.equal(campaignSeedHoldsDelegation({ issueScopeSeed: { state: "owner", messageDigest: digest } }), true);
  assert.equal(campaignSeedHoldsDelegation({ issueScopeSeed: { state: "seeded", messageDigest: digest }, issueScopeProposalEpic: 40 }), true);
  assert.equal(campaignSeedHoldsDelegation({ issueScopeSeed: { state: "none", messageDigest: digest } }), false);
  assert.equal(campaignSeedHoldsDelegation({ issueScopeSeed: { state: "owner", messageDigest: digest },
    issueScope: { repository: "team/repo", issueNumbers: [40], revision: 1, authorizedByUserId: "u", authorizedAt: 1 } }), false, "an approved scope holds nothing");
});

test("a healthy reading naming an issue with members seeds it as the epic, and delegation waits for the person's scope approval", async () => {
  const h = harness("Orchestrate epic #40 and its child issues.", () => named(40));
  try {
    assert.deepEqual(h.policy().issueScopeSeed, { state: "pending", messageDigest: firstMessageDigest("Orchestrate epic #40 and its child issues.") });
    const waiting = h.delegate();
    assert.equal(waiting.ok, false);
    assert.match(waiting.error!, /still reading this campaign's first message/u);
    await h.settled();
    assert.equal(h.policy().issueScopeSeed!.state, "seeded");
    assert.equal(h.policy().issueScopeProposalEpic, 40);
    assert.deepEqual(h.inspections, [40], "the runner read the named issue for members");
    const held = h.delegate();
    assert.equal(held.ok, false);
    assert.match(held.error!, /Confirm the epic's authorized issue scope/u);
    // The scope view is seeded with the epic's members, as before.
    const view = await h.svc.campaignIssueScope(h.id);
    assert.ok(view.ok, view.error ?? "scope view");
    assert.deepEqual(view.data!.candidates!.map((c) => c.issue.number), [40, 41, 42]);
    // The verdict is recorded beside what it affected, for Campaign Status.
    const [occurrence] = h.occurrences();
    assert.equal(occurrence!.state, "decided");
    const subject = h.db.campaignDecisionSubject(occurrence!.occurrenceId);
    assert.deepEqual([subject?.surface, subject?.sessionId], ["issue_scope_seed", h.id]);
    assert.equal(h.policy().issueScopeSeed!.occurrenceId, occurrence!.occurrenceId);
  } finally { h.db.close(); }
});

test("a reading that names no epic seeds nothing and holds nothing: no issue, an issue without members, a context reference", async () => {
  for (const [prompt, reading] of [
    ["Do not orchestrate epic #40; coordinate the release checklist.", { verdict: "grant", fields: { ...EMPTY_GRANT, context: issues(40) } }],
    ["Coordinate the fix for #50.", named(50)],
    ["Coordinate #40 and #50 together.", named(40, 50)],
  ] as Array<[string, FakeDecisionStep]>) {
    const h = harness(prompt, () => reading);
    try {
      await h.settled();
      assert.equal(h.policy().issueScopeSeed!.state, "none", prompt);
      assert.equal(h.policy().issueScopeProposalEpic, undefined, prompt);
      assert.equal(h.delegate().ok, true, prompt);
    } finally { h.db.close(); }
  }
});

test("a seed never comes from text: a failed, uncertain or floor-dropped reading leaves the scope to the person, with no seed", async () => {
  const cases: Array<[string, string, Reading, number]> = [
    ["retries exhausted", "Orchestrate epic #40.", () => ({ errorClass: "provider_overloaded" }), DECISION_MAX_ATTEMPTS],
    ["a non-transient failure", "Orchestrate epic #40.", () => ({ errorClass: "authentication" }), 1],
    ["an uncertain verdict", "Orchestrate epic #40.", () => ({ verdict: "uncertain", reason: "It is unclear which issue is the epic.", fields: EMPTY_FIELDS }), 1],
    ["an invented number, never read by the runner", "Orchestrate epic #40.", () => named(4000), 1],
    ["another repository's issue", "Orchestrate other/repo#40.", () => named(40), 1],
    ["an issue the runner cannot read", "Orchestrate epic #13.", () => named(13), 1],
  ];
  for (const [name, prompt, reading, attempts] of cases) {
    const h = harness(prompt, reading);
    try {
      await h.settled();
      assert.equal(h.fake.calls.length, attempts, name);
      assert.equal(h.policy().issueScopeSeed!.state, "owner", name);
      assert.equal(h.policy().issueScopeProposalEpic, undefined, `${name}: nothing is parsed from the text instead`);
      const held = h.delegate();
      assert.equal(held.ok, false, name);
      assert.match(held.error!, /Confirm the epic's authorized issue scope/u, name);
      assert.equal(h.occurrences().length, 1, `${name}: one audited occurrence`);
      if (name.startsWith("an invented number")) assert.deepEqual(h.inspections, [], "the runner never reads a number the message does not write");
      assert.equal(h.db.campaignDecisionSubject(h.occurrences()[0]!.occurrenceId)?.surface, "issue_scope_seed", name);
    } finally { h.db.close(); }
  }
});

test("the owner may continue without an epic when the seed is theirs; nobody else can, and a seeded epic is never released", async () => {
  for (const [name, prompt, reading] of [
    ["a failed reading", "Refactor the v2 parser.", () => ({ errorClass: "authentication" })],
    ["a floor-dropped reading", "Refactor the v2 parser.", () => named(7)],
  ] as Array<[string, string, Reading]>) {
    const h = harness(prompt, reading);
    try {
      await h.settled();
      const seed = h.policy().issueScopeSeed!;
      assert.equal(seed.state, "owner", name);
      assert.equal(h.delegate().ok, false, `${name}: held, and the scope approval would need an issue this campaign does not have`);
      const owner = { kind: "human" as const, id: h.db.localIdentityContext().userId };
      const stranger = h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "orchestrator" }, { kind: "human", id: "someone-else" });
      assert.equal(stranger.status, 403, name);
      const declined = h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "decline" }, owner);
      assert.equal(declined.status, 400, name);
      const released = h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "orchestrator" }, owner);
      assert.ok(released.ok, released.error ?? name);
      assert.equal(released.data!.classification, "orchestrator");
      assert.equal(h.policy().issueScopeSeed!.state, "none", name);
      assert.equal(h.policy().issueScopeProposalEpic, undefined, `${name}: releasing seeds and grants nothing`);
      assert.equal(h.policy().issueScope, undefined);
      assert.equal(h.delegate().ok, true, name);
      assert.equal(h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "orchestrator" }, owner).status, 409, `${name}: once`);
    } finally { h.db.close(); }
  }
  const seeded = harness("Orchestrate epic #40.", () => named(40));
  try {
    await seeded.settled();
    const owner = { kind: "human" as const, id: seeded.db.localIdentityContext().userId };
    const refused = seeded.svc.classifyCampaignDecision(seeded.id, seeded.policy().issueScopeSeed!.occurrenceId!, { classification: "orchestrator" }, owner);
    assert.equal(refused.status, 409, "a seeded epic waits for the scope approval itself");
    assert.equal(seeded.policy().issueScopeProposalEpic, 40);
  } finally { seeded.db.close(); }
});

test("a Custom campaign launched without a message gets its seed from the person's first message, and only from that one (review round 1)", async () => {
  const h = harness("", () => named(40));
  try {
    assert.equal(h.policy().issueScopeSeed, undefined, "no message yet, nothing to read");
    assert.equal(h.fake.calls.length, 0);
    const principal = { ...h.db.localIdentityContext(), kind: "human" as const, actorId: h.db.localIdentityContext().userId };
    h.db.updateSessionStatus(h.id, "idle", Date.now());
    const first = await h.svc.promptFromHuman(principal, h.id, "Orchestrate epic #40.");
    assert.ok(first.ok, first.error ?? "first message");
    assert.equal(h.policy().issueScopeSeed!.state, "pending");
    assert.equal(h.delegate().ok, false, "delegation waits for the reading");
    await h.settled();
    assert.equal(h.policy().issueScopeSeed!.state, "seeded");
    assert.equal(h.policy().issueScopeProposalEpic, 40);
    const held = h.delegate();
    assert.equal(held.ok, false);
    assert.match(held.error!, /Confirm the epic's authorized issue scope/u, "a verified epic still needs the person's scope approval");
    assert.equal(h.fake.calls.length, 1);
  } finally { h.db.close(); }
  // A later message never counts as the first: a campaign whose first message needs no reading keeps `none`.
  const later = harness("", () => named(40));
  try {
    const principal = { ...later.db.localIdentityContext(), kind: "human" as const, actorId: later.db.localIdentityContext().userId };
    later.db.updateSessionStatus(later.id, "idle", Date.now());
    assert.ok((await later.svc.promptFromHuman(principal, later.id, "Coordinate the release checklist.")).ok);
    assert.equal(later.policy().issueScopeSeed!.state, "none");
    later.db.updateSessionStatus(later.id, "idle", Date.now());
    assert.ok((await later.svc.promptFromHuman(principal, later.id, "Now orchestrate epic #40.")).ok);
    await later.settled();
    assert.equal(later.policy().issueScopeSeed!.state, "none");
    assert.equal(later.fake.calls.length, 0, "no reading of a later message");
    assert.equal(later.delegate().ok, true);
  } finally { later.db.close(); }
});

test("once the person approves a scope, Campaign Status shows no hold from the seed and offers no release (review round 2)", async () => {
  for (const [name, prompt, reading] of [
    ["an owner seed", "Orchestrate epic #40.", () => ({ errorClass: "authentication" })],
    ["a seeded epic", "Orchestrate epic #40.", () => named(40)],
  ] as Array<[string, string, Reading]>) {
    const h = harness(prompt, reading);
    try {
      await h.settled();
      const seed = h.policy().issueScopeSeed!;
      assert.notEqual(campaignSeedSubjectState(h.policy(), seed.occurrenceId!), "scoped", name);
      const owner = { kind: "human" as const, id: h.db.localIdentityContext().userId };
      const principal = { ...h.db.localIdentityContext(), kind: "human" as const, actorId: owner.id };
      const proposed = await h.svc.proposeCampaignIssueScope(h.id, { requestId: `approve-${name}`, expectedRevision: 0,
        additions: [{ repository: "team/repo", number: 40 }], removals: [], explanation: "The epic" }, () => true, principal);
      assert.ok(proposed.ok, proposed.error ?? name);
      assert.ok(h.svc.resolveWorkflowDecision(h.id, h.id, proposed.data!.occurrenceId, { outcome: "approve" }, "human", owner, () => true).ok, name);
      assert.deepEqual(h.policy().issueScope!.issueNumbers, [40], name);
      assert.equal(campaignSeedSubjectState(h.policy(), seed.occurrenceId!), "scoped", `${name}: the row reads as approved`);
      assert.equal(h.delegate().ok, true, `${name}: nothing holds delegation`);
      assert.equal(h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "orchestrator" }, owner).status, 409,
        `${name}: there is nothing left to release`);
    } finally { h.db.close(); }
  }
  // A reading that seeded nothing reads the same before and after; another occurrence reads as none of the campaign's.
  const digest = "a".repeat(64);
  const scope = { repository: "team/repo", issueNumbers: [40], revision: 1, authorizedByUserId: "u", authorizedAt: 1 };
  assert.equal(campaignSeedSubjectState({ issueScope: scope, issueScopeSeed: { state: "none", messageDigest: digest, occurrenceId: "dec_1" } }, "dec_1"), "none");
  assert.equal(campaignSeedSubjectState({ issueScopeSeed: { state: "owner", messageDigest: digest, occurrenceId: "dec_1" } }, "dec_2"), undefined);
});

test("a transient failure that succeeds on retry seeds the epic with nobody asked", async () => {
  const h = harness("Orchestrate epic #40.", (_message, attempt) => attempt === 1 ? { errorClass: "rate_limited" } : named(40));
  try {
    await h.settled();
    assert.equal(h.fake.calls.length, 2);
    assert.equal(h.policy().issueScopeSeed!.state, "seeded");
    assert.equal(h.policy().issueScopeProposalEpic, 40);
    assert.equal(h.occurrences().length, 1);
  } finally { h.db.close(); }
});

test("a message too large for one Decision call is never read in part: the person approves the scope", async () => {
  const prompt = `Orchestrate epic #40. ${"Background. ".repeat(6000)}`;
  const h = harness(prompt, () => named(40));
  try {
    await h.settled();
    assert.equal(h.fake.calls.length, 0);
    assert.equal(h.policy().issueScopeSeed!.state, "owner");
    const [occurrence] = h.occurrences();
    assert.deepEqual([occurrence?.state, occurrence?.failureClass], ["failed", "configuration"]);
  } finally { h.db.close(); }
});

test("a duplicate reading joins the same occurrence, and an interrupted one is the person's", async () => {
  const h = harness("Orchestrate epic #40.", () => named(40));
  try {
    await h.settled();
    const digest = h.policy().issueScopeSeed!.messageDigest;
    // A second reading of the same message (a replay) joins the settled occurrence: one verdict, no new call.
    const calls = h.fake.calls.length;
    const replay = await h.fake.runtime.decide({ organizationId: h.db.sessionScope(h.id)!.organizationId, kind: "scope_grant",
      campaignSessionId: h.id, occurrenceKey: `scope_grant:issue_scope_seed:${h.id}:${digest}`, automaticHarness: null,
      inputs: { ownerMessage: "Orchestrate epic #40.", data: {} }, routeToHuman: () => null });
    assert.equal(replay.occurrenceId, h.occurrences()[0]!.occurrenceId);
    assert.equal(h.fake.calls.length, calls);
    assert.equal(h.occurrences().length, 1);
    assert.equal(h.db.settleCampaignIssueScopeSeed(h.id, digest, { state: "none" }, Date.now()), false, "a settled seed never changes");
    assert.equal(h.policy().issueScopeSeed!.state, "seeded");
  } finally { h.db.close(); }
  // A seed left pending with no reading in flight (a control-plane restart) settles with the person.
  const restarted = harness("Orchestrate epic #40.", () => new Promise<FakeDecisionStep>(() => {}));
  try {
    const policy = restarted.db.getSession(restarted.id)!.orchestratorPolicy!;
    assert.equal(policy.issueScopeSeed!.state, "pending");
    const svc = new SessionsService(restarted.db, new Hub(restarted.db), { info() {}, warn() {}, error() {} });
    const view = await svc.campaignIssueScope(restarted.id);
    assert.equal(view.data?.supported, false, "the fresh service's runner is offline, but the seed still settles");
    assert.equal(restarted.policy().issueScopeSeed!.state, "owner");
  } finally { restarted.db.close(); }
});
