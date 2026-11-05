import {
  LOCATION_SWITCH_LIMITS, LOCATION_SWITCH_TRIGGERS, parseLocationSwitchOption,
  type LocationSwitchCandidate, type LocationSwitchSnapshot,
} from "@wollipog/protocol";

/** Bounds the inspections one request can start, and so the size of its card. */
export const LOCATION_SWITCH_MAX_LOCATIONS = 24;

const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const text = (value: unknown, max = 4096) => typeof value === "string" && value.length <= max;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function place(value: unknown, candidate: boolean): boolean {
  if (!record(value)) return false;
  const allowed = ["locationId", "name", "runnerId", "machineName", "workspaceId", "path", "repository",
    ...(candidate ? ["sameRunner", "actions", "unavailableReason"] : [])];
  return Object.keys(value).every((key) => allowed.includes(key)) &&
    (value.locationId === null && !candidate || bounded(value.locationId, 256)) &&
    ["name", "runnerId", "machineName", "workspaceId", "path"].every((key) => text(value[key])) &&
    (value.repository === undefined && !candidate || text(value.repository, LOCATION_SWITCH_LIMITS.repository)) &&
    (!candidate || typeof value.sameRunner === "boolean" && Array.isArray(value.actions) && value.actions.length <= 2 &&
      value.actions.every((action) => action === "switch" || action === "new_session") &&
      (value.unavailableReason === undefined || text(value.unavailableReason, 1000)));
}

/** Shape only. The generic decision route refuses caller-prepared Location switch snapshots. */
export function normalizeLocationSwitchSnapshot(value: Record<string, unknown>): LocationSwitchSnapshot | null {
  const keys = ["category", "repository", "reason", "handoff", "trigger", "projectId", "projectName", "current", "candidates",
    "unavailable", "options", "targetDigest", "expiresAt"];
  const candidates = Array.isArray(value.candidates) ? value.candidates as LocationSwitchCandidate[] : [];
  const offered = (option: unknown): boolean => {
    if (!record(option)) return false;
    const parsed = parseLocationSwitchOption(option.optionId as string);
    return Object.keys(option).every((key) => ["optionId", "label", "description"].includes(key)) && parsed !== null &&
      bounded(option.label, 200) && (option.description === undefined || text(option.description, 1000)) &&
      candidates.some((candidate) => candidate.locationId === parsed.locationId && candidate.actions.includes(parsed.action));
  };
  const unavailable = (item: unknown): boolean => record(item) &&
    Object.keys(item).every((key) => ["locationId", "name", "machineName", "reason"].includes(key)) &&
    ["locationId", "name", "machineName", "reason"].every((key) => text(item[key]));
  if (Object.keys(value).some((key) => !keys.includes(key)) || value.category !== "location_switch" ||
      !text(value.repository, LOCATION_SWITCH_LIMITS.repository) || !text(value.reason, LOCATION_SWITCH_LIMITS.reason) ||
      !text(value.handoff, LOCATION_SWITCH_LIMITS.handoff) || !LOCATION_SWITCH_TRIGGERS.includes(value.trigger as never) ||
      !bounded(value.projectId, 256) || !text(value.projectName) || !place(value.current, false) ||
      !Array.isArray(value.candidates) || value.candidates.length > LOCATION_SWITCH_MAX_LOCATIONS ||
      !value.candidates.every((candidate) => place(candidate, true)) ||
      !Array.isArray(value.unavailable) || value.unavailable.length > LOCATION_SWITCH_MAX_LOCATIONS || !value.unavailable.every(unavailable) ||
      !Array.isArray(value.options) || value.options.length < 1 || value.options.length > LOCATION_SWITCH_MAX_LOCATIONS * 2 ||
      !value.options.every(offered) ||
      new Set(value.options.map((option) => (option as { optionId: string }).optionId)).size !== value.options.length ||
      typeof value.targetDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.targetDigest) ||
      !Number.isSafeInteger(value.expiresAt)) return null;
  return structuredClone(value) as unknown as LocationSwitchSnapshot;
}
