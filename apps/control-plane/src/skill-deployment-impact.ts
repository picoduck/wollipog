/**
 * The deployment-impact fence on skill review accepts (#2129). A review's preview reports
 * `deploymentImpact`, the digest of where a new latest version of the skill deploys, and names
 * that impact in its consent. The accept carries the value back as `expectedDeploymentImpact`; when
 * the skill's assignments changed in between, the accept is refused rather than deploying where
 * nobody consented. An accept without the field, from a dashboard that predates the fence, keeps
 * the behavior it had before.
 */
import type { ControlPlaneDb } from "./db.js";

/** The 409 `code` a review dialog recognizes to offer a fresh preview. */
export const DEPLOYMENT_IMPACT_CHANGED_CODE = "deployment_impact_changed";
export const DEPLOYMENT_IMPACT_CHANGED = "Assignments for this skill changed. Preview it again.";

export type DeploymentImpactRefusal = { status: 400 | 409; body: { error: string; code?: string } };

/**
 * Check an accept's `expectedDeploymentImpact` against the skill's current assignments. Call it
 * only when the accept deploys new content, after the route's last `await`, so nothing can change
 * the assignments between this check and the write.
 */
export function deploymentImpactRefusal(db: ControlPlaneDb, skillId: string | null, expected: unknown): DeploymentImpactRefusal | null {
  if (expected === undefined) return null;
  if (typeof expected !== "string" || !expected || expected.length > 100) {
    return { status: 400, body: { error: "expectedDeploymentImpact must be the value the preview reported." } };
  }
  return expected === db.skillDeploymentImpact(skillId).deploymentImpact
    ? null
    : { status: 409, body: { error: DEPLOYMENT_IMPACT_CHANGED, code: DEPLOYMENT_IMPACT_CHANGED_CODE } };
}
