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
import { EMPTY_GRANT, issues } from "./scope-grant-test-fixture.js";
import { SessionsService } from "./sessions.js";

type Reading = (message: RunDecisionMessage, attempt: number) => FakeDecisionStep | Promise<FakeDecisionStep>;
type CampaignIssueScopeCandidate = NonNullable<CampaignIssueScopeView["candidates"]>[number];
const EMPTY_FIELDS: Record<string, unknown> = { ...EMPTY_GRANT };

/** A healthy reading naming exactly these issues. */
const named = (...numbers: number[]): FakeDecisionStep => ({ verdict: "grant", reason: "The person names the epic to orchestrate.",
  fields: { ...EMPTY_GRANT, explicit: issues(...numbers) } });

/** A Custom Orchestrator created from `prompt` by its person, on a runner whose issue #40 has members. */
function harness(prompt: string, reading: Reading, members: Record<number, CampaignIssueScopeCandidate["source"][]> = { 40: ["sub_issue", "member_checklist"] },
  notIssues: ReadonlySet<number> = new Set()) {
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
    // One number that is not an issue (a pull request, a missing issue) refuses the whole read, as the runner does.
    if (message.issues?.some((number) => notIssues.has(number))) return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: false };
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

test("every first message that writes a digit string gets a reading, an explicit issue list included (#4259)", () => {
  for (const prompt of ["Orchestrate epic #2225.", "Please coordinate GitHub epic 2225", "Work through everything under 2225 and its children",
    "Orchestrate issues #12 and #13.", "Claim and delegate issue 1201 through 1207."]) {
    assert.equal(needsCampaignIssueScopeSeed(prompt), true, prompt);
  }
  // No digits: nothing to read, so no Decision call and nothing granted.
  assert.equal(needsCampaignIssueScopeSeed("Coordinate the release work."), false);
  assert.equal(needsCampaignIssueScopeSeed("Release 0 changes."), false, "0 names no issue");
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
  for (const [prompt, reading, granted] of [
    ["Do not orchestrate epic #40; coordinate the release checklist.", { verdict: "grant", fields: { ...EMPTY_GRANT, context: issues(40) } }, undefined],
    ["Coordinate the fix for #50.", named(50), [50]],
    ["Coordinate #40 and #50 together.", named(40, 50), [40, 50]],
  ] as Array<[string, FakeDecisionStep, number[] | undefined]>) {
    const h = harness(prompt, () => reading);
    try {
      await h.settled();
      assert.equal(h.policy().issueScopeSeed!.state, "none", prompt);
      assert.equal(h.policy().issueScopeProposalEpic, undefined, prompt);
      // The issues the reading names to work on are the campaign's (#4259); a context reference is not.
      assert.deepEqual(h.policy().issueNumbers, granted, prompt);
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

/**
 * A Custom campaign launched without a message whose first message was recorded before #4216 (#4258):
 * the old build held it through the `initialCampaignEpic` regex on every check and stored nothing, so
 * it carries no seed. `harness("")` is that empty launch, and the message is appended the way the old
 * build recorded it, without the first-prompt seed.
 */
function preUpgradeCampaign(message: string, reading: Reading) {
  const h = harness("", reading);
  h.db.appendEvent(h.id, { kind: "user_message", text: message }, Date.now());
  assert.equal(h.policy().issueScopeSeed, undefined, "the old build stored no seed");
  assert.equal(h.policy().issueScopeProposalEpic, undefined, "nor an epic: it read the message on every check");
  const owner = { kind: "human" as const, id: h.db.localIdentityContext().userId };
  const principal = { ...h.db.localIdentityContext(), kind: "human" as const, actorId: owner.id };
  /** The owner approves an issue scope of #40 from Campaign Status. */
  const approveScope = async (requestId: string) => {
    const proposed = await h.svc.proposeCampaignIssueScope(h.id, { requestId, expectedRevision: 0,
      additions: [{ repository: "team/repo", number: 40 }], removals: [], explanation: "The epic" }, () => true, principal);
    assert.ok(proposed.ok, proposed.error ?? requestId);
    assert.ok(h.svc.resolveWorkflowDecision(h.id, h.id, proposed.data!.occurrenceId, { outcome: "approve" }, "human", owner, () => true).ok);
  };
  return { ...h, owner, approveScope };
}

test("a pre-upgrade campaign whose reading fails stays held until its owner continues without an epic (#4258)", async () => {
  const h = preUpgradeCampaign("Orchestrate epic #40.", () => ({ errorClass: "authentication" }));
  try {
    const waiting = h.delegate();
    assert.equal(waiting.ok, false, "the first delegation after the upgrade is held");
    assert.match(waiting.error!, /still reading this campaign's first message/u);
    assert.equal(h.policy().issueScopeSeed!.messageDigest, firstMessageDigest("Orchestrate epic #40."), "the recorded first message is read");
    await h.settled();
    assert.equal(h.fake.calls.length, 1, "the Decision Model reads it once");
    const seed = h.policy().issueScopeSeed!;
    assert.equal(seed.state, "owner");
    assert.equal(h.policy().issueScopeProposalEpic, undefined, "nothing is parsed from the text instead");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const held = h.delegate();
      assert.equal(held.ok, false, "held on every later attempt");
      assert.match(held.error!, /Confirm the epic's authorized issue scope/u);
    }
    assert.equal(h.fake.calls.length, 1, "a held campaign is never read again");
    assert.equal(h.db.campaignDecisionSubject(seed.occurrenceId!)?.surface, "issue_scope_seed", "Campaign Status shows the Epic Seed row");
    assert.equal(campaignSeedSubjectState(h.policy(), seed.occurrenceId!), "owner", "and offers Continue Without an Epic");
    const released = h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "orchestrator" }, h.owner);
    assert.ok(released.ok, released.error ?? "released");
    assert.equal(h.policy().issueScopeSeed!.state, "none");
    assert.equal(h.policy().issueScope, undefined, "releasing scopes and grants nothing");
    assert.equal(h.delegate().ok, true, "Continue Without an Epic releases the hold");
    assert.equal(h.fake.calls.length, 1);
  } finally { h.db.close(); }
});

test("a pre-upgrade campaign whose reading is uncertain stays held until its owner approves an issue scope (#4258)", async () => {
  const h = preUpgradeCampaign("Orchestrate epic #40.", () => ({ verdict: "uncertain", reason: "It is unclear which issue is the epic.", fields: EMPTY_FIELDS }));
  try {
    assert.equal(h.delegate().ok, false);
    await h.settled();
    assert.equal(h.policy().issueScopeSeed!.state, "owner");
    assert.equal(h.delegate().ok, false, "held until the owner acts");
    await h.approveScope("approve-uncertain");
    assert.deepEqual(h.policy().issueScope!.issueNumbers, [40]);
    assert.equal(campaignSeedSubjectState(h.policy(), h.policy().issueScopeSeed!.occurrenceId!), "scoped");
    assert.equal(h.delegate().ok, true, "the owner's scope approval releases the hold");
  } finally { h.db.close(); }
});

test("a pre-upgrade campaign's epic is seeded by the reading, its scope starts from the epic's members, and only the owner's approval releases it (#4258)", async () => {
  const h = preUpgradeCampaign("Orchestrate epic #40.", () => named(40));
  try {
    // Campaign Status reading the scope starts the seed too, before the Orchestrator tries to delegate.
    assert.ok((await h.svc.campaignIssueScope(h.id)).ok);
    assert.notEqual(h.policy().issueScopeSeed, undefined);
    await h.settled();
    assert.equal(h.policy().issueScopeSeed!.state, "seeded");
    assert.equal(h.policy().issueScopeProposalEpic, 40);
    const held = h.delegate();
    assert.equal(held.ok, false);
    assert.match(held.error!, /Confirm the epic's authorized issue scope/u);
    const view = await h.svc.campaignIssueScope(h.id);
    assert.ok(view.ok, view.error ?? "scope view");
    assert.deepEqual(view.data!.candidates!.map((c) => c.issue.number), [40, 41, 42], "the scope inspection starts from the epic's members again");
    assert.equal(h.svc.classifyCampaignDecision(h.id, h.policy().issueScopeSeed!.occurrenceId!, { classification: "orchestrator" }, h.owner).status, 409,
      "a seeded epic waits for the scope approval itself");
    await h.approveScope("approve-seeded");
    assert.equal(h.delegate().ok, true);
    assert.equal(h.fake.calls.length, 1);
  } finally { h.db.close(); }
});

test("a pre-upgrade campaign is read once, a first message that needs no reading holds nothing, and later messages never count (#4258)", async () => {
  const quiet = preUpgradeCampaign("Coordinate the release checklist.", () => named(40));
  try {
    assert.equal(quiet.delegate().ok, true, "a first message without an issue number never held delegation and still doesn't");
    assert.equal(quiet.policy().issueScopeSeed!.state, "none");
    assert.equal(quiet.fake.calls.length, 0, "no Decision call");
    quiet.db.appendEvent(quiet.id, { kind: "user_message", text: "Now orchestrate epic #40." }, Date.now());
    assert.equal(quiet.delegate().ok, true, "a later message is never read as the first");
    assert.equal(quiet.fake.calls.length, 0);
  } finally { quiet.db.close(); }
  // Repeated checks while the reading runs start one reading and one audited occurrence.
  const h = preUpgradeCampaign("Orchestrate epic #40.", () => named(40));
  try {
    assert.equal(h.delegate().ok, false);
    assert.equal(h.delegate().ok, false);
    await h.svc.campaignIssueScope(h.id);
    await h.settled();
    assert.equal(h.fake.calls.length, 1);
    assert.equal(h.occurrences().length, 1);
  } finally { h.db.close(); }
});

/**
 * The initial-prompt issue list on the scope grant (#4259), replacing `orchestratorIssueNumbersFromInitialPrompt`.
 * Every reading is scripted on the fake harness; no grammar reads the prompt.
 */
test("a launch prompt's issues come only from the reading: none at creation, held until it settles, then the issues it names (#4259)", async () => {
  let release: (step: FakeDecisionStep) => void = () => {};
  const held = new Promise<FakeDecisionStep>((resolve) => { release = resolve; });
  const h = harness("Orchestrate issues #12 and #13.", () => held);
  try {
    assert.equal(h.policy().issueNumbers, undefined, "createSession grants nothing while the reading is unsettled");
    assert.equal(h.policy().issueNumbersSource, undefined);
    assert.equal(h.policy().issueScopeSeed!.state, "pending");
    const waiting = h.delegate();
    assert.equal(waiting.ok, false, "delegation waits for the reading");
    assert.match(waiting.error!, /still reading this campaign's first message/u);
    release(named(12, 13));
    await h.settled();
    assert.deepEqual(h.policy().issueNumbers, [12, 13]);
    assert.equal(h.policy().issueNumbersSource, "human_launch_request", "the person's own create request");
    assert.equal(h.policy().issueScopeSeed!.state, "none");
    assert.equal(h.delegate().ok, true);
    assert.equal(h.occurrences().length, 1);
  } finally { h.db.close(); }
});

test("the reading, not a grammar, decides: it narrows a prompt the old grammar matched and grants one it missed (#4259)", async () => {
  for (const [prompt, reading, granted] of [
    // The old grammar granted both; the model names only #12, and only #12 is granted.
    ["Orchestrate issues #12 and #13.", named(12), [12]],
    // The old grammar granted nothing here.
    ["Please work through #12 and #13 for me, one child each.", named(12, 13), [12, 13]],
    ["Claim and delegate issue 1201 through 1203.", { verdict: "grant", fields: { ...EMPTY_GRANT, ranges: [{ repository: "", first: 1201, last: 1203 }] } }, [1201, 1202, 1203]],
    // An explicit request the model reads as background grants nothing.
    ["Orchestrate issues #12 and #13.", { verdict: "grant", fields: { ...EMPTY_GRANT, context: issues(12, 13) } }, undefined],
  ] as Array<[string, FakeDecisionStep, number[] | undefined]>) {
    const h = harness(prompt, () => reading);
    try {
      await h.settled();
      assert.deepEqual(h.policy().issueNumbers, granted, prompt);
      assert.equal(h.policy().issueScopeSeed!.state, "none", prompt);
      assert.equal(h.fake.calls.length, 1, prompt);
    } finally { h.db.close(); }
  }
});

test("a transient failure that succeeds on retry grants the issues with nobody asked (#4259)", async () => {
  const h = harness("Orchestrate issues #12 and #13.", (_message, attempt) => attempt === 1 ? { errorClass: "rate_limited", retryAfterMs: 1_000 } : named(12, 13));
  try {
    await h.settled();
    assert.equal(h.fake.calls.length, 2);
    assert.equal(h.occurrences().length, 1, "one occurrence across both attempts");
    assert.deepEqual(h.policy().issueNumbers, [12, 13]);
    assert.equal(h.policy().issueScopeSeed!.state, "none");
  } finally { h.db.close(); }
});

test("a failed or uncertain reading of a launch prompt's issues creates exactly one person-owned request and grants nothing (#4259)", async () => {
  const cases: Array<[string, Reading, number]> = [
    ["retries exhausted", () => ({ errorClass: "provider_overloaded" }), DECISION_MAX_ATTEMPTS],
    ["a non-transient failure", () => ({ errorClass: "authentication" }), 1],
    ["an uncertain verdict", () => ({ verdict: "uncertain", reason: "It is unclear which issues to work on.", fields: EMPTY_FIELDS }), 1],
  ];
  for (const [name, reading, attempts] of cases) {
    const h = harness("Orchestrate issues #12 and #13.", reading);
    try {
      await h.settled();
      assert.equal(h.fake.calls.length, attempts, name);
      assert.equal(h.policy().issueNumbers, undefined, `${name}: nothing parsed from the text instead`);
      assert.equal(h.policy().issueNumbersSource, undefined, name);
      const seed = h.policy().issueScopeSeed!;
      assert.equal(seed.state, "owner", name);
      assert.equal(h.occurrences().length, 1, `${name}: one audited occurrence`);
      // The one typed, person-owned request: the seed's Campaign Status row, which only the owner settles.
      assert.equal(h.db.campaignDecisionSubject(seed.occurrenceId!)?.surface, "issue_scope_seed", name);
      assert.equal(h.svc.classifyCampaignDecision(h.id, seed.occurrenceId!, { classification: "orchestrator" }, { kind: "human", id: "someone-else" }).status, 403, name);
      const held = h.delegate();
      assert.equal(held.ok, false, `${name}: delegation waits for the person`);
      assert.match(held.error!, /Confirm the epic's authorized issue scope/u, name);
      // Repeated checks never start a second reading or a second request.
      assert.equal(h.delegate().ok, false, name);
      await h.svc.campaignIssueScope(h.id);
      assert.equal(h.fake.calls.length, attempts, name);
      assert.equal(h.occurrences().length, 1, name);
    } finally { h.db.close(); }
  }
});

test("the model may only narrow: a floor-dropped number, another repository's issue, or an unreadable issue leaves the reading with the owner (#4259)", async () => {
  const cases: Array<[string, string, FakeDecisionStep, ReadonlySet<number>]> = [
    ["an invented number", "Orchestrate issues #12 and #13.", named(12, 13, 99), new Set()],
    ["another repository's issue", "Orchestrate #12 and other/repo#13.", named(12, 13), new Set()],
    ["a range the message never writes", "Orchestrate #12 and #15.", { verdict: "grant", fields: { ...EMPTY_GRANT, ranges: [{ repository: "", first: 12, last: 15 }] } }, new Set()],
    ["a pull request the runner can't read as an issue", "Orchestrate issues #12 and #13.", named(12, 13), new Set([13])],
  ];
  for (const [name, prompt, reading, notIssues] of cases) {
    const h = harness(prompt, () => reading, undefined, notIssues);
    try {
      await h.settled();
      assert.equal(h.policy().issueScopeSeed!.state, "owner", name);
      assert.equal(h.policy().issueNumbers, undefined, `${name}: no part of the reading is granted`);
      assert.equal(h.occurrences().length, 1, name);
    } finally { h.db.close(); }
  }
});

test("a duplicate reading of a launch prompt joins its occurrence and never grants twice (#4259)", async () => {
  const h = harness("Orchestrate issues #12 and #13.", () => named(12, 13));
  try {
    await h.settled();
    assert.deepEqual(h.policy().issueNumbers, [12, 13]);
    const digest = h.policy().issueScopeSeed!.messageDigest;
    const calls = h.fake.calls.length;
    const replay = await h.fake.runtime.decide({ organizationId: h.db.sessionScope(h.id)!.organizationId, kind: "scope_grant",
      campaignSessionId: h.id, occurrenceKey: `scope_grant:issue_scope_seed:${h.id}:${digest}`, automaticHarness: null,
      inputs: { ownerMessage: "Orchestrate issues #12 and #13.", data: {} }, routeToHuman: () => null });
    assert.equal(replay.occurrenceId, h.occurrences()[0]!.occurrenceId);
    assert.equal(h.fake.calls.length, calls, "the replay joins the settled verdict");
    assert.equal(h.db.settleCampaignIssueScopeSeed(h.id, digest, { state: "none", grant: { issueNumbers: [14], launchRequest: true } }, Date.now()), false,
      "a settled reading never grants again");
    assert.deepEqual(h.policy().issueNumbers, [12, 13]);
  } finally { h.db.close(); }
});

test("a runner that can't hold an issue scope takes the person-owned route (#4259)", async () => {
  const h = harness("Orchestrate issues #12 and #13.", () => named(12, 13));
  try {
    const runner = h.db.getRunner("r")!;
    h.db.registerRunner({ runnerId: "r", hostname: runner.hostname, os: runner.os, version: runner.version, workspaces: runner.workspaces, agents: runner.agents },
      2, 157);
    await h.settled();
    assert.equal(h.policy().issueScopeSeed!.state, "owner");
    assert.equal(h.policy().issueNumbers, undefined);
  } finally { h.db.close(); }
});

test("a first message after an empty launch is read the same way, without launch-request provenance (#4259)", async () => {
  const h = harness("", () => named(12, 13));
  try {
    const principal = { ...h.db.localIdentityContext(), kind: "human" as const, actorId: h.db.localIdentityContext().userId };
    h.db.updateSessionStatus(h.id, "idle", Date.now());
    assert.ok((await h.svc.promptFromHuman(principal, h.id, "Orchestrate issues #12 and #13.")).ok);
    assert.equal(h.policy().issueNumbers, undefined, "nothing granted before the reading settles");
    await h.settled();
    assert.deepEqual(h.policy().issueNumbers, [12, 13]);
    assert.equal(h.policy().issueNumbersSource, undefined, "only the create request is the launch request Full Control enable trusts");
  } finally { h.db.close(); }
});
