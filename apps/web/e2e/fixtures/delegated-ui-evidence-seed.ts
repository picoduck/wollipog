import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import { SessionsService } from "../../../control-plane/src/sessions.js";
import type { Hub } from "../../../control-plane/src/hub.js";

const RUNNER_ID = "delegated-ui-evidence-e2e";
const WORKSPACE_ID = "evidence-workspace";
const AGENT_ID = "image-orchestrator";

/** Seed a real control-plane database. The live HTTP routes and browser use it in the spec. */
export function seedDelegatedUiEvidence(databasePath: string, workspacePath: string) {
  const db = ControlPlaneDb.open(databasePath);
  const runner: RunnerMetadata = {
    runnerId: RUNNER_ID,
    hostname: "test-host",
    os: "linux",
    version: "e2e",
    workspaces: [{ id: WORKSPACE_ID, name: "Evidence E2E", path: workspacePath }],
    agents: [{
      id: AGENT_ID, name: "Image Orchestrator", command: "codex", args: [], env: {},
      driver: "codex-app-server", available: true, context: { kind: "native" },
      capabilities: {
        models: [{ id: "vision", name: "Vision", default: true, inputModalities: ["text", "image"] }],
        effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
        imageToolResults: true, permissionModes: ["default", "orchestrator"],
      },
    }],
  };
  db.registerRunner(runner, Date.now(), PROTOCOL_VERSION);
  const hub = new Proxy({ isRunnerOnline: () => true, sendToRunner: () => true }, {
    get(target, key: string) {
      return key in target ? target[key as keyof typeof target] : () => undefined;
    },
  }) as unknown as Hub;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const ownerUserId = db.localIdentityContext().userId;
  try {
    const parent = svc.createSession({
      runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
      role: "orchestrator", config: { permissionMode: "orchestrator" }, parentControl: "off",
    }, undefined, undefined, false, false, false, { defaultOwnerUserId: ownerUserId });
    if (!parent.ok || !parent.data) throw new Error(parent.error ?? "parent creation failed");
    db.updateSessionStatus(parent.data.id, "running", Date.now());
    const decisions = {
      implementation_question: "human", pr_merge: "human", merged_branch_deletion: "human",
      follow_up_issue_publication: "human", ui_evidence_approval: "orchestrator",
    } as const;
    const policy = svc.setParentControlPolicy(parent.data.id, decisions, 0, { kind: "human", id: ownerUserId });
    if (!policy.ok) throw new Error(policy.error ?? "policy update failed");
    const child = svc.createSession({
      runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, title: "Evidence Child",
    }, undefined, undefined, false, false, false, { parentSessionId: parent.data.id });
    if (!child.ok || !child.data) throw new Error(child.error ?? "child creation failed");
    db.updateSessionStatus(child.data.id, "running", Date.now());
    const bytes = readFileSync(fileURLToPath(new URL("../../public/icons/icon-192.png", import.meta.url)));
    const artifact = svc.createWorkflowArtifact({
      sessionId: child.data.id, kind: "screenshot", name: "evidence.png", mimeType: "image/png",
      encoding: "base64", data: bytes.toString("base64"),
    }, { kind: "agent", id: child.data.id });
    if (!artifact.ok || !artifact.data) throw new Error(artifact.error ?? "artifact creation failed");
    const evidence = { evidenceId: "capture", artifactId: artifact.data.artifactId,
      mediaType: "image/png", sha256: artifact.data.sha256 };
    const decision = svc.createWorkflowDecision(child.data.id, {
      requestId: "delegated-ui-evidence", resourceKey: "delegated-ui-evidence",
      resourceSnapshot: { category: "ui_evidence_approval", evidence: [evidence] },
    });
    if (!decision.ok || !decision.data) throw new Error(decision.error ?? "decision creation failed");
    if (decision.data.authority !== "orchestrator") throw new Error(`unexpected authority: ${decision.data.authority}`);
    const parentToken = "delegated-ui-evidence-parent-token";
    if (!db.setAgentControlCredential(parent.data.id, RUNNER_ID,
      createHash("sha256").update(parentToken).digest("hex"), Date.now())) {
      throw new Error("parent credential binding failed");
    }
    return { parentId: parent.data.id, childId: child.data.id, occurrenceId: decision.data.occurrenceId,
      parentToken, evidence };
  } finally {
    db.close();
  }
}
