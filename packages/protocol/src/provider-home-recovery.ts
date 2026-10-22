/** Specific, content-free causes within the existing providerHomeRefusal contract (#3585). */
export const PROVIDER_HOME_RECOVERY_CAUSES = [
  "holder_alive", "boundary_survivor", "process_survivor", "boundary_unverifiable",
  "process_uninspectable", "process_uninspectable_not_delegated", "invalid_journal",
  "profile_unsupported_control_plane", "profile_grant_limit", "no_reboot_proof",
] as const;
export type ProviderHomeRecoveryCause = typeof PROVIDER_HOME_RECOVERY_CAUSES[number];
export const PROVIDER_HOME_RECOVERY_CAUSE_CODES = {
  holder_alive: "busy", boundary_survivor: "busy", process_survivor: "busy",
  boundary_unverifiable: "unverifiable", process_uninspectable: "unverifiable",
  process_uninspectable_not_delegated: "unverifiable", invalid_journal: "unverifiable",
  profile_unsupported_control_plane: "unverifiable", profile_grant_limit: "unverifiable", no_reboot_proof: "unverifiable",
} as const satisfies Record<ProviderHomeRecoveryCause, "busy" | "unverifiable">;
export function isProviderHomeRecoveryCause(value: unknown): value is ProviderHomeRecoveryCause {
  return typeof value === "string" && (PROVIDER_HOME_RECOVERY_CAUSES as readonly string[]).includes(value);
}

/** Best-effort observation for authorized lease inspection. No command, environment or path.
 * Start time is Linux procfs field 22, not wall time. Absence is never evidence of abandonment. */
export interface ProviderHomeBlockingProcess {
  pid: number;
  startTime?: string;
  kind: "recorded_runner" | "provider_descendant" | "boundary_member" | "uninspectable";
  cgroupMembership: "recorded_boundary" | "outside_recorded_boundary" | "unavailable";
}
export function validProviderHomeBlockingProcess(value: unknown): value is ProviderHomeBlockingProcess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ["pid", "startTime", "kind", "cgroupMembership"].includes(key)) &&
    Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && (v.pid as number) <= 2_147_483_647 &&
    (!Object.hasOwn(v, "startTime") || typeof v.startTime === "string" && /^[1-9][0-9]{0,19}$/u.test(v.startTime)) &&
    ["recorded_runner", "provider_descendant", "boundary_member", "uninspectable"].includes(v.kind as string) &&
    ["recorded_boundary", "outside_recorded_boundary", "unavailable"].includes(v.cgroupMembership as string);
}
