import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { campaignCodeOperationTargets, type ApprovalContext } from "@wollipog/protocol";

/** Metadata only: never opens file contents. Reads require an existing regular file. Only
 * native mutations may place missing targets from a proved directory; dangling links,
 * inaccessible ancestors and excessive depth cannot supply canonical evidence. */
function canonicalTarget(path: string, allowMissing: boolean): string | null {
  if (!isAbsolute(path) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)) return null;
  let current = path;
  const missing: string[] = [];
  for (let depth = 0; depth < 16; depth++) {
    try {
      const resolved = realpathSync.native(current);
      if (missing.length ? !statSync(resolved).isDirectory() : !statSync(resolved).isFile()) return null;
      return join(resolved, ...missing);
    }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try { if (lstatSync(current).isSymbolicLink()) return null; }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null; }
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current)); current = parent;
    }
  }
  return null;
}

/** Provider input can name an operation but cannot attest its physical effect. Only the runner
 * constructs filesystem evidence; unknown selectors and resolution errors keep it absent. */
export function campaignOperationEvidence(toolName: string, operation: NonNullable<ApprovalContext["operation"]>): NonNullable<ApprovalContext["operation"]> {
  const { filesystem: _untrusted, ...concrete } = operation;
  const selectors = campaignCodeOperationTargets(toolName, concrete);
  if (!selectors) return concrete;
  let cwd: string | undefined;
  if (selectors.cwd) {
    try { if (isAbsolute(selectors.cwd) && statSync(selectors.cwd).isDirectory()) cwd = realpathSync.native(selectors.cwd); }
    catch { return concrete; }
  }
  if (selectors.cwd && !cwd) return concrete;
  const targets: Array<{ path: string; resolvedPath: string }> = [];
  const allowMissing = concrete.kind === "file" && ["Write", "Edit", "MultiEdit", "applyPatch", "fileChange"].includes(toolName);
  for (const path of selectors.paths) {
    const located = isAbsolute(path) ? path : selectors.cwd ? join(selectors.cwd, path) : null;
    const resolvedPath = located ? canonicalTarget(located, allowMissing) : null;
    if (!resolvedPath) return concrete;
    targets.push({ path, resolvedPath });
  }
  return { ...concrete, filesystem: { ...(cwd ? { cwd } : {}), targets } };
}

/** Recheck before a parked callback is granted. A replaced link cannot reuse its old evidence. */
export function campaignOperationEvidenceCurrent(toolName: string, operation: NonNullable<ApprovalContext["operation"]>): boolean {
  return !operation.filesystem || JSON.stringify(campaignOperationEvidence(toolName, operation).filesystem) === JSON.stringify(operation.filesystem);
}
