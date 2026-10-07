import React, { useId, useState, type ReactNode } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { runnerDisplay } from "../runners.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { useOptionalStoreSelector } from "../store.js";
import { ExternalLinkIcon, WrenchIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

export const WORKTREE_SETUP_DOCS_URL =
  "https://github.com/picoduck/wollipog/blob/main/docs/worktree-setup.md";

/**
 * The suggestion to add a setup file, once per Project (#1977): one notice above the Sessions list
 * when that Project's tab is open, and a compact info condition in the session notice slot. Neither
 * sits inside a list row.
 */
export function WorktreeSetupNotice({
  projectName,
  generating = false,
  dismissing = false,
  error,
  generateRefusal = null,
  compact = false,
  trailing,
  onGenerate,
  onDismiss,
}: {
  projectName: string;
  generating?: boolean;
  dismissing?: boolean;
  error?: string | null;
  /** Why the signed-in person may not generate the setup file (#1864). Dismissing stays available:
   * it hides the notice for that person only. */
  generateRefusal?: string | null;
  /** The session notice slot's one-line form: the title is its accessible name, and the menu
   * that lists the slot's other conditions shows it. */
  compact?: boolean;
  trailing?: ReactNode;
  onGenerate: () => void;
  onDismiss: () => void;
}) {
  const refusalId = `worktree-setup-refusal-${useId().replace(/:/gu, "")}`;
  const title = `Set Up ${projectName}`;
  return (
    <Notice as="aside" tone="neutral" icon={<WrenchIcon />} ariaLabel={title} title={compact ? undefined : title}
      compact={compact} trailing={trailing}
      dismissLabel="Dismiss Setup Notice" dismissDisabled={generating || dismissing} onDismiss={onDismiss}
      actions={(
        <>
          <BusyButton className="btn sm" busy={generating} progress="Generating the setup file…"
            disabled={dismissing || generateRefusal !== null} onClick={onGenerate}
            title={generateRefusal ?? undefined} aria-describedby={generateRefusal !== null ? refusalId : undefined}>
            Generate Setup File
          </BusyButton>
          <a className="btn ghost sm" href={WORKTREE_SETUP_DOCS_URL} target="_blank" rel="noreferrer">
            Learn More
            <ExternalLinkIcon size={14} />
          </a>
        </>
      )}>
      <p>Add a setup file so new worktrees for this project install dependencies and run setup steps automatically.</p>
      {generateRefusal !== null && <p className="notice-meta" id={refusalId}>{generateRefusal}</p>}
      {error && <p className="notice-error" role="alert">{error}</p>}
    </Notice>
  );
}

/**
 * Generate and Dismiss for the session `worktreeSetupNoticeSessionIds` picked for a Project. Generate
 * writes the file in that session's worktree and then dismisses the suggestion for the Project on the
 * server; `onGenerated` opens the file. A failure reads as one sentence and the raw error goes to the
 * console, since it names runner internals the person cannot act on.
 */
export function useWorktreeSetupSuggestion(
  session: (SessionView & { projectId: string }) | undefined,
  onGenerated: (sessionId: string) => void,
) {
  const api = useApi();
  const machine = useOptionalStoreSelector((state) => {
    if (!session) return "";
    const box = [...state.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId);
    return runnerDisplay(state.runners.get(session.runnerId), box, session.runnerId).name;
  });
  const [generating, setGenerating] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generateRefusal = session ? sessionCommandRefusal(session, "worktreeSetup") : null;
  return {
    generating,
    dismissing,
    error,
    generateRefusal,
    generate: () => {
      if (!session || generating || dismissing || generateRefusal !== null) return;
      setGenerating(true);
      setError(null);
      void api.generateWorktreeSetup(session.id)
        .then(() => api.dismissWorktreeSetupNotice(session.projectId))
        .then(() => onGenerated(session.id))
        .catch((cause: unknown) => {
          console.warn("Generating the worktree setup file failed", cause);
          setError(`Couldn’t read the repository on ${machine || "its machine"}. Check that it’s online, then try again.`);
        })
        .finally(() => setGenerating(false));
    },
    dismiss: () => {
      if (!session || generating || dismissing) return;
      setDismissing(true);
      setError(null);
      void api.dismissWorktreeSetupNotice(session.projectId)
        .catch((cause: unknown) => {
          console.warn("Dismissing the worktree setup notice failed", cause);
          setError("Couldn’t dismiss this suggestion. Try again.");
        })
        .finally(() => setDismissing(false));
    },
  };
}

/** The Sessions view's notice for the open Project tab. */
export function ProjectSetupSuggestion({ session, projectName, trailing, onGenerated }: {
  session: SessionView & { projectId: string };
  projectName: string;
  /** The Sessions list slot's "+N More" (#2221). */
  trailing?: ReactNode;
  onGenerated: (sessionId: string) => void;
}) {
  const setup = useWorktreeSetupSuggestion(session, onGenerated);
  return (
    <WorktreeSetupNotice projectName={projectName} generating={setup.generating} dismissing={setup.dismissing}
      error={setup.error} generateRefusal={setup.generateRefusal} trailing={trailing}
      onGenerate={setup.generate} onDismiss={setup.dismiss} />
  );
}
