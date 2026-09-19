import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type GovernancePolicy,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

test("HTTP agent management scopes descendants and composes governance policy visibility", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "descendant-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  const seed = ControlPlaneDb.open(database);
  let childReportSeq = 0;
  let grandchildReportSeq = 0;
  try {
    const local = seed.localIdentityContext();
    seed.createIdentityMember({ userId: "other-user", displayName: "Other", organizationId: local.organizationId, role: "operator", now: 1 });
    seed.createIdentityMember({ userId: "policy-admin", displayName: "Policy Admin", organizationId: local.organizationId, role: "admin", now: 1 });
    seed.createIdentityMember({ userId: "inactive-user", displayName: "Inactive", organizationId: local.organizationId, role: "operator", now: 1 });
    seed.updateIdentityMember({ userId: "inactive-user", displayName: "Inactive", organizationId: local.organizationId, role: "operator", status: "suspended", now: 2 });
    for (const userId of [local.userId, "policy-admin", "other-user"]) {
      seed.createDevice({ id: `device-${userId}`, name: "Policy Test", tokenHash: hashToken(`device-${userId}`), userId, organizationId: local.organizationId, now: 2 });
    }
    for (const [policyId, ownerUserId, organizationId, question] of [
      ["fixture-global", undefined, undefined, false],
      ["fixture-same-org", undefined, local.organizationId, false],
      ["fixture-foreign-org", undefined, "foreign-org", false],
      ["fixture-owner-question", local.userId, local.organizationId, true],
      ["fixture-admin-question", "policy-admin", local.organizationId, true],
      ["fixture-other-question", "other-user", local.organizationId, true],
      ["fixture-inactive-question", "inactive-user", local.organizationId, true],
      ["fixture-foreign-question", "other-user", "foreign-org", true],
      ["fixture-unscoped-owner-question", local.userId, undefined, true],
      ["fixture-unscoped-admin-question", "policy-admin", undefined, true],
    ] as const) {
      seed.upsertGovernancePolicy({ policyId, name: policyId, enabled: true, effect: "allow", priority: 1,
        scope: organizationId ? { organizationId } : {}, ownerUserId,
        ...(question ? { questionRule: { headerPattern: "Test", answer: { option: "Proceed" } } } : {}),
      }, 2);
    }
    seed.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    seed.createSession({ id: "policy-agent", runnerId: "r", workspaceId: null, agentId: null, title: "Policy Agent", useWorktree: false, driver: "codex", config: {},
      scope: { organizationId: local.organizationId, owner: { kind: "organization", organizationId: local.organizationId } }, now: 2 });
    for (const mode of ["normal", "orchestrator"]) {
      for (const [suffix, parent] of [["", undefined], ["-child", mode], ["-grandchild", `${mode}-child`], ["-hidden", mode]] as const) {
        seed.createSession({ id: mode + suffix, parentSessionId: parent, runnerId: "r", workspaceId: null,
          agentId: null, title: mode + suffix, useWorktree: false, driver: "codex",
          config: mode === "orchestrator" && suffix === "" ? { permissionMode: "orchestrator" } : {},
          scope: { organizationId: local.organizationId, owner: { kind: "user", userId: suffix === "-hidden" ? "other-user" : local.userId } }, now: 2 });
        seed.updateSessionStatus(mode + suffix, "idle", 3);
      }
    }
    seed.createSession({
      id: "orchestrator-provider",
      runnerId: "r",
      workspaceId: null,
      agentId: null,
      title: "orchestrator-provider",
      useWorktree: false,
      driver: "codex",
      config: { permissionMode: "orchestrator" },
      orchestratorPolicy: resolveOrchestratorCampaignPolicy(
        DEFAULT_ORCHESTRATOR_DEFAULTS,
        "system_default",
        { execution: { strictProjectIsolation: false } },
      ),
      scope: {
        organizationId: local.organizationId,
        owner: { kind: "user", userId: local.userId },
      },
      now: 2,
    });
    childReportSeq = seed.appendEvent("orchestrator-child", {
      kind: "agent_message", text: "Campaign route report", final: true,
    }, 4).seq;
    grandchildReportSeq = seed.appendEvent("orchestrator-grandchild", {
      kind: "agent_message", text: "Nested campaign route report", final: true,
    }, 4).seq;
  } finally { seed.close(); }
  let logs = "";
  let liveDb: ControlPlaneDb | null = null;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database, CONTROL_PLANE_TOKEN: "descendant-fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  try {
    const deadline = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch {}
      await delay(50);
    }
    assert.ok(healthy, logs);
    liveDb = ControlPlaneDb.open(database);
    for (const mode of ["normal", "orchestrator", "orchestrator-provider", "orchestrator-child", "policy-agent"]) {
      liveDb.updateSessionStatus(mode, "running", Date.now());
      assert.equal(liveDb.setAgentControlCredential(mode, "r", hashToken(`token-${mode}`), Date.now()), true);
    }
    const settleStatus = async (sessionId: string, status: "idle") => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          liveDb!.updateSessionStatus(sessionId, status, Date.now());
          return;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("database is locked") || attempt === 49) throw error;
          await delay(20);
        }
      }
    };
    const policies = async (token: string, agent?: string) => fetch(`http://127.0.0.1:${port}/api/governance/policies`, {
      signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer ${token}`,
        ...(agent ? { [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: agent } : {}) },
    });
    const assertPolicies = async (token: string, expected: string[], agent?: string) => {
      const response = await policies(token, agent);
      assert.equal(response.status, 200);
      const result = (await response.json() as { policies: GovernancePolicy[] }).policies;
      assert.deepEqual(result.map((p) => p.policyId).sort(), [...expected, "builtin:session-spawn-human-gate"].sort());
    };
    const ordinary = ["fixture-global", "fixture-same-org", "fixture-foreign-org"];
    const humanQuestions = ["fixture-owner-question", "fixture-admin-question", "fixture-other-question"];
    const ownerDb = ControlPlaneDb.open(database);
    const ownerId = ownerDb.localIdentityContext().userId;
    ownerDb.close();
    await assertPolicies(`device-${ownerId}`, [...ordinary, ...humanQuestions, "fixture-unscoped-owner-question"]);
    await assertPolicies("device-policy-admin", [...ordinary, ...humanQuestions, "fixture-unscoped-admin-question"]);
    assert.equal((await policies("device-other-user")).status, 403, "ordinary human global-route admission is preserved");
    assert.equal((await policies("token-normal", "normal")).status, 403, "user-scoped ordinary agents do not gain global routes");
    await assertPolicies("token-policy-agent", ordinary, "policy-agent");
    await assertPolicies("token-orchestrator", ["fixture-global", "fixture-same-org"], "orchestrator");
    const providerOwnWorktree = await fetch(
      `http://127.0.0.1:${port}/api/sessions/orchestrator-provider/worktrees`,
      {
        method: "POST",
        signal: AbortSignal.timeout(3000),
        headers: {
          authorization: "Bearer token-orchestrator-provider",
          [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: "orchestrator-provider",
          "content-type": "application/json",
        },
        body: JSON.stringify({ branch: "fix/provider-self" }),
      },
    );
    assert.equal(providerOwnWorktree.status, 409,
      "provider-mode Orchestrator self-worktrees pass immutable policy and reach runner admission");
    for (const mode of ["normal", "orchestrator"]) {
      const request = (target: string, operation: string, body: unknown, method = "POST") => fetch(
        `http://127.0.0.1:${port}/api/sessions/${target}${operation ? `/${operation}` : ""}`, {
          method, signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer token-${mode}`,
            [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: mode, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        });
      const other = mode === "normal" ? "orchestrator" : "normal";
      if (mode === "normal") {
        assert.equal((await request(mode, "descendant-requests", undefined, "GET")).status, 401,
          "ordinary agent credentials never gain Parent Control routes");
        assert.equal((await request(mode, "orchestrator-campaign", undefined, "GET")).status, 401,
          "ordinary agent credentials never gain campaign management routes");
      } else {
        const campaignResponse = await request(mode, "orchestrator-campaign", undefined, "GET");
        assert.equal(campaignResponse.status, 200, "the exact Orchestrator credential can inspect its campaign");
        assert.equal((await request(`${mode}-child`, "orchestrator-campaign", undefined, "GET")).status, 403,
          "an Orchestrator credential cannot inspect a campaign under a descendant identity");
        const followUp = await request(mode, "orchestrator-campaign/follow-ups", {
          originSessionId: `${mode}-child`, repository: "picoduck/wollipog", title: "Bounded Follow-Up",
        });
        assert.equal(followUp.status, 201);
        const duplicateFollowUp = await request(mode, "orchestrator-campaign/follow-ups", {
          originSessionId: `${mode}-grandchild`, repository: "PICODUCK/WOLLIPOG", title: " bounded   follow-up ",
        });
        assert.equal(duplicateFollowUp.status, 201);
        assert.equal((await duplicateFollowUp.json() as { duplicate: boolean }).duplicate, true,
          "campaign follow-up deduplication is enforced at the authenticated HTTP boundary");
        assert.equal((await request(mode, "orchestrator-campaign/follow-ups", {
          originSessionId: `${mode}-hidden`, repository: "picoduck/wollipog", title: "Hidden Follow-Up",
        })).status, 404, "a campaign credential cannot record a follow-up from a hidden child");
        assert.equal((await request(mode, "orchestrator-campaign/verify-child", {
          childSessionId: `${mode}-hidden`, reportEventSeq: 1, followUpsAccounted: true,
        })).status, 404, "a campaign credential cannot verify a hidden child");
        assert.equal((await request(mode, "parent-control", { mode: "questions" })).status, 401,
          "agent credentials cannot enable their own Parent Control");
        const humanRequest = (operation: string, body: unknown) => fetch(
          `http://127.0.0.1:${port}/api/sessions/${mode}/${operation}`, {
            method: "POST", signal: AbortSignal.timeout(3000),
            headers: { authorization: `Bearer device-${ownerId}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        const humanGet = (operation: string) => fetch(
          `http://127.0.0.1:${port}/api/sessions/${mode}/${operation}`, {
            signal: AbortSignal.timeout(3000),
            headers: { authorization: `Bearer device-${ownerId}` },
          });
        assert.equal((await humanRequest("parent-control", { mode: "questions" })).status, 200,
          "the owning human can enable Parent Control");
        assert.equal((await humanRequest("parent-control-policy", { expectedRevision: 0, decisions: {
          implementation_question: "orchestrator",
          pr_merge: "human",
          merged_branch_deletion: "human",
          follow_up_issue_publication: "human",
          ui_evidence_approval: "human",
        } })).status, 200, "only the owning human can delegate one typed category");
        const childRequest = (operation: string, body: unknown, method = "POST") => fetch(
          `http://127.0.0.1:${port}/api/sessions/${mode}-child/${operation}`, {
            method, signal: AbortSignal.timeout(3000), headers: {
              authorization: `Bearer token-${mode}-child`,
              [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: `${mode}-child`,
              "content-type": "application/json",
            },
            ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
          });
        const snapshot = {
          category: "implementation_question",
          question: "Choose the bounded implementation",
          options: [
            { optionId: "safe", label: "Safe Option" },
            { optionId: "alternative", label: "Alternative Option" },
          ],
          recommendedOptionId: "safe",
        } as const;
        const createdResponse = await childRequest("workflow-decisions", {
          requestId: "implementation-1", resourceKey: "implementation:fixture", resourceSnapshot: snapshot,
        });
        assert.equal(createdResponse.status, 201, "the exact child credential can create a typed decision");
        const created = await createdResponse.json() as { occurrenceId: string };
        // File-based attach: a session credential reaches only its own row, and the answer is
        // metadata only.
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${mode}-evidence`)]);
        const attachBody = { name: "after.png", mimeType: "image/png", data: png.toString("base64") };
        const attached = await childRequest("artifacts/screenshots", attachBody);
        assert.equal(attached.status, 201, "a child attaches an image to its own session");
        const attachedText = await attached.text();
        assert.ok(!attachedText.includes(attachBody.data), "the uploaded bytes are never echoed back");
        const artifact = JSON.parse(attachedText) as Record<string, unknown>;
        assert.equal("data" in artifact, false);
        assert.equal(artifact.sessionId, `${mode}-child`);
        assert.equal(artifact.kind, "screenshot");
        assert.equal(artifact.encoding, "base64");
        assert.equal(artifact.mimeType, "image/png");
        assert.equal(artifact.sizeBytes, png.length);
        assert.equal(artifact.sha256, createHash("sha256").update(png).digest("hex"),
          "the digest an agent cites is the control plane's digest of the stored bytes");
        assert.deepEqual(artifact.createdBy, { kind: "agent", id: `${mode}-child` });
        // End to end through the real CLI process: bytes travel file -> CLI -> route -> blob store,
        // and the only thing the command prints is metadata. The environment is rebuilt rather than
        // inherited so a WOLLIPOG_* variable from a hosting session cannot stand in for the fixture's.
        const capturePath = join(root, `${mode}-cli-capture.png`);
        const cliPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${mode}-cli-capture`)]);
        writeFileSync(capturePath, cliPng);
        const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WOLLIPOG_")));
        const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
          const attach = spawn(
            process.execPath,
            ["--import", "tsx", "apps/runner/src/cli.ts", "--wollipog-cli", "artifact", "attach", "--file", capturePath, "--json"],
            {
              cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
              env: {
                ...cliEnv,
                WOLLIPOG_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
                WOLLIPOG_TOKEN: `token-${mode}-child`,
                WOLLIPOG_SESSION_ID: `${mode}-child`,
              },
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          );
          let stdout = "";
          let stderr = "";
          attach.stdout?.on("data", (chunk) => (stdout += String(chunk)));
          attach.stderr?.on("data", (chunk) => (stderr += String(chunk)));
          attach.on("close", (code) => done({ code, stdout, stderr }));
        });
        assert.equal(cli.code, 0, cli.stderr || cli.stdout);
        assert.ok(!cli.stdout.includes(cliPng.toString("base64")) && !cli.stderr.includes(cliPng.toString("base64")),
          "the command prints no file content");
        const printed = (JSON.parse(cli.stdout) as { artifact: Record<string, unknown> }).artifact;
        assert.deepEqual(Object.keys(printed).sort(),
          ["artifactId", "kind", "mediaType", "name", "sessionId", "sha256", "sizeBytes"]);
        assert.equal(printed.sessionId, `${mode}-child`);
        assert.equal(printed.mediaType, "image/png");
        assert.equal(printed.name, `${mode}-cli-capture.png`);
        assert.equal(printed.sha256, createHash("sha256").update(cliPng).digest("hex"));
        assert.ok(liveDb!.readWorkflowArtifactBytes(String(printed.artifactId))?.equals(cliPng),
          "the stored artifact holds exactly the file's bytes");
        const storedView = liveDb!.workflowArtifactExportPreflight(String(printed.artifactId))?.artifact;
        assert.deepEqual(
          { sessionId: storedView?.sessionId, kind: storedView?.kind, encoding: storedView?.encoding, mimeType: storedView?.mimeType, sha256: storedView?.sha256 },
          { sessionId: `${mode}-child`, kind: "screenshot", encoding: "base64", mimeType: "image/png", sha256: printed.sha256 },
          "these are exactly the fields the Orchestrator evidence evaluation requires of a cited artifact",
        );
        const childAs = (target: string, body: unknown) => fetch(
          `http://127.0.0.1:${port}/api/sessions/${target}/artifacts/screenshots`, {
            method: "POST", signal: AbortSignal.timeout(3000), headers: {
              authorization: `Bearer token-${mode}-child`,
              [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: `${mode}-child`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        for (const target of [mode, `${mode}-grandchild`, other, "missing"]) {
          assert.equal((await childAs(target, attachBody)).status, 404,
            `a session credential cannot attach to ${target}: not an ancestor, a descendant, a stranger, or nothing`);
        }
        assert.equal((await request(mode, "artifacts/screenshots", attachBody)).status, 401,
          "an Orchestrator credential reviews evidence; the attach route is not on its allowlist");
        assert.equal((await childRequest("artifacts/screenshots", {
          ...attachBody, kind: "patch", encoding: "utf8", sessionId: mode,
        })).status, 201, "kind, encoding, and session in the body are ignored, not honored");
        assert.equal((await childRequest("artifacts/screenshots", {
          ...attachBody, data: Buffer.from("not an image").toString("base64"),
        })).status, 400, "content that does not match its claimed type is rejected");
        assert.equal((await childRequest("artifacts/screenshots", { ...attachBody, mimeType: "image/svg+xml" })).status, 400);
        assert.equal((await childRequest("artifacts/screenshots", { name: "after.png" })).status, 400);
        assert.equal((await humanRequest("artifacts/screenshots", attachBody)).status, 201,
          "a human who can see the session may attach to it");
        await settleStatus(`${mode}-child`, "idle");
        assert.equal((await request(mode, "orchestrator-campaign/verify-child", {
          childSessionId: `${mode}-child`, reportEventSeq: childReportSeq, followUpsAccounted: true,
        })).status, 409, "an unresolved typed decision prevents child verification");
        assert.equal((await childRequest(`workflow-decisions/${created.occurrenceId}`, undefined, "GET")).status, 200);
        assert.equal((await request(`${mode}-child`, `workflow-decisions/${created.occurrenceId}/consume`, {
          resourceSnapshot: snapshot,
        })).status, 403, "an ancestor credential cannot pose as the consuming child");
        const typedRequests = await request(mode, "descendant-requests", undefined, "GET");
        assert.equal(typedRequests.status, 200);
        assert.equal(((await typedRequests.json() as { requests: Array<{ occurrenceId: string }> }).requests)
          .some((candidate) => candidate.occurrenceId === created.occurrenceId), true,
        "the controlling Orchestrator sees only its delegated typed request");
        assert.equal((await request(mode, "descendant-requests/resolve", {
          sessionId: `${mode}-child`, occurrenceId: created.occurrenceId,
          resolution: { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "safe" },
        })).status, 200, "the assigned Orchestrator can resolve the typed category");
        assert.equal((await childRequest(`workflow-decisions/${created.occurrenceId}/consume`, {
          resourceSnapshot: snapshot,
        })).status, 200, "the matching child consumes immediately before the exact action");
        assert.equal((await childRequest(`workflow-decisions/${created.occurrenceId}/consume`, {
          resourceSnapshot: snapshot,
        })).status, 409, "the grant cannot be replayed");

        assert.equal((await humanRequest("parent-control-policy", { expectedRevision: 1, decisions: {
          implementation_question: "human",
          pr_merge: "human",
          merged_branch_deletion: "human",
          follow_up_issue_publication: "human",
          ui_evidence_approval: "human",
        } })).status, 200, "the owning human can take back a typed category");
        const humanCreatedResponse = await childRequest("workflow-decisions", {
          requestId: "implementation-human", resourceKey: "implementation:human", resourceSnapshot: snapshot,
        });
        assert.equal(humanCreatedResponse.status, 201);
        const humanCreated = await humanCreatedResponse.json() as { occurrenceId: string };
        const agentOwnedOnly = await request(mode, "descendant-requests", undefined, "GET");
        assert.equal(((await agentOwnedOnly.json() as { requests: Array<{ occurrenceId: string }> }).requests)
          .some((candidate) => candidate.occurrenceId === humanCreated.occurrenceId), false,
        "agent credentials cannot inspect human-owned typed requests");
        const humanInbox = await humanGet("descendant-requests");
        assert.equal(humanInbox.status, 200);
        assert.deepEqual((await humanInbox.json() as {
          requests: Array<{ occurrenceId: string; responseOwner: string }>;
        }).requests.filter((candidate) => candidate.occurrenceId === humanCreated.occurrenceId)
          .map(({ occurrenceId, responseOwner }) => ({ occurrenceId, responseOwner })), [{
          occurrenceId: humanCreated.occurrenceId,
          responseOwner: "human",
        }], "the authorized human sees the exact human-owned typed request in the parent inbox");
        const humanResolution = await fetch(
          `http://127.0.0.1:${port}/api/sessions/${mode}-child/approve`, {
            method: "POST", signal: AbortSignal.timeout(3000),
            headers: { authorization: `Bearer device-${ownerId}`, "content-type": "application/json" },
            body: JSON.stringify({ requestId: humanCreated.occurrenceId, optionId: "safe" }),
          });
        assert.equal(humanResolution.status, 200);
        assert.equal((await childRequest(`workflow-decisions/${humanCreated.occurrenceId}/consume`, {
          resourceSnapshot: snapshot,
        })).status, 200, "the child consumes the human-owned approval through the same exact snapshot");
        await settleStatus(`${mode}-grandchild`, "idle");
        await settleStatus(`${mode}-child`, "idle");
        assert.equal((await request(mode, "orchestrator-campaign/verify-child", {
          childSessionId: `${mode}-child`, reportEventSeq: childReportSeq, followUpsAccounted: true,
        })).status, 409, "an unfinished nested child prevents its parent from being verified");
        assert.equal((await request(mode, "orchestrator-campaign/verify-child", {
          childSessionId: `${mode}-grandchild`, reportEventSeq: grandchildReportSeq, followUpsAccounted: true,
        })).status, 200, "a nested child can be verified before its parent report");
        assert.equal((await request(mode, "orchestrator-campaign/verify-child", {
          childSessionId: `${mode}-child`, reportEventSeq: childReportSeq, followUpsAccounted: true,
        })).status, 200, "a verified retained descendant permits its parent report to be verified");
        assert.equal((await humanRequest("descendant-requests/resolve", {
          sessionId: `${mode}-child`, occurrenceId: "request", resolution: { action: "dismiss" },
        })).status, 403, "human credentials cannot use the parent-agent resolution route");
        const evidenceCoordinate = { sessionId: `${mode}-child`, occurrenceId: "workflow_missing", evidenceId: "after" };
        assert.equal((await humanRequest("descendant-requests/review-ui-evidence", evidenceCoordinate)).status, 403,
          "human credentials read evidence through the artifact routes, not the Orchestrator delivery route");
        assert.equal((await request(`${mode}-child`, "descendant-requests/review-ui-evidence", evidenceCoordinate)).status, 403,
          "an orchestrator credential cannot read evidence as its descendant");
        assert.equal((await request(mode, "descendant-requests/review-ui-evidence", evidenceCoordinate)).status, 404,
          "evidence is delivered only for an exact pending decision this Orchestrator controls");
        assert.equal((await request(mode, "descendant-requests/review-ui-evidence", {
          ...evidenceCoordinate, evidenceId: "",
        })).status, 400);
        const acknowledgement = { receiptId: "uireceipt_missing", sha256: "a".repeat(64) };
        assert.equal((await humanRequest("descendant-requests/review-ui-evidence/acknowledge", acknowledgement)).status, 403);
        assert.equal((await request(mode, "descendant-requests/review-ui-evidence/acknowledge", acknowledgement)).status, 409,
          "an unknown receipt acknowledges nothing");
        assert.equal((await request(mode, "descendant-requests/review-ui-evidence/acknowledge", {
          ...acknowledgement, sha256: "not-a-digest",
        })).status, 400);
        assert.equal((await request(`${mode}-child`, "descendant-requests", undefined, "GET")).status, 404,
          "an orchestrator credential cannot pose as its descendant");
        assert.equal((await request(mode, "descendant-requests", undefined, "GET")).status, 200,
          "the matching orchestrator credential can inspect its own descendants");
        for (const body of [
          { sessionId: `${mode}-child`, occurrenceId: "bad\nid", resolution: { action: "dismiss" } },
          { sessionId: `${mode}-child`, occurrenceId: "request", resolution: [] },
          { sessionId: `${mode}-child`, occurrenceId: "request", resolution: { action: "answer", answers: [] } },
          { sessionId: `${mode}-child`, occurrenceId: "request", resolution: { action: "approve", optionId: "" } },
        ]) {
          assert.equal((await request(mode, "descendant-requests/resolve", body)).status, 400,
            "malformed Parent Control coordinates and resolutions fail closed");
        }
      }
      for (const target of [mode, other, `${other}-child`, `${mode}-hidden`, "missing"]) {
        for (const operation of ["prompt", "stop", "archive"]) {
          assert.equal((await request(target, operation, { text: "test", archived: true })).status, 404, `${mode} ${operation} ${target}`);
        }
      }
      assert.equal((await request(other, "", undefined, "GET")).status, 200, "authorized reads remain available");
      const target = `${mode}-grandchild`;
      assert.notEqual((await request(target, "prompt", { text: "test" })).status, 404, "grandchild reaches normal admission checks");
      assert.ok((await request(target, "stop", {})).ok);
      assert.equal((await request(target, "archive", { archived: false })).status, 403);
      assert.equal((await request(target, "archive", {})).status, 400);
      const archived = await request(target, "archive", { archived: true });
      assert.equal(archived.status, 202, "archive waits for the preceding Stop to settle");
      assert.equal((await archived.json() as { archived: boolean }).archived, false);
      assert.equal((await request(target, "", undefined, "GET")).status, 200, "archive retains the session");
      const idleArchive = await request(`${mode}-child`, "archive", { archived: true });
      assert.equal(idleArchive.status, mode === "orchestrator" ? 202 : 200);
      assert.equal((await idleArchive.json() as { archived: boolean }).archived, mode !== "orchestrator");
      const ownWorktree = await request(mode, "worktrees", { branch: "fix/self" });
      assert.equal(ownWorktree.status, mode === "orchestrator" ? 403 : 409,
        "strict Orchestrators are refused by immutable policy while ordinary self-worktrees reach runner admission");
      const childWorktree = await request(`${mode}-child`, "worktrees", {});
      assert.equal(childWorktree.status, mode === "normal" ? 404 : 400);
    }
  } finally {
    liveDb?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
        child.kill("SIGKILL"); await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
