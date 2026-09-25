/**
 * Correlated read and confirmed restore of one drifted skill store copy (protocol v183), and read and
 * confirmed discard of one copy a restore kept aside (protocol v185).
 *
 * Callers serialize these with reconciliation and store GC. Only runner-owned store content is read,
 * replaced, or deleted; no harness link is touched here. A successful restore or discard is followed
 * by an ordinary reconciliation pass, which releases any hold and converges links to the desired state.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  validSkillName,
  type SkillDriftMessage,
  type SkillDriftResultMessage,
  type SkillFile,
  type SkillKeptAsideMessage,
  type SkillKeptAsideResultMessage,
} from "@wollipog/protocol";
import { manualInvocationVariantFiles } from "@wollipog/protocol/skill-invocation";
import {
  containedInStore,
  existingSkillStoreRoot,
  treeContainsSymlink,
  validateSkillSyncEntry,
  writeSkillVersionTree,
} from "./skills.js";
import { manualCopyMatches, manualVariantDigest, readStoreSkillCopy, storeCopyMatches } from "./skill-store-copy.js";
import {
  KEPT_ASIDE_ID,
  keptAsideDirectory,
  keptAsideStamps,
  observeKeptAsideCopy,
  removeKeptAsideRecord,
  reviewedContents,
  removeKeptAsideTree,
  sameKeptAsideStamps,
  writeKeptAsideRecord,
  type KeptAsideRemovalHooks,
} from "./skill-kept-aside.js";

const DIGEST = /^[0-9a-f]{64}$/;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 200);
}

function existsInStore(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realDirectoryInside(path: string, storeRoot: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && containedInStore(realpathSync(path), storeRoot);
  } catch {
    return false;
  }
}

/** A Manual Only copy is verified against its agent-invocation sibling. When an older runner left
 * the sibling missing, publish it from the verified library files so the pair verifies again. An
 * existing sibling, clean or edited, is never replaced here. */
function restoreMissingSibling(storeRoot: string, siblingDir: string, files: SkillFile[], log?: (message: string) => void): void {
  try {
    lstatSync(siblingDir);
    return;
  } catch {
    // Absent: publish it below.
  }
  const staged = join(storeRoot, `.tmp-${randomUUID()}`);
  try {
    writeSkillVersionTree(staged, files);
    renameSync(staged, siblingDir);
  } catch (error) {
    log?.(`could not republish a missing agent-invocation skill copy: ${errorText(error)}`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export function handleSkillDrift(options: {
  message: SkillDriftMessage;
  runnerId: string;
  dataDir: string;
  log?: (message: string) => void;
  /** Test seams around the swap and the removal. */
  hooks?: {
    beforeQuarantine?: () => void;
    beforeDiscard?: (quarantine: string) => void;
    removal?: KeptAsideRemovalHooks;
  };
}): SkillDriftResultMessage {
  const { message } = options;
  const reply = (value: Omit<SkillDriftResultMessage, "type" | "runnerId" | "requestId">): SkillDriftResultMessage => ({
    type: "skill_drift_result",
    runnerId: options.runnerId,
    requestId: message.requestId,
    ...value,
  });
  const reject = (error: string) => reply({ status: "rejected", error });
  if (message.runnerId !== options.runnerId) return reject("The drift command targeted a different runner.");
  const { name, digest, variant, operation } = message;
  if (typeof name !== "string" || !validSkillName(name) || typeof digest !== "string" || !DIGEST.test(digest) ||
      (variant !== "agent" && variant !== "manual") || (operation !== "read" && operation !== "restore")) {
    return reject("The drift command is invalid.");
  }
  let libraryFiles: SkillFile[] | undefined;
  if (operation === "restore") {
    if (message.confirmation !== "explicit") return reject("Restoring the library version requires explicit confirmation.");
    if (message.observedDigest !== null && (typeof message.observedDigest !== "string" || !DIGEST.test(message.observedDigest))) {
      return reject("The drift command is invalid.");
    }
    if (message.files !== undefined) {
      const invalid = validateSkillSyncEntry({ name, versionDigest: digest, files: message.files, targets: [] });
      if (invalid) return reject(`The library version failed validation: ${invalid}.`);
      libraryFiles = message.files;
    }
  }

  let storeRoot: string;
  try {
    storeRoot = existingSkillStoreRoot(options.dataDir);
  } catch {
    return reject("The skill store is unavailable.");
  }
  const dirName = variant === "manual" ? `${digest}-manual` : digest;
  const nameDir = join(storeRoot, name);
  const copyDir = join(nameDir, dirName);
  if (!realDirectoryInside(nameDir, storeRoot) || !realDirectoryInside(copyDir, storeRoot)) {
    return reply({ status: "not_needed" });
  }

  // A Manual Only copy is verified against the transform of the library files, else of its clean
  // agent-invocation sibling, else by reversing the transform exactly.
  const copy = readStoreSkillCopy(copyDir);
  const siblingDir = join(nameDir, digest);
  const sibling = variant === "manual" && !libraryFiles ? readStoreSkillCopy(siblingDir) : undefined;
  const clean = variant === "agent"
    ? storeCopyMatches(copy, digest)
    : manualCopyMatches(copy, digest, libraryFiles ??
      (sibling?.readable && storeCopyMatches(sibling, digest) ? sibling.files : undefined));
  if (clean) {
    if (operation === "restore" && libraryFiles && variant === "manual") restoreMissingSibling(storeRoot, siblingDir, libraryFiles, options.log);
    return reply({ status: "not_needed" });
  }

  if (operation === "read") {
    if (!copy.readable) return reject(`The edited copy cannot be read as skill content: ${copy.reason}.`);
    return reply({ status: "read", files: copy.files, observedDigest: copy.digest });
  }

  const observed = copy.readable ? copy.digest : null;
  if (observed !== message.observedDigest) {
    return reject("The edited copy changed after it was reviewed. Refresh the machine state and review it again.");
  }
  // The quarantine name is outside both the skill-name and `.tmp-` namespaces, so store GC never
  // reclaims it: if restoring the previous name ever fails, the edited copy is still there. Whatever
  // stays there is reported as a kept-aside copy, identified by the record written before the move.
  const quarantineId = randomUUID();
  const quarantine = keptAsideDirectory(storeRoot, quarantineId);
  let staged: string | undefined;
  try {
    if (libraryFiles) {
      staged = join(storeRoot, `.tmp-${randomUUID()}`);
      const published = variant === "manual" ? manualInvocationVariantFiles(libraryFiles) : libraryFiles;
      writeSkillVersionTree(staged, published);
      if (!storeCopyMatches(readStoreSkillCopy(staged), variant === "manual" ? manualVariantDigest(libraryFiles) : digest)) {
        throw new Error("the staged library version did not verify");
      }
    }
    options.hooks?.beforeQuarantine?.();
    writeKeptAsideRecord(storeRoot, quarantineId, { name, digest, variant, keptAsideAt: Date.now() });
    renameSync(copyDir, quarantine);
    // Staging takes time and a harness may still write to the copy until it moves. Only the exact
    // reviewed bytes may be replaced; anything newer goes back untouched.
    const moved = readStoreSkillCopy(quarantine);
    if ((moved.readable ? moved.digest : null) !== message.observedDigest) {
      renameSync(quarantine, copyDir);
      removeKeptAsideRecord(storeRoot, quarantineId);
      if (staged) rmSync(staged, { recursive: true, force: true });
      return reject("The edited copy changed after it was reviewed. Refresh the machine state and review it again.");
    }
    if (staged) {
      try {
        renameSync(staged, copyDir);
        staged = undefined;
      } catch (error) {
        renameSync(quarantine, copyDir);
        throw error;
      }
    }
  } catch (error) {
    if (staged) rmSync(staged, { recursive: true, force: true });
    if (!realDirectoryInside(copyDir, storeRoot) && realDirectoryInside(quarantine, storeRoot)) {
      options.log?.(`skill ${name}: the edited copy ${dirName} could not be moved back and is preserved at ${quarantine}`);
    } else if (!existsInStore(quarantine)) {
      removeKeptAsideRecord(storeRoot, quarantineId);
    }
    return reject(`Restoring the library version failed: ${errorText(error)}.`);
  }
  options.log?.(`skill ${name}: ${libraryFiles ? "replaced" : "discarded"} the edited store copy ${dirName} after explicit confirmation`);
  if (libraryFiles && variant === "manual") restoreMissingSibling(storeRoot, join(nameDir, digest), libraryFiles, options.log);
  options.hooks?.beforeDiscard?.(quarantine);
  if (message.observedDigest === null) {
    // An unreadable copy has no content identity to fence on, so a later change to it could not
    // be told apart: it stops being served but is kept aside rather than deleted.
    options.log?.(`skill ${name}: the unreadable edited copy ${dirName} was moved aside to ${quarantine}`);
    return reply({ status: "restored" });
  }
  const stamps = keptAsideStamps(quarantine);
  const discarded = readStoreSkillCopy(quarantine);
  const settled = keptAsideStamps(quarantine);
  if ((discarded.readable ? discarded.digest : null) !== message.observedDigest ||
      !stamps || !settled || !sameKeptAsideStamps(stamps, settled)) {
    // A writer that still held a file open wrote after the swap: keep those bytes.
    options.log?.(`skill ${name}: the replaced copy changed after the swap and is preserved at ${quarantine}`);
    return reply({ status: "restored" });
  }
  try {
    if (treeContainsSymlink(quarantine)) {
      options.log?.(`skill ${name}: retained the discarded copy for inspection because it contains a symlink`);
    } else {
      // Every entry is checked against the verified state immediately before it is removed, so a write
      // that lands during the removal is kept aside with whatever was not yet removed.
      removeKeptAsideTree(quarantine, settled, {
        ...options.hooks?.removal,
        ...(discarded.readable ? { contents: reviewedContents(discarded.files) } : {}),
      });
      removeKeptAsideRecord(storeRoot, quarantineId);
    }
  } catch (error) {
    options.log?.(`skill ${name}: could not remove the discarded copy, which is preserved at ${quarantine}: ${errorText(error)}`);
  }
  return reply({ status: "restored" });
}

/** Read or discard one copy a restore kept aside. A discard needs explicit confirmation and deletes
 * the copy only while it still matches the reviewed observation: the change fingerprint of every
 * entry, and for a copy that is readable skill content, also its content digest. The removal
 * re-verifies each entry against that verified state immediately before removing it. */
export function handleSkillKeptAside(options: {
  message: SkillKeptAsideMessage;
  runnerId: string;
  dataDir: string;
  log?: (message: string) => void;
  /** Test seams between the fence check and the removal, and inside the removal. */
  hooks?: { beforeRemove?: (dir: string) => void; removal?: KeptAsideRemovalHooks };
}): SkillKeptAsideResultMessage {
  const { message } = options;
  const reply = (value: Omit<SkillKeptAsideResultMessage, "type" | "runnerId" | "requestId">): SkillKeptAsideResultMessage => ({
    type: "skill_kept_aside_result",
    runnerId: options.runnerId,
    requestId: message.requestId,
    ...value,
  });
  const reject = (error: string) => reply({ status: "rejected", error });
  if (message.runnerId !== options.runnerId) return reject("The kept-aside copy command targeted a different runner.");
  const { id, operation } = message;
  if (typeof id !== "string" || !KEPT_ASIDE_ID.test(id) || (operation !== "read" && operation !== "discard")) {
    return reject("The kept-aside copy command is invalid.");
  }
  if (operation === "discard") {
    if (message.confirmation !== "explicit") return reject("Discarding a kept-aside copy requires explicit confirmation.");
    const digest = message.observedDigest;
    const fingerprint = message.observedFingerprint;
    if (typeof fingerprint !== "string" || !DIGEST.test(fingerprint) ||
        (digest !== undefined && (typeof digest !== "string" || !DIGEST.test(digest)))) {
      return reject("The kept-aside copy command is invalid.");
    }
  }
  let storeRoot: string;
  try {
    storeRoot = existingSkillStoreRoot(options.dataDir);
  } catch {
    return reject("The skill store is unavailable.");
  }
  const dir = keptAsideDirectory(storeRoot, id);
  if (!realDirectoryInside(dir, storeRoot)) return reply({ status: "not_found" });
  // The content digest is trusted only for the entry state stamped on both sides of the read.
  const { copy, stamps: settled, fingerprint } = observeKeptAsideCopy(dir);
  if (operation === "read") {
    if (!copy.readable) return reject(`The kept-aside copy cannot be read as skill content: ${copy.reason}.`);
    if (!fingerprint) return reject("The kept-aside copy changed while it was read. Try again.");
    return reply({ status: "read", files: copy.files, observedDigest: copy.digest, observedFingerprint: fingerprint });
  }
  if (!settled || fingerprint !== message.observedFingerprint ||
      (copy.readable ? copy.digest : undefined) !== message.observedDigest) {
    return reject("The kept-aside copy changed after it was reviewed. Refresh the machine state and review it again.");
  }
  options.hooks?.beforeRemove?.(dir);
  try {
    removeKeptAsideTree(dir, settled, {
      ...options.hooks?.removal,
      ...(copy.readable ? { contents: reviewedContents(copy.files) } : {}),
    });
  } catch (error) {
    options.log?.(`skill store: could not remove the kept-aside copy .drift-${id}: ${errorText(error)}`);
    return reject(`The kept-aside copy could not be removed completely: ${errorText(error)}. Refresh the machine state to see what remains.`);
  }
  removeKeptAsideRecord(storeRoot, id);
  options.log?.(`skill store: discarded the kept-aside copy .drift-${id} after explicit confirmation`);
  return reply({ status: "discarded" });
}
