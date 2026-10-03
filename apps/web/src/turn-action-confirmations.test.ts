import assert from "node:assert/strict";
import { test } from "node:test";
import {
  editInForkConfirmation,
  editingCopyMessage,
  forkConversationConfirmation,
  promptExcerpt,
  recoverSessionConfirmation,
  REPLACE_DRAFT_CONFIRMATION,
  rewindFilesConfirmation,
  type TurnActionConfirmationCopy,
} from "./turn-action-confirmations.js";

/** The confirm button repeats the title's verb (docs/design-system.md §17.2). */
function assertVerbRepeated(copy: TurnActionConfirmationCopy) {
  assert.equal(copy.confirmLabel, copy.title);
}

test("a prompt excerpt is its first 60 characters on one line, with an ellipsis only when it goes on", () => {
  assert.equal(promptExcerpt("Fix the bug"), "Fix the bug");
  assert.equal(promptExcerpt("  Fix\n\tthe   bug  "), "Fix the bug");
  const sixty = "a".repeat(60);
  assert.equal(promptExcerpt(sixty), sixty);
  assert.equal(promptExcerpt(`${sixty}b`), `${sixty}…`);
  // A word break at the cut does not leave a space before the ellipsis.
  assert.equal(promptExcerpt(`${"a".repeat(59)} more words`), `${"a".repeat(59)}…`);
  // Code points, not UTF-16 units: an emoji at the cut is kept whole.
  const emoji = `${"a".repeat(59)}🙂🙂`;
  assert.equal(promptExcerpt(emoji), `${"a".repeat(59)}🙂…`);
  assert.equal(promptExcerpt(""), undefined);
  assert.equal(promptExcerpt("   \n "), undefined);
  assert.equal(promptExcerpt(undefined), undefined);
});

test("Rewind Files names the turn with a capital T and quotes its prompt", () => {
  const copy = rewindFilesConfirmation(3, "Refactor the session notice slot so that every composer error is one entry");
  assert.equal(copy.title, "Rewind Files");
  assertVerbRepeated(copy);
  assert.equal(copy.message,
    "Files go back to how they were before Turn 3, “Refactor the session notice slot so that every composer erro…”. The conversation isn't rewound, so the agent still remembers later turns.");
  assert.equal(rewindFilesConfirmation(2, undefined).message,
    "Files go back to how they were before Turn 2. The conversation isn't rewound, so the agent still remembers later turns.",
    "a prompt with no text (an image alone) leaves the quote out");
});

test("Fork Conversation says what the new session continues from, and notes an agent that forks only its latest turn", () => {
  const codex = forkConversationConfirmation(4, "codex-app-server");
  assert.equal(codex.title, "Fork Conversation");
  assertVerbRepeated(codex);
  assert.equal(codex.message,
    "A new session continues from after Turn 4 in its own worktree, with the same agent and conversation history. This session stays as it is.");
  assert.equal(codex.note, undefined);
  assert.equal(forkConversationConfirmation(4, "claude-code").note, "Claude Code can only fork after the latest turn.");
  assert.equal(forkConversationConfirmation(4, "pi").note, "Pi can only fork after the latest turn.");
  assert.equal(forkConversationConfirmation(4, undefined).note, undefined);
});

test("Recover Session describes a fork and a handoff recovery by their outcome", () => {
  const fork = recoverSessionConfirmation(5, "fork");
  assert.equal(fork.title, "Recover Session");
  assertVerbRepeated(fork);
  assert.equal(fork.message,
    "A new session continues from Turn 5, before the item the provider rejected, with the files from that turn. This session stays as it is so you can inspect it.");
  assert.equal(recoverSessionConfirmation(5, "handoff").message,
    "A new session starts a fresh conversation from a summary of Turns 1 to 5, with the files from that turn. This session stays as it is so you can inspect it.");
  assert.match(recoverSessionConfirmation(1, "handoff").message, /from a summary of Turn 1, with/u, "one turn is not a range");
});

test("Edit in a Fork and Replace Draft repeat their verbs, and the editing notice names the turn when known", () => {
  const fork = editInForkConfirmation(2);
  assert.equal(fork.title, "Edit in a Fork");
  assertVerbRepeated(fork);
  assert.equal(fork.message,
    "A new session continues from before Turn 2 in its own worktree, and this message opens in its composer for you to edit. This session stays as it is.");
  assertVerbRepeated(REPLACE_DRAFT_CONFIRMATION);
  assert.equal(REPLACE_DRAFT_CONFIRMATION.message,
    "Your current draft is replaced by this message. You can restore it with Discard Edit.");
  assert.equal(editingCopyMessage(3), "Editing a copy of your Turn 3 message. Earlier turns stay as they are.");
  assert.equal(editingCopyMessage(undefined), "Editing a copy of an earlier message. Earlier turns stay as they are.");
});

test("no confirmation refers to a lowercase turn", () => {
  const copies = [
    rewindFilesConfirmation(3, "prompt"),
    forkConversationConfirmation(3, "claude-code"),
    recoverSessionConfirmation(3, "fork"),
    recoverSessionConfirmation(3, "handoff"),
    editInForkConfirmation(3),
  ];
  for (const copy of copies) {
    assert.doesNotMatch(`${copy.message} ${copy.note ?? ""}`, /\bturns? \d/u, copy.title);
  }
});
