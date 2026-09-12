import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_SERVICE,
  LEGACY_CONTROL_PLANE_SERVICE,
  PROTOCOL_VERSION,
  type HostAdminCheck,
  type HostAdminDoctorView,
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
  /** Doctor inputs (optional so status-only callers stay unchanged). */
  doctor?: {
    /** Probe the configured public origin's /healthz from this host. */
    probePublicOrigin(origin: string): Promise<PublicOriginProbe>;
    /** Active or pending runner credentials still minted from the legacy fleet token. */
    legacyRunnerCredentials(): number;
    /** CONTROL_PLANE_TOKEN is still the well-known development default. */
    defaultLegacyToken: boolean;
    /** Tailscale IPv4 addresses present on this host. */
    tailnetAddresses(): string[];
  };
}

export interface PublicOriginProbe {
  reachable: boolean;
  /** The `service` marker the origin answered with, when it answered with JSON. */
  service: string | null;
  detail: string;
}

/** Default probe: GET <origin>/healthz with a short timeout; never throws. */
export async function probePublicOriginWithFetch(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicOriginProbe> {
  try {
    const response = await fetchImpl(`${origin.replace(/\/+$/u, "")}/healthz`, { method: "GET", signal: AbortSignal.timeout(5_000), redirect: "manual" });
    if (!response.ok) return { reachable: true, service: null, detail: `HTTP ${response.status}` };
    let service: string | null = null;
    let unusable = false;
    try {
      const body = JSON.parse(await response.text()) as { service?: unknown };
      if (typeof body.service === "string") {
        // The origin is operator-configured but could be hijacked; only a short printable marker
        // is ever echoed back into an operator's terminal.
        if (/^[A-Za-z0-9._-]{1,64}$/u.test(body.service)) service = body.service;
        else unusable = true;
      }
    } catch {
      service = null;
    }
    return {
      reachable: true,
      service,
      detail: service ? `answered as ${service}` : unusable ? "answered with an unusable service marker" : "answered without a service marker",
    };
  } catch (error) {
    return { reachable: false, service: null, detail: (error as Error).message };
  }
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

function check(id: string, status: HostAdminCheck["status"], summary: string, extra: { detail?: string; remedy?: string } = {}): HostAdminCheck {
  return { id, status, summary, ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.remedy ? { remedy: extra.remedy } : {}) };
}

/**
 * Turn the status facts into pass/warn/fail checks with remedies. Warnings never clear `ok`;
 * only `fail` does. Every check is content-free: paths and versions, never credentials.
 */
export async function hostAdminDoctor(deps: HostAdminRouteDeps, appVersion: string = APP_RELEASE_VERSION): Promise<HostAdminDoctorView> {
  const status = hostAdminStatus(deps);
  const checks: HostAdminCheck[] = [];
  checks.push(check("control-plane", "pass", `${status.service} ${status.appVersion} responding (protocol v${status.protocolVersion})`));
  checks.push(status.database.ready
    ? check("database", "pass", `database readable and writable at ${status.database.path}`)
    : check("database", "fail", `database is not readable and writable at ${status.database.path}`, { remedy: "check CONTROL_PLANE_DB, the directory's ownership, and free disk space; the service account must own the file" }));
  checks.push(status.artifactStore.ready
    ? check("artifact-store", "pass", `artifact store writable at ${status.artifactStore.path}`)
    : check("artifact-store", "fail", `artifact store is not a writable directory at ${status.artifactStore.path}`, { remedy: "create the directory owned by the service account or set CONTROL_PLANE_ARTIFACT_DIR" }));
  checks.push(status.localCredential.safe
    ? check("local-credential", "pass", `local bootstrap credential file is private at ${status.localCredential.path}`)
    : check("local-credential", "fail", "local bootstrap credential file is unsafe", { detail: status.localCredential.issues.join("; "), remedy: `chmod 0600 and chown to the service account: ${status.localCredential.path}` }));
  checks.push(status.dashboard.webServed
    ? check("dashboard-bundle", "pass", "web dashboard bundle is served")
    : check("dashboard-bundle", "warn", "no web dashboard bundle is served; pairing links will not open a dashboard in a browser", { remedy: "set WOLLIPOG_WEB_DIST to a built apps/web/dist, or place a web/ directory beside the packaged executable" }));

  const bindBeyondLoopback = status.bind.boundBeyondLoopback;
  const httpsOrigin = status.publicOrigin?.startsWith("https://") === true;
  if (status.bind.tailnetOnly && deps.doctor && deps.doctor.tailnetAddresses().length === 0) {
    checks.push(check("exposure", "fail", "CONTROL_PLANE_TAILNET_ONLY is set but this host has no Tailscale IPv4 address", { remedy: "start Tailscale on this host or unset CONTROL_PLANE_TAILNET_ONLY" }));
  } else if (deps.publicOriginWarning) {
    checks.push(check("exposure", "warn", "public origin uses plain HTTP beyond loopback", { detail: deps.publicOriginWarning, remedy: "publish the dashboard over HTTPS (Tailscale Serve or a TLS reverse proxy) and set CONTROL_PLANE_PUBLIC_ORIGIN to that https:// origin" }));
  } else if (bindBeyondLoopback && !httpsOrigin) {
    checks.push(check("exposure", "warn", `bound to ${status.bind.host}:${status.bind.port} beyond loopback without an HTTPS public origin`, { detail: "pairing tokens and session data travel unencrypted to remote browsers, and the desktop app refuses plain HTTP to non-loopback, non-Tailscale addresses", remedy: "bind to 127.0.0.1 behind Tailscale Serve or a TLS reverse proxy and set CONTROL_PLANE_PUBLIC_ORIGIN, or set CONTROL_PLANE_TAILNET_ONLY=1" }));
  } else if (!bindBeyondLoopback && !status.publicOrigin) {
    checks.push(check("exposure", "pass", "loopback only; no remote exposure configured", { detail: "remote browsers and the desktop app need Tailscale Serve or an HTTPS reverse proxy plus CONTROL_PLANE_PUBLIC_ORIGIN" }));
  } else {
    checks.push(check("exposure", "pass", status.publicOrigin ? `remote clients use ${status.publicOrigin}` : `bound to ${status.bind.host}:${status.bind.port}${status.bind.tailnetOnly ? " (tailnet only)" : ""}`));
  }

  if (status.publicOrigin && deps.doctor) {
    const probe = await deps.doctor.probePublicOrigin(status.publicOrigin);
    if (!probe.reachable) {
      checks.push(check("public-origin", "warn", `${status.publicOrigin} did not answer from this host`, { detail: probe.detail, remedy: "verify Tailscale Serve or the reverse proxy forwards to 127.0.0.1:" + status.bind.port + " (a host may legitimately be unable to reach its own tailnet name; confirm from another device)" }));
    } else if (probe.service && probe.service !== CONTROL_PLANE_SERVICE && probe.service !== LEGACY_CONTROL_PLANE_SERVICE) {
      checks.push(check("public-origin", "fail", `${status.publicOrigin} answers as a different service (${probe.service})`, { remedy: "point CONTROL_PLANE_PUBLIC_ORIGIN at the origin that proxies this control plane" }));
    } else if (!probe.service) {
      checks.push(check("public-origin", "warn", `${status.publicOrigin} answered without the control-plane health marker`, { detail: probe.detail, remedy: "make sure the proxy forwards /healthz, /api, /ui, and /runner to this control plane" }));
    } else {
      checks.push(check("public-origin", "pass", `${status.publicOrigin} reaches this control plane`));
    }
  }

  if (status.runners.registered === 0) {
    checks.push(check("runners", "warn", "no runner is registered", { remedy: "install a colocated runner with `wollipog service install` or issue a credential with `wollipog admin runner-credential issue`" }));
  } else if (status.runners.online === 0) {
    checks.push(check("runners", "warn", `${status.runners.registered} runner(s) registered, none online`, { remedy: "check the runner service: `wollipog service status` / `wollipog service logs runner`" }));
  } else {
    checks.push(check("runners", "pass", `${status.runners.online} of ${status.runners.registered} runner(s) online`));
  }
  for (const runner of status.runners.items) {
    if (runner.protocolVersion !== null && runner.protocolVersion !== status.protocolVersion) {
      checks.push(check(`runner-protocol:${runner.runnerId}`, "warn", `runner ${runner.runnerId} speaks protocol v${runner.protocolVersion}, control plane v${status.protocolVersion}`, { remedy: "upgrade the older side so features negotiate at the current protocol" }));
    }
    if (runner.version && runner.version !== appVersion) {
      checks.push(check(`runner-version:${runner.runnerId}`, "warn", `runner ${runner.runnerId} is version ${runner.version}, control plane ${appVersion}`, { remedy: "upgrade the runner and control plane together" }));
    }
  }

  if (deps.doctor) {
    const legacy = deps.doctor.legacyRunnerCredentials();
    if (legacy > 0 && deps.doctor.defaultLegacyToken && bindBeyondLoopback) {
      checks.push(check("legacy-credentials", "fail", `${legacy} runner credential(s) still derive from the default development token while the control plane is reachable beyond loopback`, { remedy: "rotate them: `wollipog admin runner-credential rotate --runner <id> --output <token-file>`" }));
    } else if (legacy > 0) {
      checks.push(check("legacy-credentials", "warn", `${legacy} legacy runner credential(s) remain`, { remedy: "rotate them with `wollipog admin runner-credential rotate` so every runner uses a runner-specific credential" }));
    } else {
      checks.push(check("legacy-credentials", "pass", "no legacy runner credentials"));
    }
  }
  checks.push(check("devices", "pass", `${status.devices.paired} paired device(s)`, status.devices.paired === 0 ? { detail: "pair a browser or the desktop app with `wollipog admin device create --name <name>`" } : {}));

  return {
    generatedAt: deps.now?.() ?? Date.now(),
    ok: checks.every((item) => item.status !== "fail"),
    checks,
    status,
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
  // `GET /api/admin/doctor` (protocol v117+): same boundary as status, plus remedies.
  app.get("/api/admin/doctor", async (req, reply) => {
    if (!deps.localBootstrapPrincipal(req)) return reply.code(403).send({ error: HOST_ADMIN_FORBIDDEN });
    reply.header("cache-control", "no-store");
    return hostAdminDoctor(deps);
  });
}
