import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_SERVICE,
  PROTOCOL_VERSION,
  type HostAdminStatusView,
} from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditProtectedCredentialFile } from "./local-device-credential.js";
import { isLoopbackBindHost, isWildcardBindHost } from "./net.js";
import { APP_RELEASE_VERSION } from "./release-version.js";

export const HOST_ADMIN_FORBIDDEN =
  "host administration requires the local control-plane credential over a direct loopback connection";

export interface HostAdminRouteDeps {
  /** Non-null only for the protected bootstrap credential presented over trusted loopback. */
  localBootstrapPrincipal(req: FastifyRequest): unknown | null;
  startedAt: number;
  bind: { host: string; port: number; tailnetOnly: boolean };
  publicOrigin: string | null;
  publicOriginWarning: string | null;
  webServed(): boolean;
  pairingHosts(): string[];
  databasePath: string;
  artifactStorePath: string;
  localCredentialPath: string;
  runners(): Array<{ runnerId: string; status: string; version: string; protocolVersion: number | null }>;
  pairedDeviceCount(): number;
  now?: () => number;
}

function storeReady(path: string, kind: "file" | "directory"): boolean {
  try {
    const stat = statSync(path);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Build the status document; exported so the route body stays a thin auth wrapper. */
export function hostAdminStatus(deps: HostAdminRouteDeps): HostAdminStatusView {
  const now = deps.now?.() ?? Date.now();
  const bindMode = isLoopbackBindHost(deps.bind.host) ? "loopback" : isWildcardBindHost(deps.bind.host) ? "wildcard" : "address";
  const boundBeyondLoopback = bindMode !== "loopback";
  const localCredential = auditProtectedCredentialFile(deps.localCredentialPath);
  const runners = deps.runners();
  const databasePath = resolve(deps.databasePath);
  const artifactStorePath = resolve(deps.artifactStorePath);
  const database = { path: databasePath, ready: storeReady(databasePath, "file") };
  const artifactStore = { path: artifactStorePath, ready: storeReady(artifactStorePath, "directory") };
  const webServed = deps.webServed();
  const warnings: string[] = [];
  if (deps.publicOriginWarning) warnings.push(deps.publicOriginWarning);
  if (boundBeyondLoopback && !deps.publicOrigin && !deps.bind.tailnetOnly) {
    warnings.push("control plane is bound beyond loopback without CONTROL_PLANE_PUBLIC_ORIGIN; pairing links will use plain-HTTP bind addresses");
  }
  if (!webServed) warnings.push("no built web dashboard bundle is served; pairing links will not open a dashboard");
  if (!database.ready) warnings.push(`database is not readable and writable at ${databasePath}`);
  if (!artifactStore.ready) warnings.push(`artifact store is not a writable directory at ${artifactStorePath}`);
  if (!localCredential.safe) warnings.push(`local credential file is unsafe: ${localCredential.issues.join("; ")}`);
  if (runners.length === 0) warnings.push("no runner is registered with this control plane");
  else if (!runners.some((runner) => runner.status === "online")) warnings.push("no registered runner is online");
  for (const runner of runners) {
    if (runner.protocolVersion !== null && runner.protocolVersion !== PROTOCOL_VERSION) {
      warnings.push(`runner ${runner.runnerId} speaks protocol v${runner.protocolVersion}; control plane speaks v${PROTOCOL_VERSION}`);
    }
  }
  return {
    service: CONTROL_PLANE_SERVICE,
    appVersion: APP_RELEASE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    apiVersion: CONTROL_PLANE_API_VERSION,
    health: { ok: true, startedAt: deps.startedAt, uptimeMs: Math.max(0, now - deps.startedAt) },
    bind: {
      host: deps.bind.host,
      port: deps.bind.port,
      mode: bindMode,
      tailnetOnly: deps.bind.tailnetOnly,
      boundBeyondLoopback,
    },
    publicOrigin: deps.publicOrigin,
    dashboard: { webServed, pairingHosts: deps.pairingHosts() },
    database,
    artifactStore,
    localCredential,
    runners: {
      registered: runners.length,
      online: runners.filter((runner) => runner.status === "online").length,
      items: runners,
    },
    devices: { paired: deps.pairedDeviceCount() },
    warnings,
  };
}

/**
 * `GET /api/admin/status`: operational facts for an SSH operator (`wollipog admin status`).
 * LOOPBACK BOOTSTRAP ONLY: ordinary paired-device tokens, even owner-role ones on loopback, are
 * refused so the trusted-loopback administration boundary stays with the protected local file.
 */
export function registerHostAdminRoute(app: FastifyInstance, deps: HostAdminRouteDeps): void {
  app.get("/api/admin/status", async (req, reply) => {
    if (!deps.localBootstrapPrincipal(req)) return reply.code(403).send({ error: HOST_ADMIN_FORBIDDEN });
    reply.header("cache-control", "no-store");
    return hostAdminStatus(deps);
  });
}
