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
 *
 * Its progress and error belong to the session they were started for: the Sessions list keeps this
 * hook while the open Project tab changes and while another notice is shown in the suggestion's
 * place (#2221), so a request in flight stays guarded and never shows on another Project.
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
  const [states, setStates] = useState<ReadonlyMap<string, SetupSuggestionState>>(() => new Map());
  const update = (sessionId: string, patch: Partial<SetupSuggestionState>) => setStates((current) => {
    const next = new Map(current);
    next.set(sessionId, { ...(current.get(sessionId) ?? IDLE_SETUP), ...patch });
    return next;
  });
  const { generating, dismissing, error } = (session && states.get(session.id)) || IDLE_SETUP;
  const generateRefusal = session ? sessionCommandRefusal(session, "worktreeSetup") : null;
  return {
    generating,
    dismissing,
    error,
    generateRefusal,
    generate: () => {
      if (!session || generating || dismissing || generateRefusal !== null) return;
      const { id } = session;
      update(id, { generating: true, error: null });
      void api.generateWorktreeSetup(id)
        .then(() => api.dismissWorktreeSetupNotice(session.projectId))
        .then(() => onGenerated(id))
        .catch((cause: unknown) => {
          console.warn("Generating the worktree setup file failed", cause);
          update(id, { error: `Couldn’t read the repository on ${machine || "its machine"}. Check that it’s online, then try again.` });
        })
        .finally(() => update(id, { generating: false }));
    },
    dismiss: () => {
      if (!session || generating || dismissing) return;
      const { id } = session;
      update(id, { dismissing: true, error: null });
      void api.dismissWorktreeSetupNotice(session.projectId)
        .catch((cause: unknown) => {
          console.warn("Dismissing the worktree setup notice failed", cause);
          update(id, { error: "Couldn’t dismiss this suggestion. Try again." });
        })
        .finally(() => update(id, { dismissing: false }));
    },
  };
}

interface SetupSuggestionState {
  generating: boolean;
  dismissing: boolean;
  error: string | null;
}

const IDLE_SETUP: SetupSuggestionState = { generating: false, dismissing: false, error: null };
