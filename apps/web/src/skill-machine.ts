import {
  runnerSupportsProtocol,
  type MachineSkillCandidate,
  type RunnerProtocolCapability,
  type RunnerView,
} from "@wollipog/protocol";
import { ApiError } from "./api.js";
import { accountLabelText } from "./personal-identifiers.js";
import type { MachineSkillPreview } from "./skills.js";

/**
 * Words and compatibility for Import from Machine (#1963). Compatibility is decided here, from
 * `runnerSupportsProtocol`; the dialog shows only its outcome, never a runner protocol number (§17.2).
 */

const SNAPSHOT_CAPABILITY: Record<RunnerView["os"], RunnerProtocolCapability> = {
  linux: "machineSkillSnapshots",
  macos: "nativeMacosMachineSkillSnapshots",
  windows: "nativeWindowsMachineSkillSnapshots",
};

/** Whether this machine's runner can list and read skill folders at all. */
export function runnerCanImportSkills(runner: Pick<RunnerView, "os" | "protocolVersion">): boolean {
  const capability = SNAPSHOT_CAPABILITY[runner.os];
  return capability !== undefined && runnerSupportsProtocol(runner.protocolVersion, capability);
}

/** Where a folder lives, without transport paths: account, WSL distro, then the folder itself. */
export function machineSkillLocation(
  entry: Pick<MachineSkillCandidate, "name" | "sourceDirectory" | "providerAccountId" | "context">,
  runner?: Pick<RunnerView, "providerAccounts">,
  hideAccountEmails = true,
): string {
  const account = entry.providerAccountId
    ? accountLabelText(runner?.providerAccounts?.find((candidate) => candidate.id === entry.providerAccountId)?.label ?? "Provider Account", undefined, hideAccountEmails)
    : null;
  return `${account ? `Account: ${account} · ` : ""}${entry.context?.kind === "wsl" ? `WSL: ${entry.context.distro} · ` : ""}${entry.sourceDirectory}/${entry.name}`;
}

export type MachineSkillResult = MachineSkillPreview["disposition"];

/**
 * How the dialog names the library version a folder matches. A preview's `identical` always means
 * the skill's latest version, and versions are not numbered yet, so every phrase says "latest".
 * This is the one place to change when versions get numbers (#1962, #1984): "v3", "Matches v3".
 */
export const MATCHED_VERSION = {
  /** After "Matches" in a folder row. */
  short: "Latest",
  /** In a sentence. */
  phrase: "the latest version",
  /** In a Title Case label. */
  title: "the Latest Version",
} as const;

/** What importing a reviewed folder does, as its row says it. */
export const MACHINE_SKILL_RESULT_LABEL: Record<MachineSkillResult, string> = {
  new: "New Skill",
  update: "New Version",
  identical: `Matches ${MATCHED_VERSION.short}`,
};
/** The same result in the review's facts. */
export const MACHINE_SKILL_RESULT_FACT: Record<MachineSkillResult, string> = {
  new: "New Skill",
  update: "New Version",
  identical: `Matches ${MATCHED_VERSION.title}`,
};
export const MATCHING_FOLDER_TITLE = `This Folder Matches ${MATCHED_VERSION.title}`;
export const MATCHING_FOLDER_REASON = `This folder matches ${MATCHED_VERSION.phrase}; there is nothing to import.`;
/** A folder whose name is a library skill's, not yet reviewed: it is a new version or a match. */
export const MACHINE_SKILL_IN_LIBRARY_LABEL = "In Library";

/**
 * A folder row's result. A reviewed folder shows what its preview found; before that, a name the
 * library does not have is a new skill, and any other name is only known to be in the library
 * (the discovery list carries no digests, and reading every folder would take a runner read each).
 */
export function machineSkillRowResult(
  name: string,
  reviewed: MachineSkillResult | undefined,
  libraryNames: ReadonlySet<string>,
): string {
  if (reviewed) return MACHINE_SKILL_RESULT_LABEL[reviewed];
  return libraryNames.has(name) ? MACHINE_SKILL_IN_LIBRARY_LABEL : MACHINE_SKILL_RESULT_LABEL.new;
}

/** The footer primary names the result (§7.3). */
export function machineSkillImportLabel(result: MachineSkillResult | undefined): string {
  return result === "new" ? "Import as New Skill" : result === "update" ? "Import as New Version" : "Import Skill";
}

/** Why the adoption safety check refuses, one sentence each. */
export function adoptionBlockerText(blocker: string): string {
  return ({
    library_skill_missing: "The skill is not in the library.",
    executable_mode_adoption_unsupported: "The folder has executable files, and a link cannot keep them executable yet. You can still import it.",
    effective_assignment_missing: "The skill is not turned on for a compatible agent on this machine.",
    assigned_version_mismatch: "The assigned version does not match this folder.",
    library_version_invalid: "The assigned library version failed validation.",
    source_not_targeted: "No assigned agent reads this folder.",
    invocation_unsupported: "An assigned agent does not support the skill's invocation setting.",
    manual_variant_adoption_unsupported: "Manual invocation variants cannot be linked, because their deployed content may differ.",
    shared_invocation_conflict: "Agents sharing this folder need different invocation variants.",
    wsl_account_adoption_unsupported: "Account-scoped WSL folders can be imported, but not replaced with a link.",
    provider_account_scope_unavailable: "This account's skill folder is not available on the machine right now.",
  } as Record<string, string>)[blocker] ?? `The safety check failed: ${blocker.replaceAll("_", " ")}.`;
}

/** An advisory from the safety check, which does not block the link. */
export function adoptionAdvisoryText(advisory: string): string {
  return ({
    manual_variant_may_change_content: "An agent here uses manual invocation, so what it reads after the link may differ from this folder.",
  } as Record<string, string>)[advisory] ?? advisory.replaceAll("_", " ");
}

/**
 * A request failure in the dialog's words. A capability refusal, which the server marks with the
 * required runner protocol version, becomes the runner-update sentence naming this machine; so
 * does any other failure that mentions runner protocol numbers, which the dialog never shows
 * (§17.2).
 */
export function userFacingMachineError(cause: unknown, machineName: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const capabilityRefusal = cause instanceof ApiError &&
    typeof cause.details?.requiredRunnerProtocolVersion === "number";
  return capabilityRefusal || /\bprotocol\b/i.test(message)
    ? `${machineName} needs a runner update to do this.`
    : message;
}

/**
 * One machine request at a time. The server serves a single machine request and refuses a second,
 * and a request keeps running after whatever started it has gone, so each request starts only
 * after the one before it has settled, whether that one succeeded or failed. `pending` counts the
 * requests queued or running, and `subscribe` hears it change, so a caller can hold its controls.
 */
export function createRequestQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const listeners = new Set<() => void>();
  const changed = (by: 1 | -1) => {
    pending += by;
    for (const listener of [...listeners]) listener();
  };
  return {
    run<T>(request: () => Promise<T>): Promise<T> {
      changed(1);
      const run = tail.then(request);
      tail = run.catch(() => undefined);
      return run.finally(() => changed(-1));
    },
    pending: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * The page's one queue for machine skill requests. The server's lock is not per dialog, and a
 * request outlives the dialog that started it: cancelling Import from Machine mid-read and opening
 * it again must wait for that read, not meet it.
 */
export const machineRequestQueue = createRequestQueue();
