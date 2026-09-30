import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDb } from "./db.js";

// An old application already removed the cache,
// leaving only its attested CP sequence. No durable report identity ever existed.
function legacyFixture(file = ":memory:") {
  const db = ControlPlaneDb.open(file);
  db.registerRunner({ runnerId: "runner", hostname: "fixture", os: "linux", version: "fixture",
    agents: [], workspaces: [{ id: "workspace", name: "Fixture", path: "/fixture" }] }, 500);
  for (const id of ["campaign", "child"]) {
    db.createSession({ id, runnerId: "runner", workspaceId: "workspace", agentId: "fixture",
      title: id, useWorktree: false, driver: "acp", config: {}, now: 900,
      ...(id === "child" ? { parentSessionId: "campaign" } : {}) });
  }
  db.updateSessionStatus("child", "idle", 999);
  db.reconcileRunnerHistory("child", 1, 3);
  db.reconcileRunnerHistory("child", 2, 3);
  db.raw().prepare(`INSERT INTO orchestrator_campaign_child_reports
    (campaign_session_id, child_session_id, report_event_seq, verified_at)
    VALUES ('campaign', 'child', 2, 1001)`).run();
  assert.deepEqual(db.listEvents("child"), []);
  assert.deepEqual(db.campaignReportRecoverySessionIds("campaign"), ["child"]);
  return db;
}

test("restart and another cache reset cannot capture a replayed legacy sequence as original proof", () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-legacy-restart-"));
  const file = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = legacyFixture(file);
    db.appendHydratedPage("child", { afterSeq: 0, historyEpoch: 2,
      eventEpoch: db.getRunnerHistoryState("child")!.eventEpoch }, [
      { seq: 1, ts: 800, payload: { kind: "agent_thought", text: "Before report" } },
      { seq: 2, ts: 900, payload: { kind: "agent_message", text: "Different report", final: true } },
    ]);
    db.close();
    db = ControlPlaneDb.open(file);
    assert.equal(db.campaignChildReportVerified("campaign", "child"), false,
      "even a report older than verified_at has no proven identity after a cache reset");
    assert.equal(db.raw().prepare("SELECT report_digest FROM orchestrator_campaign_child_reports").get()?.report_digest, null);
    assert.deepEqual(db.campaignReportRecoverySessionIds("campaign"), ["child"],
      "partial history recovery remains retryable even when the old sequence is occupied");
    db.clearSessionEvents("child");
    assert.equal(db.campaignChildReportVerified("campaign", "child"), false);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shifted legacy report requires exact re-verification after pre-upgrade cache loss", () => {
  const db = legacyFixture();
  try {
    db.appendHydratedPage("child", { afterSeq: 0, historyEpoch: 2,
      eventEpoch: db.getRunnerHistoryState("child")!.eventEpoch }, [
      { seq: 1, ts: 1000, payload: { kind: "agent_message", text: "Original report", final: true } },
      { seq: 2, ts: 1002, payload: { kind: "agent_thought", text: "After report" } },
      { seq: 3, ts: 1003, payload: { kind: "agent_thought", text: "End of history" } },
    ]);
    assert.equal(db.getRunnerHistoryState("child")!.complete, true);
    assert.equal(db.hasCompletedAgentReportAt("child", 1), true);
    db.finishCampaignReportHistoryHydration("child");
    assert.equal(db.campaignChildReportVerified("campaign", "child"), false);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS count FROM orchestrator_campaign_child_reports").get()?.count, 0);
    db.verifyCampaignChildReport("campaign", "child", 1, 3000);
    assert.equal(db.campaignChildReportVerified("campaign", "child"), true);
  } finally { db.close(); }
});

for (const replacement of [
  { kind: "agent_message", text: "Different report", final: true } as const,
  { kind: "agent_response_completed" } as const,
]) {
  test(`a pre-evicted legacy proof cannot trust a different ${replacement.kind} during replay`, () => {
    const db = legacyFixture();
    try {
      db.appendHydratedPage("child", { afterSeq: 0, historyEpoch: 2,
        eventEpoch: db.getRunnerHistoryState("child")!.eventEpoch }, [
        { seq: 1, ts: 1000, payload: { kind: "agent_message", text: "Original report", final: true } },
        { seq: 2, ts: 2000, payload: replacement },
      ]);
      assert.equal(db.getRunnerHistoryState("child")!.complete, false);
      assert.equal(db.campaignChildReportVerified("campaign", "child"), false,
        "a partial replay cannot establish the old attestation's identity");
      assert.equal(db.raw().prepare("SELECT report_digest FROM orchestrator_campaign_child_reports").get()?.report_digest, null);
      db.appendHydratedPage("child", { afterSeq: 2, historyEpoch: 2,
        eventEpoch: db.getRunnerHistoryState("child")!.eventEpoch }, [
        { seq: 3, ts: 2001, payload: { kind: "agent_thought", text: "After replacement" } },
      ]);
      assert.equal(db.getRunnerHistoryState("child")!.complete, true);
      db.finishCampaignReportHistoryHydration("child");
      assert.equal(db.campaignChildReportVerified("campaign", "child"), false,
        "a complete replay cannot promote an ambiguous numeric sequence");
      assert.equal(db.raw().prepare("SELECT COUNT(*) AS count FROM orchestrator_campaign_child_reports").get()?.count, 0);
      db.verifyCampaignChildReport("campaign", "child", 2, 3000);
      assert.equal(db.campaignChildReportVerified("campaign", "child"), true,
        "explicit exact-report verification establishes a new trusted proof");
      const stored = db.raw().prepare(`SELECT report_event_seq, report_ts, report_digest, report_event_epoch
        FROM orchestrator_campaign_child_reports`).get()!;
      assert.equal(stored.report_event_seq, 2);
      assert.equal(stored.report_ts, 2000);
      assert.equal(typeof stored.report_digest, "string");
      assert.equal(typeof stored.report_event_epoch, "number");
    } finally { db.close(); }
  });
}
