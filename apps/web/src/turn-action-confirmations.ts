import type { AgentDriverKind } from "@wollipog/protocol";

/**
 * The copy of the confirmations a turn's actions open (#2185): Edit as a New Turn's Replace Draft,
 * Edit in a Fork, Rewind Files, Fork Conversation and Recover Session. Each names the outcome and
 * the turn as the transcript does, "Turn N", and its confirm button repeats its title's verb
 * (docs/design-system.md §7.4, §17.2).
 */
export interface TurnActionConfirmationCopy {
  title: string;
  message: string;
  confirmLabel: string;
  /** A second line in `--text-dim` under the body, when there is one. */
  note?: string;
}

/** How many characters of a turn's prompt the Rewind Files body quotes. */
export const PROMPT_EXCERPT_LENGTH = 60;

/** The first `PROMPT_EXCERPT_LENGTH` characters of a prompt on one line, with an ellipsis when it
 * goes on, or undefined for a prompt with no text (an image alone). Counts code points, so an
 * emoji is never cut in half. */
export function promptExcerpt(text: string | undefined): string | undefined {
  const line = (text ?? "").replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  const characters = Array.from(line);
  if (characters.length <= PROMPT_EXCERPT_LENGTH) return line;
  return `${characters.slice(0, PROMPT_EXCERPT_LENGTH).join("").trimEnd()}…`;
}

export const REPLACE_DRAFT_CONFIRMATION: TurnActionConfirmationCopy = {
  title: "Replace Draft",
  message: "Your current draft is replaced by this message. You can restore it with Discard Edit.",
  confirmLabel: "Replace Draft",
};

/** The composer notice while a copy of an earlier message is loaded into it. */
export function editingCopyMessage(turn: number | undefined): string {
  return turn === undefined
    ? "Editing a copy of an earlier message. Earlier turns stay as they are."
    : `Editing a copy of your Turn ${turn} message. Earlier turns stay as they are.`;
}

/** `turn` is the edited message's own turn; the fork continues from the turn before it. */
export function editInForkConfirmation(turn: number): TurnActionConfirmationCopy {
  return {
    title: "Edit in a Fork",
    message: `A new session continues from before Turn ${turn} in its own worktree, and this message opens in its composer for you to edit. This session stays as it is.`,
    confirmLabel: "Edit in a Fork",
  };
}

export function rewindFilesConfirmation(turn: number, prompt: string | undefined): TurnActionConfirmationCopy {
  const excerpt = promptExcerpt(prompt);
  return {
    title: "Rewind Files",
    message: `Files go back to how they were before Turn ${turn}${excerpt ? `, “${excerpt}”` : ""}. The conversation isn't rewound, so the agent still remembers later turns.`,
    confirmLabel: "Rewind Files",
  };
}

/** The agents whose provider can fork only after the conversation's latest turn. */
const LATEST_TURN_ONLY_FORK: Partial<Record<AgentDriverKind, string>> = {
  "claude-code": "Claude Code",
  pi: "Pi",
};

export function forkConversationConfirmation(turn: number, driver: AgentDriverKind | undefined): TurnActionConfirmationCopy {
  const latestOnly = driver ? LATEST_TURN_ONLY_FORK[driver] : undefined;
  return {
    title: "Fork Conversation",
    message: `A new session continues from after Turn ${turn} in its own worktree, with the same agent and conversation history. This session stays as it is.`,
    confirmLabel: "Fork Conversation",
    ...(latestOnly ? { note: `${latestOnly} can only fork after the latest turn.` } : {}),
  };
}

/** `fork` continues the provider conversation before the rejected item; `handoff` starts a fresh one
 * from a summary of the turns before it. */
export function recoverSessionConfirmation(turn: number, recovery: "fork" | "handoff"): TurnActionConfirmationCopy {
  const turns = turn === 1 ? "Turn 1" : `Turns 1 to ${turn}`;
  return {
    title: "Recover Session",
    message: recovery === "handoff"
      ? `A new session starts a fresh conversation from a summary of ${turns}, with the files from that turn. This session stays as it is so you can inspect it.`
      : `A new session continues from Turn ${turn}, before the item the provider rejected, with the files from that turn. This session stays as it is so you can inspect it.`,
    confirmLabel: "Recover Session",
  };
}
