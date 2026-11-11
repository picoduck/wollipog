import { runnerSupportsProtocol, runnerCapabilityRequirementError } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { OwnerManagement } from "./owner-management.js";
export function createOwnerRunnerManagement(db: ControlPlaneDb, hub: Hub) {
  const management = new OwnerManagement();
  management.define("PUT", "/api/runners/:id/capacity", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const principal = req.principal;
    if (!principal || !db.canManageRunner(principal, id)) {
      return reply.code(403).send({ error: "Machine owner or organization admin permission is required" });
    }
    const body = (req.body ?? {}) as { configuredUnits?: unknown; expectedRevision?: unknown };
    if (!Number.isInteger(body.configuredUnits) || (body.configuredUnits as number) < 1 ||
        (body.configuredUnits as number) > 256) {
      return reply.code(400).send({ error: "configuredUnits must be an integer from 1 to 256" });
    }
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
      return reply.code(400).send({ error: "expectedRevision must be a non-negative integer" });
    }
    const runner = db.getRunner(id);
    const boxId = db.boxIdForRunner(id);
    if (!runner && !boxId) return reply.code(404).send({ error: "runner not found" });
    if (runner?.status === "online" && !runnerSupportsProtocol(runner.protocolVersion, "machineRunnerCapacity")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "machineRunnerCapacity", "runner capacity changes"));
    }
    const changed = db.setMachineRunnerCapacity(
      id,
      body.configuredUnits as number,
      body.expectedRevision as number,
      Date.now(),
    );
    if (!changed.ok) {
      return reply.code(409).send({ error: "Runner Capacity changed in another client", current: changed.configuration });
    }
    if (runner?.status === "online") {
      hub.sendToRunner(id, { type: "configure_runner_capacity", ...changed.configuration });
    }
    hub.runnerChanged(id);
    if (boxId) hub.boxChanged(boxId);
    return { capacity: changed.configuration };
  });

  return management;
}
