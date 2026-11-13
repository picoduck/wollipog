/** A clean checkout inspected for the person-only Campaign Status retirement action. */
export interface CampaignWorktreeRetirementState {
  worktreeId: string;
  path: string;
  registeredBranch: string;
  branch: string;
  headSha: string;
  clean: true;
  /** Opaque directory generation; prevents confirmation from following a replacement path. */
  pathIdentity: string;
}
