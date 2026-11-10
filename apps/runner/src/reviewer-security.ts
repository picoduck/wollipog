import type { ReviewerSecurityPolicy, RunnerReviewerSecurityConfiguration } from "@wollipog/protocol";

/** Only registered control-plane messages reach this state, never session env or project files. */
export class ReviewerSecurity {
  private configuration: RunnerReviewerSecurityConfiguration = { policy: "strict", revision: -1 };

  get policy(): ReviewerSecurityPolicy { return this.configuration.policy; }

  /** A new connection's registration is authoritative, including record resets or older peers. */
  register(value?: RunnerReviewerSecurityConfiguration): boolean {
    const previous = this.policy;
    this.configuration = { policy: "strict", revision: -1 };
    if (value) this.apply(value);
    return this.policy !== previous;
  }

  apply(value: RunnerReviewerSecurityConfiguration): boolean {
    if ((value.policy !== "strict" && value.policy !== "personal_machine") ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        value.revision <= this.configuration.revision) return false;
    const changed = value.policy !== this.configuration.policy;
    this.configuration = { policy: value.policy, revision: value.revision };
    return changed;
  }
}
