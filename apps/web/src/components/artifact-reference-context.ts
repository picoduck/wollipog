import { createContext, type ReactNode } from "react";

/**
 * How an artifact id cited in Markdown renders (#3970). Only an agent reply in a session's transcript
 * provides one; everywhere else the id stays the plain text (or code span) it was written as.
 */
export const ArtifactReferenceContext = createContext<((id: string, code: boolean) => ReactNode) | null>(null);
