// Reproducible isolated synthetic data. No hosting-stack processes or databases are used.
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "../src/db.js";
import { Hub, MAX_UI_BUFFERED_BYTES, type Socket } from "../src/hub.js";
import { LOCAL_OWNER_USER_ID,PERSONAL_ORGANIZATION_ID,type HumanPrincipal } from "../src/identity.js";

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
    agentId: null,title: `Synthetic Session ${index}`,useWorktree: false,driver: "codex-app-server",config: {},now: index+1 });
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
  const results={ hydrationMs: Number(hydrationMs.toFixed(3)),encodingMs: Number(encodingMs.toFixed(3)),sessions: 2000,samples: latency.length,restP95Ms: percentile(latency,.95),coldRestP95Ms: percentile(coldLatency,.95),restBytes,
    fourDashboardMaxEventLoopStallMs: Number(Math.max(...connects).toFixed(3)),
    fourDashboardP95Ms: percentile(connects,.95),snapshotBytes: snapshotBytes/10,maxFrameBytes,bufferCap: MAX_UI_BUFFERED_BYTES };
  console.log(JSON.stringify(results,null,2));
  assert.ok(results.restP95Ms<50,"REST p95 must remain under 50ms");
  assert.ok(results.coldRestP95Ms<50,"invalidated REST p95 must remain under 50ms");
  assert.ok(results.fourDashboardMaxEventLoopStallMs<50,"four dashboard connects must not stall the event loop over 50ms");
  assert.ok(maxFrameBytes<=MAX_UI_BUFFERED_BYTES);
} finally {
  await app.close();
  db.close();
  rmSync(root,{ recursive: true,force: true });
}
