import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { Store } from "./store.js";

const session=(id: string,eventEpoch=1): SessionView => ({ id,eventEpoch,status: "idle",title: id } as SessionView);
test("detail hydration preserves legacy live state and rejects stale responses", () => {
  const store=new Store({ name: "session",id: "active" });
  const live={ ...session("active"),activeTurnId: "turn-1",queueHeld: true,queued: [{ id: "prompt",text: "Queued" }] };
  store.loadSession(live);
  assert.equal(store.beginSessionDetailLoad("active").apply(session("active")),true);
  assert.equal(store.getSession("active")!.activeTurnId,"turn-1");
  assert.equal(store.getSession("active")!.queueHeld,true);
  assert.deepEqual(store.getSession("active")!.queued,live.queued);
  assert.equal(store.beginSessionDetailLoad("active").apply({ ...session("active"),queueHeld: false }),true);
  assert.equal(store.getSession("active")!.activeTurnId,undefined,"a current server's explicit live state is authoritative");
  const pending=store.beginSessionDetailLoad("active");
  store.loadSession({ ...session("active"),status: "running",activeTurnId: "new-turn" });
  assert.equal(pending.apply(live),false);
  assert.equal(store.getSession("active")!.activeTurnId,"new-turn");
  const removed=store.beginSessionDetailLoad("active");
  store.dispatch({ type: "msg",msg: { type: "session_removed",sessionId: "active" } });
  assert.equal(removed.apply(live),false);
  assert.equal(store.getSession("active"),undefined);
  const reconnect=store.beginSessionDetailLoad("active");
  store.dispatch({ type: "msg",msg: { type: "snapshot",runners: [],boxes: [],sessions: [],runs: [] } });
  assert.equal(reconnect.apply(live),false);
});

test("paged snapshots retain the routed history until its row arrives and reconcile inventory at completion", () => {
  const store=new Store({ name: "session",id: "active" });
  store.dispatch({ type: "msg",msg: { type: "snapshot",capabilities: { sessionSubscriptions: true },
    runners: [],boxes: [],sessions: [session("active"),session("removed")],runs: [] } });
  store.dispatch({ type: "msg",msg: { type: "session_event",event: {
    id: 1,sessionId: "active",seq: 1,ts: 1,payload: { kind: "agent_message",text: "Retained" },
  } } });
  store.dispatch({ type: "msg",msg: { type: "snapshot",sessionsComplete: false,
    capabilities: { sessionSubscriptions: true },runners: [],boxes: [],sessions: [],runs: [] } });
  assert.equal(store.getState().snapshotLoaded,false);
  assert.equal(store.getState().sessions.has("removed"),true,"keep the inventory during a reconnect");
  assert.equal(store.getState().events.get("active")?.[0]?.seq,1);
  store.dispatch({ type: "msg",msg: { type: "session_snapshot_page",sessions: [session("other")],complete: false } });
  assert.equal(store.getState().snapshotLoaded,false);
  store.dispatch({ type: "msg",msg: { type: "session_snapshot_page",sessions: [{ ...session("active"),projection: "summary",title: "Fresh Title" }],complete: true } });
  assert.equal(store.getState().snapshotLoaded,true);
  assert.deepEqual([...store.getState().sessions.keys()].sort(),["active","other"]);
  assert.equal(store.getState().events.get("active")?.[0]?.seq,1);
  assert.equal(store.getState().sessions.get("active")?.projection,undefined,"keep the mounted detail across summary pages");
  assert.equal(store.getState().sessions.get("active")?.title,"Fresh Title","refresh list facts while retaining detail");
});

test("a page invalidates a replaced timeline and final absence removes a stale routed session", () => {
  const store=new Store({ name: "session",id: "active" });
  const header={ type: "snapshot" as const,capabilities: { sessionSubscriptions: true },runners: [],boxes: [],sessions: [session("active")],runs: [] };
  store.dispatch({ type: "msg",msg: header });
  store.dispatch({ type: "msg",msg: { type: "session_event",event: {
    id: 1,sessionId: "active",seq: 1,ts: 1,payload: { kind: "agent_message",text: "Old" },
  } } });
  store.dispatch({ type: "msg",msg: { ...header,sessions: [],sessionsComplete: false } });
  store.dispatch({ type: "msg",msg: { type: "session_snapshot_page",sessions: [session("active",2)],complete: true } });
  assert.equal(store.getState().events.has("active"),false);
  store.dispatch({ type: "msg",msg: { ...header,sessions: [],sessionsComplete: false } });
  store.dispatch({ type: "msg",msg: { type: "session_snapshot_page",sessions: [session("other")],complete: true } });
  assert.equal(store.getState().sessions.has("active"),false);
  assert.equal(store.getState().eventEpochs.has("active"),false);
  store.dispatch({ type: "msg",msg: { type: "session_snapshot_page",sessions: [session("stale")],complete: true } });
  assert.equal(store.getState().sessions.has("stale"),false,"pages outside an initial inventory are ignored");
});

test("authoritative summary omissions clear optional list facts without discarding detail-only fields", () => {
  const store=new Store({ name: "inbox" });
  const previous={ ...session("active"),stopOperation: { status: "stop_pending" },holds: [{ kind: "queue" }],
    queueHold: { holdId: "old" },backgroundDeliveries: [{ parentTurnId: "old" }],
    roleConversion: { targetRole: "orchestrator",phase: "preparing" },capacityWait: { reason: "old" },
    worktreePath: "/active",worktrees: [{ id: "active",path: "/active",branch: "Old",source: "created" }],
    campaignRequests: { human: 3,orchestrator: 0 },queueHeld: true,activeTurnId: "old-turn",
    agentCapabilities: { slashCommands: [{ name: "retained",description: "Detail" }] } } as unknown as SessionView;
  store.dispatch({ type: "msg",msg: { type: "snapshot",runners: [],boxes: [],sessions: [previous],runs: [] } });
  store.dispatch({ type: "msg",msg: { type: "snapshot",runners: [],boxes: [],sessions: [],runs: [],sessionsComplete: false } });
  store.dispatch({ type: "msg",msg: { type: "session_snapshot_page",sessions: [{ ...session("active"),projection: "summary" }],complete: true } });
  const current=store.getState().sessions.get("active")!;
  for (const field of ["stopOperation","holds","queueHold","backgroundDeliveries","roleConversion","capacityWait","campaignRequests","worktrees","queueHeld","activeTurnId"] as const) {
    assert.equal(current[field],undefined,`${field} must clear when omitted from the authoritative summary`);
  }
  assert.deepEqual(current.agentCapabilities,previous.agentCapabilities);
});
