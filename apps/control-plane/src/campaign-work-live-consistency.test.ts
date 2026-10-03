/**
 * Campaign Status consistency for orderings and totals that move without a ledger revision (#2417):
 * the elapsed sort, which grows for every open item, and campaign cost, which grows as member usage
 * arrives. Driven through the production wiring: a real `ControlPlaneDb`, `Hub` with a connected
 * dashboard, `SessionsService`, `CampaignWorkObservations` registered as `index.ts` registers it
 * (usage observer included), and the browser Read API routes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import {
  CAMPAIGN_WORK_REVISION_CHANGED,
  PROTOCOL_VERSION,
  type CampaignWorkItemDetailResponse,
  type CampaignWorkItemsPage,
  type CampaignWorkSummary,
  type CampaignWorkSummaryResponse,
  type ControlPlaneToUi,
  type RunnerMetadata,
  type SessionView,
} from "@wollipog/protocol";
import { registerCampaignStatusRoutes } from "./campaign-status-routes.js";
import type { LedgerResult } from "./campaign-work-ledger-store.js";
import { CampaignWorkObservations } from "./campaign-work-observation.js";
import { ControlPlaneDb } from "./db.js";
import { Hub, type Socket } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "consistency-runner";
const WORKSPACE_ID = "consistency-workspace";
const ORG = "org_personal";
const NOOP_LOG = { info() {}, warn() {}, error() {} };
const WINDOW_MS = 20;

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Consistency", path: "/tmp/campaign-consistency" }],
    agents: [
      { id: "child-agent", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" } },
      { id: "orchestrator-agent", name: "Planner", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" },
        capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
          permissionModes: ["default", "orchestrator"] } },
    ],
  };
}

function human(userId: string): HumanPrincipal {
  return {
    kind: "human", actorId: userId, userId, userName: userId, organizationId: ORG, organizationName: "Personal",
    role: "owner", deviceId: null, localBootstrap: false,
  };
}

class Dashboard implements Socket {
  readonly messages: ControlPlaneToUi[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ControlPlaneToUi);
  }
  upserts(id: string): SessionView[] {
    return this.messages.flatMap((message) =>
      message.type === "session_upsert" && message.session.id === id ? [message.session] : []);
  }
  /** The campaign summary as this dashboard, and so the Campaign Status panel, currently shows it. */
  work(rootId: string): CampaignWorkSummary {
    const work = this.upserts(rootId).at(-1)?.orchestratorCampaign?.work;
    assert.ok(work, `the dashboard holds ${rootId}'s campaign summary`);
    return work;
  }
}

function knownUsd(metric: { availability: string; value?: { usd: number } } | undefined): number | null {
  return metric && metric.availability !== "unavailable" ? Math.round(metric.value!.usd * 1_000_000) / 1_000_000 : null;
}

async function stack() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const warnings: string[] = [];
  const observations = new CampaignWorkObservations({
    db,
    refresh: (campaignSessionId) => svc.campaignWorkObserved(campaignSessionId),
    warn: (message) => warnings.push(message),
    delayMs: WINDOW_MS,
  });
  db.campaignWorkLedger.accounting.observeUsage((campaignSessionId) => observations.usageChanged(campaignSessionId));
  hub.observeSessions({
    changed: (sessionId) => observations.sessionChanged(sessionId),
    removed: (sessionId) => observations.sessionRemoved(sessionId),
  });
  hub.attachRunner(RUNNER_ID, { send() {} });
  const owner = new Dashboard();
  assert.ok(hub.addUiClient(owner, { deviceId: "device-owner", principal: human("owner"), close() {} }));
  const app = Fastify();
  registerCampaignStatusRoutes(app, { db, requestPrincipal: () => human("owner") });
  await app.ready();
  const get = async <T>(url: string) => {
    const response = await app.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.json() as T };
  };

  const decisions = {
    implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
    follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator",
  } as const;
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "orchestrator-agent", title: "Consistency Campaign",
    config: { permissionMode: "orchestrator" }, prompt: "Orchestrate.", orchestrator: { behavior: { completion: "retain" } },
  }, undefined, undefined, false, false, false, {
    defaultOwnerUserId: "owner",
    orchestratorDefaults: {
      source: "user_default",
      defaults: {
        behavior: { childHarness: null, childModel: null, childEffort: null,
          maximumConcurrentChildren: 4, followUps: "execute_approved", completion: "retain" },
        delegation: { parentControl: "off", decisions: { ...decisions } },
        execution: { strictProjectIsolation: false, integrationIsolation: false },
      },
      capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
    },
    validateOrchestratorDefaults: () => null,
  });
  assert.ok(created.ok && created.data, String(created.error));
  const root = created.data.id;
  svc.onSessionStatus(root, "running");

  let sequence = 0;
  const child = (title: string) => {
    const id = `consistency-child-${++sequence}`;
    db.createSession({
      id, parentSessionId: root, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent", title,
      useWorktree: false, driver: "claude-code", config: {}, now: Date.now() + sequence,
    });
    hub.sessionChangedById(id);
    svc.onSessionStatus(id, "running");
    return id;
  };
  const until = async (description: string, predicate: () => boolean) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (predicate()) return;
      await delay(5);
    }
    assert.fail(`timed out waiting for ${description}`);
  };
  /** Let every pending coalesced refresh land. */
  const settle = async () => {
    await delay(WINDOW_MS * 3);
    observations.flush();
  };
  const close = async () => {
    observations.dispose();
    hub.removeUiClient(owner);
    await app.close();
    db.close();
    assert.deepEqual(warnings, [], "no observation refresh failed");
  };
  return { db, hub, svc, observations, owner, root, child, get, until, settle, close };
}

/** The HTTP status a ledger read answers with. */
function statusOf(result: LedgerResult<unknown>): number {
  return result.ok ? 200 : result.status;
}

/** Rewrite a cursor's fields, as an old server or a tampering client would have minted it. */
function rewriteCursor(cursor: string, edit: (fields: Record<string, unknown>) => void): string {
  const fields = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  edit(fields);
  return Buffer.from(JSON.stringify(fields)).toString("base64url");
}

test("elapsed-sorted pages neither skip nor repeat an item while open items overtake finished ones", async () => {
  const { db, svc, root, child, close } = await stack();
  try {
    const plan = svc.recordCampaignPlan(root, {
      items: [{ key: "finished", queuePosition: 1 }, { key: "open", queuePosition: 2 }, { key: "fresh", queuePosition: 3 }],
      planComplete: true,
    });
    assert.ok(plan.ok && plan.data, String(plan.error));
    const [finished, open, fresh] = plan.data.items.map((item) => item.workItemId);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: finished!, childSessionId: child("Finished") }).ok);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: open!, childSessionId: child("Open") }).ok);
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: finished!, commitment: { state: "cancelled", reason: "Done" } }).ok);
    // Pin the clock: "finished" ran 10s and stopped, "open" started 5s in, "fresh" never started and
    // was recorded 11s in. Both open items keep growing; the finished one does not.
    const t0 = Date.now() - 3_600_000;
    db.raw().prepare("UPDATE campaign_work_attempts SET started_at=? WHERE work_item_id=?").run(t0, finished!);
    db.raw().prepare("UPDATE campaign_work_attempts SET started_at=? WHERE work_item_id=?").run(t0 + 5_000, open!);
    db.raw().prepare("UPDATE campaign_work_items SET commitment_changed_at=? WHERE id=?").run(t0 + 10_000, finished!);
    db.raw().prepare("UPDATE campaign_work_items SET created_at=? WHERE id=?").run(t0 + 11_000, fresh!);

    const ledger = db.campaignWorkLedger;
    const keys = (page: CampaignWorkItemsPage) => page.items.map((item) => item.key);
    const query = { state: "all" as const, sort: "elapsed" as const };
    const at = (now: number) => {
      const page = ledger.page(root, query, now);
      assert.ok(page.ok, JSON.stringify(page));
      return keys(page.data);
    };
    // Between 12s and 30s both open items overtake the finished one, with no ledger write.
    assert.deepEqual(at(t0 + 12_000), ["finished", "open", "fresh"]);
    assert.deepEqual(at(t0 + 30_000), ["open", "fresh", "finished"], "the order really moves while time advances");

    // One page per read, each read later than the last: the walk keeps the order of its first page.
    const walked: string[] = [];
    let cursor: string | undefined;
    let revision: number | undefined;
    for (const now of [t0 + 12_000, t0 + 30_000, t0 + 60_000]) {
      const page = ledger.page(root, { ...query, limit: 1, ...(cursor ? { cursor } : {}) }, now);
      assert.ok(page.ok, JSON.stringify(page));
      revision ??= page.data.revision;
      assert.equal(page.data.revision, revision, "time alone moves no revision");
      walked.push(...keys(page.data));
      cursor = page.data.nextCursor ?? undefined;
    }
    assert.equal(cursor, undefined);
    assert.deepEqual(walked, ["finished", "open", "fresh"], "every item once, in the order the first page was read at");

    // The same over the browser route, whose reads take the wall clock.
    const first = ledger.page(root, { ...query, limit: 1 }, t0 + 12_000);
    assert.ok(first.ok && first.data.nextCursor);
    const app = Fastify();
    registerCampaignStatusRoutes(app, { db, requestPrincipal: () => human("owner") });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET",
        url: `/api/sessions/${root}/campaign/work-items?state=all&sort=elapsed&limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(keys(response.json() as CampaignWorkItemsPage), ["open", "fresh"],
        "a page read an hour later still continues the first page's order");
    } finally {
      await app.close();
    }

    // A cursor without its evaluation time (minted before it was bound) restarts instead of skipping.
    const unbound = rewriteCursor(first.data.nextCursor, (fields) => { delete fields.t; });
    const refused = ledger.page(root, { ...query, limit: 1, cursor: unbound }, t0 + 30_000);
    assert.equal(statusOf(refused), 409);
    assert.equal(!refused.ok && refused.details?.code, CAMPAIGN_WORK_REVISION_CHANGED);
    const malformed = rewriteCursor(first.data.nextCursor, (fields) => { fields.t = "soon"; });
    assert.equal(statusOf(ledger.page(root, { ...query, limit: 1, cursor: malformed }, t0 + 30_000)), 400);
    // The evaluation time only binds the elapsed sort: another sort's cursor carries none.
    const queued = ledger.page(root, { state: "all", limit: 1 }, t0 + 12_000);
    assert.ok(queued.ok && queued.data.nextCursor);
    assert.equal(JSON.parse(Buffer.from(queued.data.nextCursor, "base64url").toString("utf8")).t, undefined);
    const timedQueue = rewriteCursor(queued.data.nextCursor, (fields) => { fields.t = t0; });
    assert.equal(statusOf(ledger.page(root, { state: "all", limit: 1, cursor: timedQueue }, t0 + 12_000)), 409,
      "a queue cursor carrying a time is not the cursor this sort minted");

    // A ledger write still invalidates an elapsed cursor.
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: fresh!, title: "Renamed" }).ok);
    assert.equal(statusOf(ledger.page(root, { ...query, limit: 1, cursor: first.data.nextCursor }, t0 + 12_000)), 409);
  } finally {
    await close();
  }
});

test("member usage refreshes the live summary within the coalescing window, with no ledger write", async () => {
  const { db, svc, owner, root, child, get, until, settle, close } = await stack();
  try {
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "a" }, { key: "b" }], planComplete: true });
    assert.ok(plan.ok && plan.data, String(plan.error));
    const worker = child("Deliver a");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: plan.data.items[0]!.workItemId, childSessionId: worker }).ok);
    await settle();
    const before = owner.work(root);
    const revision = before.revision;
    assert.equal(knownUsd(before.cost?.total), 0, "nothing was used yet");
    const queueFirst = await get<CampaignWorkItemsPage>(`/api/sessions/${root}/campaign/work-items?state=all&limit=1`);
    assert.equal(queueFirst.status, 200);
    const upsertsBefore = owner.upserts(root).length;

    // A token stream from the child: usage reaches the session ledger, and nothing re-sends the root.
    for (let index = 0; index < 50; index += 1) {
      db.appendEvent(worker, { kind: "token_usage", inputTokens: 10, costUsd: 0.02 }, Date.now(), { accrueUsage: true });
    }
    await until("the dashboard to show the new cost", () => knownUsd(owner.work(root).cost?.total) === 1);
    const after = owner.work(root);
    assert.equal(knownUsd(after.cost?.workItems), 1);
    assert.equal(after.revision, revision, "usage is not a ledger write and moves no revision");
    assert.deepEqual(after.counts, before.counts, "the cached ledger part of the summary is unchanged");
    await settle();
    assert.equal(owner.upserts(root).length - upsertsBefore, 1, "fifty usage records cost one root refresh");

    // The Read API agrees, and a cursor minted before the usage still continues.
    const summary = await get<CampaignWorkSummaryResponse>(`/api/sessions/${root}/campaign/summary`);
    assert.equal(knownUsd(summary.body.summary.cost?.total), 1);
    assert.equal(summary.body.summary.revision, revision);
    const next = await get<CampaignWorkItemsPage>(
      `/api/sessions/${root}/campaign/work-items?state=all&limit=1&cursor=${encodeURIComponent(queueFirst.body.nextCursor!)}`);
    assert.equal(next.status, 200, "usage does not invalidate a queue-sorted cursor");
    // What the panel re-reads when the re-sent summary's cost moved: the open item's details and
    // its row carry the same cost as the summary, at the same revision.
    const itemId = plan.data.items[0]!.workItemId;
    const detail = await get<CampaignWorkItemDetailResponse>(`/api/sessions/${root}/campaign/work-items/${itemId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.revision, revision);
    assert.equal(knownUsd(detail.body.item.cost), knownUsd(after.cost?.workItems), "the open detail matches the summary");
    const rows = await get<CampaignWorkItemsPage>(`/api/sessions/${root}/campaign/work-items?state=all`);
    assert.equal(knownUsd(rows.body.items.find((row) => row.id === itemId)?.cost), knownUsd(after.cost?.workItems),
      "and so does its row");

    // A steady stream is bounded by the window: at most one refresh per window, plus the trailing one.
    const streamStart = owner.upserts(root).length;
    const started = Date.now();
    while (Date.now() - started < WINDOW_MS * 5) {
      db.appendEvent(worker, { kind: "token_usage", inputTokens: 1, costUsd: 0.01 }, Date.now(), { accrueUsage: true });
      await delay(1);
    }
    const elapsedWindows = Math.ceil((Date.now() - started) / WINDOW_MS);
    await settle();
    const refreshes = owner.upserts(root).length - streamStart;
    assert.ok(refreshes >= 1 && refreshes <= elapsedWindows + 1, `${refreshes} refreshes over ${elapsedWindows} windows`);
    assert.equal(owner.work(root).revision, revision);

    // Slice 6's masking still applies on the refreshed root: a contributor some of the root's
    // readers cannot see hides its bucket from the embedded summary.
    db.raw().prepare("UPDATE session_ownership SET owner_kind='user', owner_id='someone-else' WHERE session_id=?").run(worker);
    db.appendEvent(worker, { kind: "token_usage", inputTokens: 1, costUsd: 0.01 }, Date.now(), { accrueUsage: true });
    await until("the refreshed summary to hide the hidden contributor", () =>
      owner.work(root).cost?.workItems.availability === "unavailable");
    assert.deepEqual(owner.work(root).cost?.workItems, { availability: "unavailable", reason: "not_authorized" });
  } finally {
    await close();
  }
});

test("a failing usage observer never fails the usage write it rides on", async () => {
  const { db, svc, root, child, close } = await stack();
  try {
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "a" }], planComplete: true });
    const worker = child("Deliver a");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: plan.data!.items[0]!.workItemId, childSessionId: worker }).ok);
    db.campaignWorkLedger.accounting.observeUsage(() => { throw new Error("observer down"); });
    db.appendEvent(worker, { kind: "token_usage", inputTokens: 1, costUsd: 0.5 }, Date.now(), { accrueUsage: true });
    assert.equal(knownUsd(db.campaignProjection(root)?.work?.cost?.workItems), 0.5);
  } finally {
    await close();
  }
});
