import type { GovernanceActor } from "@wollipog/protocol";
import { humanResolver, resolverName, type ViewerIdentity } from "./resolver-identity.js";

/** The lookups that turn an artifact's author into a name. Each returns undefined when it cannot say. */
export interface ArtifactAuthorNames {
  viewer: ViewerIdentity | null;
  /** The agent's name for a session an agent saved the artifact from. */
  sessionAgent: (sessionId: string) => string | undefined;
}

/**
 * Who saved an artifact, for its meta line and its Run detail row (#2855): the agent's name, "You" or
 * a member's name (#2527), or Wollipog. An agent is recorded by its session's id and a person by
 * their user id, and neither is ever shown: an agent whose session is not loaded is "Agent", and a
 * person the viewer cannot be told about is left unsaid (null).
 */
export function artifactAuthorName(actor: GovernanceActor, names: ArtifactAuthorNames): string | null {
  switch (actor.kind) {
    case "agent": return (actor.id && names.sessionAgent(actor.id)) || "Agent";
    case "human": {
      const resolver = humanResolver(names.viewer, actor.id);
      return resolver ? resolverName(resolver, { titleCase: true }) : null;
    }
    case "policy": return "Policy";
    case "system": return "Wollipog";
  }
}
