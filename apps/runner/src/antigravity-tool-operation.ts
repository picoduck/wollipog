import { isAbsolute } from "node:path";
import { antigravityFileOperationKind, type ApprovalContext } from "@wollipog/protocol";
import { campaignOperationEvidence } from "./campaign-operation-evidence.js";

const FILE_TARGET_KEYS = ["TargetFile", "target_file", "file_path", "path"];
const FILE_ARGUMENT_KEYS = new Set([
  ...FILE_TARGET_KEYS, "toolSummary", "StartLine", "EndLine", "start_line", "end_line",
  "content", "CodeContent", "Overwrite", "old_string", "new_string", "replace_all",
  "TargetContent", "ReplacementContent", "ReplacementChunks", "AllowMultiple",
]);
const COMMAND_ARGUMENT_KEYS = new Set(["CommandLine", "Cwd", "WaitMsBeforeAsync", "toolSummary", "SafeToAutoRun"]);

export function antigravityToolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the effect selectors in agy's ACP extension. The permission request's toolCall is
 * itself the correlated ToolCallUpdate. Titles, rendered content and partial updates cannot
 * supply missing selectors. Keep content arguments out of the normalized operation. */
export function antigravityToolOperation(tool: Record<string, unknown>): ApprovalContext["operation"] {
  if (typeof tool.name !== "string" || !antigravityToolRecord(tool.rawInput)) return undefined;
  const raw = tool.rawInput;
  if (tool.name === "run_command") {
    const { CommandLine: input, Cwd: cwd } = raw;
    if (tool.kind !== "execute" || typeof input !== "string" ||
        (cwd !== undefined && typeof cwd !== "string") ||
        Object.keys(raw).some((key) => !COMMAND_ARGUMENT_KEYS.has(key))) return undefined;
    return { kind: "command", input, ...(cwd !== undefined ? { cwd } : {}) };
  }
  const kind = antigravityFileOperationKind(tool.name);
  if (!kind || tool.kind !== kind || Object.keys(raw).some((key) => !FILE_ARGUMENT_KEYS.has(key))) return undefined;
  const targets = FILE_TARGET_KEYS.map((key) => raw[key]).filter((path) => path !== undefined);
  return targets.length === 1 && typeof targets[0] === "string" ? { kind: "file", path: targets[0] } : undefined;
}

/** Only explicit absolute file paths and working directories can be attested on this ACP path. */
export function antigravityPermissionContext(tool: unknown, sessionRoot: string): ApprovalContext | undefined {
  if (!antigravityToolRecord(tool) || typeof tool.toolCallId !== "string" || !tool.toolCallId ||
      typeof tool.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name)) return undefined;
  const toolName = tool.name;
  const operation = antigravityToolOperation(tool);
  const boundedAbsolutePath = (path: string) =>
    isAbsolute(path) && path.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(path);
  if (operation?.kind === "file" && boundedAbsolutePath(operation.path) &&
      (tool.locations == null || (Array.isArray(tool.locations) && tool.locations.every((location) =>
        antigravityToolRecord(location) && location.path === operation.path)))) {
    return { toolName, operation: campaignOperationEvidence(toolName, operation, sessionRoot) };
  }
  if (operation?.kind === "command" && operation.input.trim() && operation.input.length <= 2000 &&
      (operation.cwd === undefined || boundedAbsolutePath(operation.cwd)) &&
      (tool.locations == null || (Array.isArray(tool.locations) && tool.locations.length === 0))) {
    return { toolName, operation: campaignOperationEvidence(toolName, operation, sessionRoot) };
  }
  return { toolName };
}
