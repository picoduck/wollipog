import type { AutomationCreationSnapshot } from "@wollipog/protocol";
import { validateAutomationSpec } from "./automations.js";

/** Shape only. The generic decision route rejects caller-prepared creation snapshots. */
export function normalizeAutomationCreationSnapshot(value: Record<string, unknown>): AutomationCreationSnapshot | null {
  if (Object.keys(value).some((key) => !["category", "spec", "nextFireAt", "targetDigest", "requestedSpecDigest", "expiresAt"].includes(key)) ||
      value.category !== "automation_creation" || !validateAutomationSpec(value.spec).ok ||
      !Number.isSafeInteger(value.nextFireAt) || !Number.isSafeInteger(value.expiresAt) ||
      ![value.targetDigest, value.requestedSpecDigest].every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) return null;
  return structuredClone(value) as unknown as AutomationCreationSnapshot;
}
