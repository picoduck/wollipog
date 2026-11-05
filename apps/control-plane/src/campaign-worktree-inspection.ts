import { createHash } from "node:crypto";

/** Identify the stored resource without echoing private paths or runner-controlled error text. */
export function inspectionResource(childId: string, path: string, index: number): string {
  const child = childId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 256);
  const fingerprint = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `child ${child}, managed worktree ${index + 1} (path SHA-256 ${fingerprint})`;
}

export function invalidInspectionReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "missing_status";
  const status = value as Record<string, unknown>;
  if (!Number.isSafeInteger(status.changedPathCount) || (status.changedPathCount as number) < 0) {
    return "invalid_changed_path_count";
  }
  if (typeof status.hasChanges !== "boolean") return "invalid_has_changes";
  if (status.hasChanges !== ((status.changedPathCount as number) > 0)) return "inconsistent_change_summary";
  if (!Array.isArray(status.files)) return "missing_file_list";
  if (status.files.some((file: unknown) => !file || typeof file !== "object" ||
      typeof (file as Record<string, unknown>).path !== "string")) return "invalid_file_list";
  if (status.files.length > (status.changedPathCount as number) ||
      (status.files.length < (status.changedPathCount as number) && status.filesTruncated !== true)) {
    return "inconsistent_file_count";
  }
  return null;
}
