import { runnerSupportsProtocol, type ArtifactUploadPreference } from "@wollipog/protocol";
import type { SessionMeta } from "./session-store.js";

/** Awareness only. No file contents, paths, credentials, or external-hosting configuration. */
export function artifactGuidance(meta: Pick<SessionMeta, "driver" | "env" | "context" | "executionTarget" | "orchestrator" | "artifactUploads">,
  controlPlaneProtocolVersion: number | null, platform = process.platform): string {
  const preference: ArtifactUploadPreference = runnerSupportsProtocol(controlPlaneProtocolVersion, "artifactSessionGuidance")
    ? meta.artifactUploads ?? "manual" : "manual";
  const host = !meta.executionTarget || meta.executionTarget.adapter === "host";
  const bridge = meta.context.kind === "native";
  const available = host && bridge && Boolean(meta.env.WOLLIPOG_CLI) &&
    runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionArtifactFileAttach");
  const command = platform === "win32" && meta.context.kind === "native"
    ? '$launcherArgs = @($env:WOLLIPOG_CLI_ARGS | ConvertFrom-Json); & $env:WOLLIPOG_CLI @launcherArgs artifact attach --file <absolute-path> --json'
    : '\"$WOLLIPOG_CLI\" artifact attach --file <absolute-path> --json';
  const mcp = meta.driver === "claude-code" || meta.driver === "pi" && Boolean(meta.env.WOLLIPOG_PI_AGENT_CONTROL_COMMAND) ||
    Boolean(meta.orchestrator) && ["codex", "codex-app-server", "acp"].includes(meta.driver);
  const capability = available
    ? `Private Session artifacts can be viewed remotely by authorized users in Wollipog. Uploads go to private control-plane storage. Attach a file from disk with ${mcp ? "attach_session_artifact (absolute path), or " : ""}${command}. The runner transfers the bytes directly; never base64 media into a tool argument. Images (PNG, JPEG, GIF, WebP) are limited to 8 MiB.${runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionVideoArtifactAttach") ? " MP4 and WebM videos are limited to 32 MiB." : " This control plane does not support video attachment; update it to upload videos."} Cite the returned artifactId, mediaType, sizeBytes, and sha256; keep the exact metadata and reference the artifact in your result.`
    : "Private Session artifacts support remote viewing, but file attachment is unavailable in this harness/execution context or with the connected peer versions. Do not invent an upload command. Ask for a supported host session or peer update if Wollipog hosting is required.";
  const policy = preference === "wollipog_automatic"
    ? "Artifact Uploads: Use Wollipog Automatically. This authorizes uploads of relevant task evidence (such as screenshots or short videos), never arbitrary filesystem files."
    : preference === "external_hosting"
      ? "Artifact Uploads: Use External Hosting. Follow the user's configured external hosting workflow. Do not silently fall back to Wollipog, invent a destination, or provision credentials. If that workflow is missing, request the needed configuration."
      : "Artifact Uploads: Manual (default). Awareness alone does not authorize transferring any file. Upload only when explicitly requested by the user or authorized by applicable project instructions.";
  return `[Wollipog Artifact Guidance]\n${capability}\n${policy} Explicit task and project hosting requirements take precedence. Hosting preference does not grant evidence-review or merge authority, and existing privacy and approval rules still apply. Preference changes apply at the next session launch or resume.\n[/Wollipog Artifact Guidance]`;
}

/** Add an ephemeral Claude instruction while preserving its effective append text. */
export function appendArtifactSystemPrompt(args: readonly string[], guidance: string): string[] {
  const result: string[] = [];
  let existing = "";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--append-system-prompt") existing = args[++index] ?? "";
    else if (arg.startsWith("--append-system-prompt=")) existing = arg.slice("--append-system-prompt=".length);
    else result.push(arg);
  }
  return [...result, "--append-system-prompt", [existing, guidance].filter(Boolean).join("\n\n")];
}
