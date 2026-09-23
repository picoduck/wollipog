import type { TargetHarnessInstallation } from "@wollipog/protocol";
import { parseClaudeAuthStatus, parseClaudeHelp } from "./discovery/claude-code.js";
import { interpretCodexAppServerProbe } from "./discovery/codex-app-server.js";
import type { ExecResult } from "./discovery/resolve.js";

type ProbeStatus = Pick<TargetHarnessInstallation,
  "authentication" | "authenticationEvidence" | "capability" | "capabilityEvidence">;

/** Only provider-native, read-only commands are eligible. An arbitrary configured agent keeps
 * unknown status even when it happens to print familiar-looking help or login text. */
export async function probeTargetHarness(
  agentId: string,
  version: string,
  configuredArgs: string[],
  run: (args: string[]) => Promise<ExecResult>,
): Promise<ProbeStatus> {
  if (agentId !== "claude-code" && agentId !== "codex" && agentId !== "codex-exec") {
    return { authentication: "unknown", capability: "unknown" };
  }
  // Configured launch arguments can select a different profile, settings file, or credential
  // source. Only Codex's fixed app-server subcommand leaves the bare CLI status applicable.
  if (configuredArgs.length && !(agentId === "codex" &&
      configuredArgs.length === 1 && configuredArgs[0] === "app-server")) {
    return { authentication: "unknown", capability: "unknown" };
  }

  const capabilityArgs = agentId === "claude-code" ? ["--help"]
    : agentId === "codex" ? ["app-server", "--help"] : null;
  const authArgs = agentId === "claude-code" ? ["auth", "status"] : ["login", "status"];
  const [capabilityResult, authResult] = await Promise.all([
    capabilityArgs ? run(capabilityArgs) : Promise.resolve(null),
    run(authArgs),
  ]);

  let capability: ProbeStatus["capability"] = "unknown";
  if (capabilityResult && capabilityResult.code === 0 && !capabilityResult.timedOut && !capabilityResult.errorCode) {
    if (agentId === "claude-code") {
      const help = parseClaudeHelp(capabilityResult.stdout || capabilityResult.stderr);
      if (help.streamJsonInput && help.permissionModes.includes("acceptEdits")) capability = "verified";
    } else if (interpretCodexAppServerProbe(version, capabilityResult).status === "supported") {
      capability = "verified";
    }
  }

  let authentication: ProbeStatus["authentication"] = "unknown";
  if (!authResult.timedOut && !authResult.errorCode) {
    if (agentId === "claude-code") {
      authentication = parseClaudeAuthStatus(authResult).status;
    } else {
      // Codex has no structured status output. A successful provider-native status message
      // proves local readiness; a generic nonzero exit could be an unsupported command.
      const message = (authResult.stdout || authResult.stderr).trim();
      if (authResult.code === 0 && /^Logged in using [^\r\n\u0000-\u001f\u007f]{1,100}\.?$/u.test(message)) {
        authentication = "authenticated";
      } else if (authResult.code !== 0 && /^Not logged in\.?$/iu.test(message)) {
        authentication = "unauthenticated";
      }
    }
  }
  return {
    authentication,
    ...(authentication !== "unknown" ? {
      authenticationEvidence: agentId === "claude-code" ? "claude-auth-status" as const : "codex-login-status" as const,
    } : {}),
    capability,
    ...(capability === "verified" ? {
      capabilityEvidence: agentId === "claude-code" ? "claude-help" as const : "codex-app-server-help" as const,
    } : {}),
  };
}
