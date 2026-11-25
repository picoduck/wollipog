/** What a Google Antigravity session launch may run (#4779), as a small state machine the setup
 * supervisor drives and the interleaving test checks on its own.
 *
 * A check that finds the setup ready verifies one executable: the PATH copy, or a managed copy by
 * its resolved generation path (never the movable `current/agy`). The managed store swaps
 * `current` to an update's candidate before verifying it, so a ready result for that candidate is
 * held as pending, never launchable, until the install commits the activation. A failed commit,
 * a rollback or a recovered activation discards it. Any check that is not ready withdraws
 * everything verified.
 *
 * What is launchable is therefore always the committed generation (or the PATH copy). The store
 * keeps `current` and `previous` through every commit, so a launch that resolves its executable
 * here when it spawns never names a generation a later update removed. */

import { realpathSync } from "node:fs";
import { sep } from "node:path";

export interface VerifiedAntigravityLaunch {
  /** The PATH copy's path, or the managed copy's resolved generation executable. */
  command: string;
  managed: boolean;
  /** When the check's access probe saw the sign-in working: its `session/new` succeeding, before
   * the probe's process and folder were cleaned up. */
  accessObservedAt: number;
}

export class AntigravityLaunchLedger {
  private committed: VerifiedAntigravityLaunch | null = null;
  private pending: VerifiedAntigravityLaunch | null = null;
  private observedAt: number | undefined;

  /** A check settled: `verified` when it found the setup ready, null otherwise. `uncommitted` is
   * the folder of a managed generation whose activation is not committed yet, if any. */
  settle(verified: VerifiedAntigravityLaunch | null, uncommitted: string | null): void {
    if (!verified) {
      this.committed = null;
      this.pending = null;
      this.observedAt = undefined;
      return;
    }
    // The sign-in is the machine's, shared by every copy: any ready check proves it works.
    this.observedAt = verified.accessObservedAt;
    if (verified.managed && uncommitted && insideDirectory(verified.command, uncommitted)) {
      this.pending = verified;
    } else {
      this.committed = verified;
      this.pending = null;
    }
  }

  /** The install committed its activation: the candidate it verified becomes launchable. */
  commit(): void {
    if (this.pending) this.committed = this.pending;
    this.pending = null;
  }

  /** The activation was not committed (rolled back, recovered, or the install ended without it). */
  discard(): void {
    this.pending = null;
  }

  launchable(): VerifiedAntigravityLaunch | null {
    return this.committed;
  }

  /** When the last ready check observed the sign-in working; undefined after a check that was not. */
  accessObservedAt(): number | undefined {
    return this.observedAt;
  }
}

function insideDirectory(path: string, directory: string): boolean {
  const resolved = resolve(directory);
  return path === resolved || path.startsWith(resolved.endsWith(sep) ? resolved : `${resolved}${sep}`);
}

function resolve(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
