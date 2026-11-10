import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { runProfileRootMetadataHelper } from "./provider-home-lease-io.js";

type Component = "manager_root" | "profiles_root";
const REASONS = new Set(["private", "repaired", "symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable", "unsafe_ancestry", "unsupported_acl", "unsupported_platform", "unsupported_layout", "identity_changed", "may_have_changed"]);
interface Inspection { ok: boolean; component: Component | "os_home"; reason: string; repairable: boolean; identity?: string }
export const profileRootUsage = "profile-root inspect|repair [--component manager_root|profiles_root] [--json]";

export interface ProfileRootCliHost {
  home: string;
  platform: NodeJS.Platform;
  interactive: boolean;
  confirm(prompt: string): Promise<string>;
  run(operation: "inspect" | "repair", home: string, component: Component, identity?: string): unknown;
}
export function defaultProfileRootCliHost(env: NodeJS.ProcessEnv,
  terminal = { inputTTY: Boolean(process.stdin.isTTY), outputTTY: Boolean(process.stdout.isTTY) }): ProfileRootCliHost {
  return {
    home: homedir(), platform: process.platform, interactive: terminal.inputTTY && terminal.outputTTY && !env.WOLLIPOG_SESSION_ID,
    async confirm(prompt) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { return await input.question(prompt); } finally { input.close(); }
    },
    run: runProfileRootMetadataHelper,
  };
}
function inspection(value: unknown): Inspection {
  const row = value as Partial<Inspection> | null;
  if (!row || typeof row.ok !== "boolean" || typeof row.repairable !== "boolean" ||
    (row.component !== "manager_root" && row.component !== "profiles_root" && row.component !== "os_home") || !REASONS.has(row.reason ?? "") ||
    (row.identity !== undefined && (typeof row.identity !== "string" || !/^[0-9:-]{1,319}$/u.test(row.identity)))) {
    throw new Error("Profile root metadata response could not be verified.");
  }
  return { ok: row.ok, component: row.component, reason: row.reason!, repairable: row.repairable,
    ...(row.identity === undefined ? {} : { identity: row.identity }) };
}
function publicInspection(value: Inspection): Omit<Inspection, "identity"> {
  return { ok: value.ok, component: value.component, reason: value.reason, repairable: value.repairable };
}

/** Local operator interface: no --yes flag, remote control-plane mutation or durable grant.
 * Each repair prompts for the exact inspected component and snapshot in the same process. */
export async function runProfileRootCli(args: string[], host: ProfileRootCliHost,
  io: { stdout(text: string): void; stderr(text: string): void }): Promise<number> {
  const operation = args[1];
  let component: Component = "manager_root";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i] === "--component" && (args[i + 1] === "manager_root" || args[i + 1] === "profiles_root")) {
      component = args[++i] as Component; continue;
    }
    io.stderr(`${profileRootUsage}\n`); return 2;
  }
  if (operation !== "inspect" && operation !== "repair") { io.stderr(`${profileRootUsage}\n`); return 2; }
  if (host.platform !== "linux") {
    io.stdout(`${JSON.stringify({ ok: false, component, reason: "unsupported_platform", repairable: false })}\n`);
    io.stderr("Profile root maintenance is unsupported on this platform. Preserve the directories and request operator guidance.\n"); return 1;
  }
  if (operation === "repair" && !host.interactive) {
    io.stderr("Repair requires a person in a local interactive terminal. Inspect is available without confirmation.\n"); return 2;
  }
  let mutationAttempted = false;
  try {
    const before = inspection(host.run("inspect", host.home, component));
    if (operation === "inspect") { io.stdout(`${JSON.stringify(publicInspection(before))}\n`); return before.ok ? 0 : 1; }
    if (before.ok && before.reason === "private" && before.component === component && !before.repairable) {
      io.stdout(`${JSON.stringify(publicInspection(before))}\n`); return 0;
    }
    if (!before.repairable || before.reason !== "group_or_other_write" || before.component !== component || !before.identity) {
      io.stdout(`${JSON.stringify(publicInspection(before))}\n`);
      io.stderr("This component cannot be repaired automatically. Preserve its contents and request operator guidance.\n"); return 1;
    }
    const expected = `repair ${component}`;
    const snapshot = createHash("sha256").update(before.identity).digest("hex").slice(0, 16);
    const answer = await host.confirm(`Remove only group/other write permission from ${component}? Contents are preserved. Snapshot: ${snapshot}. Type '${expected}': `);
    if (answer !== expected) { io.stderr("Repair cancelled.\n"); return 1; }
    mutationAttempted = true;
    const after = inspection(host.run("repair", host.home, component, before.identity));
    io.stdout(`${JSON.stringify(publicInspection(after))}\n`);
    if (after.reason === "may_have_changed") io.stderr("Permissions may have changed. Preserve the directories and request operator guidance; do not replay or roll back automatically.\n");
    return after.ok && after.reason === "repaired" && after.component === component ? 0 : 1;
  } catch {
    if (mutationAttempted) {
      io.stdout(`${JSON.stringify({ ok: false, component, reason: "may_have_changed", repairable: false })}\n`);
      io.stderr("Permissions may have changed. Preserve the directories and request operator guidance; do not replay or roll back automatically.\n");
    } else io.stderr("Profile root metadata could not be verified. Preserve the directories and request operator guidance.\n");
    return 1;
  }
}
