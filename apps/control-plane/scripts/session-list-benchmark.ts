// Reproducible isolated synthetic data. No hosting-stack processes or databases are used.
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import { PROTOCOL_VERSION,DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";
import { ControlPlaneDb } from "../src/db.js";
import { Hub, MAX_UI_BUFFERED_BYTES, type Socket } from "../src/hub.js";
import { LOCAL_OWNER_USER_ID,PERSONAL_ORGANIZATION_ID,type HumanPrincipal } from "../src/identity.js";
import { resolveOrchestratorCampaignPolicy } from "../src/orchestrator-settings.js";

const principal: HumanPrincipal = { kind: "human",actorId: LOCAL_OWNER_USER_ID,userId: LOCAL_OWNER_USER_ID,
  userName: "Synthetic",organizationId: PERSONAL_ORGANIZATION_ID,organizationName: "Synthetic",
  role: "owner",deviceId: null,localBootstrap: true };
const root = mkdtempSync(join(tmpdir(),"wollipog-session-list-benchmark-"));
const db = ControlPlaneDb.open(join(root,"synthetic.db"));
const app = Fastify();
app.get("/api/sessions",(_request,reply) => reply.type("application/json").send(db.sessionListJsonForPrincipal(principal)));
const percentile = (values: number[],fraction: number) => Number([...values].sort((a,b) => a-b)[Math.floor((values.length-1)*fraction)]!.toFixed(3));
try {
  // Seeding is disposable; restore production durability before measuring.
  db.raw().exec("PRAGMA synchronous=NORMAL");
  db.registerRunner({ runnerId: "r",hostname: "synthetic",os: "linux",version: "synthetic",workspaces: [],agents: [] },1,PROTOCOL_VERSION);
  for (let index=0; index<2000; index++) db.createSession({ id: `s-${index}`,runnerId: "r",workspaceId: null,
    agentId: null,title: `Synthetic Session ${index}`,useWorktree: false,driver: "codex-app-server",config: {},now: index+1,
    ...(index===0 ? { role: "orchestrator",orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS,"system_default") } : {}) });
  db.raw().prepare("UPDATE sessions SET parent_session_id='s-0' WHERE id='s-1'").run();
  db.setPendingApproval("s-1",{ requestId: "synthetic-sign-in",kind: "authentication",title: "Sign In",options: [] });
  for (let index=1;index<4;index++) db.createIdentityMember({ userId: `synthetic-reader-${index}`,
    displayName: "Synthetic Reader",organizationId: PERSONAL_ORGANIZATION_ID,role: "owner",now: 1 });
  db.raw().exec("PRAGMA synchronous=FULL");
  await app.ready();
  for (let index=0; index<5; index++) await app.inject({ method: "GET",url: "/api/sessions" });
  const diagnosticStart = performance.now();
  const diagnosticSessions = db.listSessionSummaries(principal);
  const hydrationMs = performance.now()-diagnosticStart;
  const encodingStart = performance.now();
  JSON.stringify({ sessions: diagnosticSessions });
  const encodingMs = performance.now()-encodingStart;
  const latency: number[]=[];
  let restBytes=0;
  for (let index=0; index<50; index++) {
    const start=performance.now();
    const response=await app.inject({ method: "GET",url: "/api/sessions" });
    latency.push(performance.now()-start);
    assert.equal(response.statusCode,200);
    restBytes=Buffer.byteLength(response.body);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const coldLatency: number[] = [];
  for (let index = 0; index < 20; index++) {
    db.raw().prepare("UPDATE sessions SET updated_at=updated_at+1 WHERE id='s-0'").run();
    const start = performance.now();
    await app.inject({ method: "GET", url: "/api/sessions" });
    coldLatency.push(performance.now()-start);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const connects: number[]=[];
  let snapshotBytes=0,maxFrameBytes=0;
  for (let repeat=0; repeat<10; repeat++) {
    db.raw().prepare("UPDATE sessions SET updated_at=updated_at+1 WHERE id='s-0'").run();
    const hub=new Hub(db);
    let pending=0;
    let resolveDrained: () => void=() => {};
    const drained=new Promise<void>((resolve) => { resolveDrained=resolve; });
    let finished=false;
    const stalls: number[]=[];
    const heartbeat=(async () => {
      while (!finished) {
        const started=performance.now();
        await new Promise<void>((resolve) => setImmediate(resolve));
        stalls.push(performance.now()-started);
      }
    })();
    for (let dashboard=0; dashboard<4; dashboard++) {
      const socket: Socket={ asyncDelivery: true,send(data,done) {
        const bytes=Buffer.byteLength(data);
        if (dashboard===0) snapshotBytes+=bytes;
        maxFrameBytes=Math.max(maxFrameBytes,bytes);
        pending++;
        setImmediate(() => { done?.(); if (--pending===0) resolveDrained(); });
      } };
      assert.equal(hub.addUiClient(socket,{ deviceId: null,principal,uiProtocolVersion: PROTOCOL_VERSION,close() { assert.fail("snapshot client closed"); } }),true);
    }
    await drained;
    finished=true;
    await heartbeat;
    connects.push(Math.max(...stalls));
  }
  // Every ingest write invalidates list caches. Broadcasting one root must not rebuild the
  // installation's summaries again for each distinct reader, including on archived detail.
  const campaignHub=new Hub(db);
  let completed=0;
  for (let dashboard=0;dashboard<4;dashboard++) campaignHub.addUiClient({ send(data) {
    if (JSON.parse(data).complete) completed++;
  } },{ principal: dashboard===0 ? principal : { ...principal,actorId: `synthetic-reader-${dashboard}`,
    userId: `synthetic-reader-${dashboard}`,localBootstrap: false },deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,
    close() { assert.fail("campaign client closed"); } });
  while (completed<4) await new Promise<void>((resolve) => setImmediate(resolve));
  const campaign=db.getSession("s-0")!;
  const broadcastLatency: number[]=[];
  const broadcastStalls: number[]=[];
  let broadcastsFinished=false;
  const broadcastHeartbeat=(async () => {
    while (!broadcastsFinished) {
      const start=performance.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      broadcastStalls.push(performance.now()-start);
    }
  })();
  for (let repeat=0;repeat<20;repeat++) {
    db.raw().prepare("UPDATE sessions SET updated_at=updated_at+1 WHERE id='s-0'").run();
    const start=performance.now();
    campaignHub.sessionChanged(campaign,false);
    broadcastLatency.push(performance.now()-start);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  broadcastsFinished=true;
  await broadcastHeartbeat;
  db.raw().prepare("UPDATE sessions SET archived=1").run();
  const archivedStart=performance.now();
  assert.equal(db.campaignRequestsForPrincipal(principal,"s-0",true)?.human,1);
  const archivedCampaignRequestMs=performance.now()-archivedStart;
  const results={ hydrationMs: Number(hydrationMs.toFixed(3)),encodingMs: Number(encodingMs.toFixed(3)),sessions: 2000,samples: latency.length,restP95Ms: percentile(latency,.95),coldRestP95Ms: percentile(coldLatency,.95),restBytes,
    fourDashboardMaxEventLoopStallMs: Number(Math.max(...connects).toFixed(3)),
    fourDashboardP95Ms: percentile(connects,.95),snapshotBytes: snapshotBytes/10,maxFrameBytes,bufferCap: MAX_UI_BUFFERED_BYTES,
    campaignBroadcastPrincipals: 4,campaignBroadcastSamples: broadcastLatency.length,
    campaignBroadcastMaxMs: Number(Math.max(...broadcastLatency).toFixed(3)),campaignBroadcastP95Ms: percentile(broadcastLatency,.95),
    campaignBroadcastMaxEventLoopStallMs: Number(Math.max(...broadcastStalls).toFixed(3)),
    archivedCampaignRequestMs: Number(archivedCampaignRequestMs.toFixed(3)) };
  console.log(JSON.stringify(results,null,2));
  assert.ok(results.restP95Ms<50,"REST p95 must remain under 50ms");
  assert.ok(results.coldRestP95Ms<50,"invalidated REST p95 must remain under 50ms");
  assert.ok(results.fourDashboardMaxEventLoopStallMs<50,"four dashboard connects must not stall the event loop over 50ms");
  assert.ok(maxFrameBytes<=MAX_UI_BUFFERED_BYTES);
  assert.ok(results.campaignBroadcastMaxMs<50,"four-principal campaign broadcasts must remain under 50ms");
  assert.ok(results.campaignBroadcastMaxEventLoopStallMs<50,"campaign writes and broadcasts must not stall the event loop over 50ms");
  assert.ok(results.archivedCampaignRequestMs<50,"one archived campaign's counts must remain under 50ms");
} finally {
  await app.close();
  db.close();
  rmSync(root,{ recursive: true,force: true });
}
