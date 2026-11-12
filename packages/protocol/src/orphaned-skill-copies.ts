import type {SkillInvocationPolicy} from "./index.js";

export type OrphanedSkillCopyRef =
  | { kind: "kept_aside"; id: string }
  | { kind: "deleted_skill"; name: string; digest: string; variant: SkillInvocationPolicy };

/** One orphaned copy as the Skills view lists it for a machine. */
export interface OrphanedSkillCopy {
  kind: OrphanedSkillCopyRef["kind"];
  /** kept_aside: the runner's opaque store entry id. */
  id?: string;
  /** Skill name; absent only for an unidentified kept-aside copy. */
  name?: string;
  /** Version the copy was published as; absent when the runner did not record it. */
  digest?: string;
  variant?: SkillInvocationPolicy;
  keptAsideAt?: number;
  /** Content digest while the copy is readable skill content. */
  observedDigest?: string;
  /** kept_aside: the fingerprint of every entry, which a discard must name. */
  observedFingerprint?: string;
  /** deleted_skill: the runner's links still serve this copy. */
  held?: boolean;
  /** deleted_skill: when the library deleted the skill with this name; absent when the deletion
   * predates the record, or from an older control plane. */
  skillDeletedAt?: number;
  detail?: string;
  /** kept_aside: the accessible library skill with the copy's name, which an import updates. */
  skillId?: string;
}

