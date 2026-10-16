import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { MEDIA_REVIEWER_TOOLS } from "../evidence-review-namespace.js";

/** Installed schema inspection is offline; never initialize App Server, load an account, or
 * infer an allowlist from open-ended config. This plan is not a provider launch authorization. */
export interface InstalledCodexMediaSdk {
  executable: string;
  version: string;
  executableSha256: string;
  threadStartSchema: unknown;
  threadStartSchemaSha256: string;
}
export type CodexMediaPreflight = { supported: false;
  reason: "installed_contract_mismatch" | "dynamic_tools_unavailable" | "builtin_tool_allowlist_unavailable";
  executableSha256?: string; schemaSha256?: string;
  requiredTools: readonly string[] };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function preflightInstalledCodexMediaSdk(sdk: InstalledCodexMediaSdk): CodexMediaPreflight {
  const refuse = (reason: CodexMediaPreflight["reason"], verified = false): CodexMediaPreflight => ({
    supported: false, reason, requiredTools: MEDIA_REVIEWER_TOOLS,
    ...(verified ? { executableSha256: sdk.executableSha256, schemaSha256: sdk.threadStartSchemaSha256 } : {}),
  });
  try {
    if (!/^0\.162\.1$/u.test(sdk.version) || realpathSync(sdk.executable) !== sdk.executable ||
      !statSync(sdk.executable).isFile() || hash(readFileSync(sdk.executable)) !== sdk.executableSha256 ||
      hash(JSON.stringify(sdk.threadStartSchema)) !== sdk.threadStartSchemaSha256 ||
      !object(sdk.threadStartSchema) || sdk.threadStartSchema.title !== "ThreadStartParams" ||
      !object(sdk.threadStartSchema.properties)) return refuse("installed_contract_mismatch");
    const tools = sdk.threadStartSchema.properties.dynamicTools;
    if (!object(tools) || !object(tools.items) || tools.items.$ref !== "#/definitions/DynamicToolSpec") {
      return refuse("dynamic_tools_unavailable", true);
    }
    // 0.162.1 supplies dynamic tools alongside built-ins. Its schema does not establish any
    // audited complete built-in-tool suppression contract. Configuration's additionalProperties
    // and a caller-invented schema field cannot turn this installation into a restricted driver.
    // Keep this explicit refusal until a supported installed contract is independently audited.
    return refuse("builtin_tool_allowlist_unavailable", true);
  } catch { return refuse("installed_contract_mismatch"); }
}
