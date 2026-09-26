import type { SessionCommandPermissions, SessionView } from "@wollipog/protocol";

/** Why the signed-in principal may not run `command` on this session (#1843), or null when it
 * may. A control plane that sends no permissions refuses nothing here, and the server still
 * decides. */
export function sessionCommandRefusal(
  session: Pick<SessionView, "commandPermissions">,
  command: keyof SessionCommandPermissions,
): string | null {
  const permission = session.commandPermissions?.[command];
  return permission && !permission.allowed ? permission.reason : null;
}
