/** Best-effort removal of a smoke script's own temporary directory. */
import { rmSync } from "node:fs";

// Windows can keep a just-exited executable locked for a moment, so removal right after the last
// child process may fail with EPERM or EBUSY. rmSync retries those with a linear backoff
// (100 ms, 200 ms, …), roughly 5.5 s in total.
export const temporaryRootRemoval = Object.freeze({ recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/**
 * Remove `root`, retrying transient failures. It never throws, so calling it from a `finally`
 * cannot mask or replace the error that is already propagating. A removal that still fails only
 * warns. Returns whether the directory was removed.
 */
export function removeTemporaryRoot(root, { remove = rmSync, warn = console.warn } = {}) {
  try {
    remove(root, temporaryRootRemoval);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`Warning: could not remove temporary directory ${root}: ${reason}`);
    return false;
  }
}
