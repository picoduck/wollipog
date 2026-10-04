import { useMemo } from "react";
import {
  durableCommandAttachmentNote,
  durableCommandPreservesAttachments,
  groupRankedComposerCommands,
  type ComposerCommand,
} from "../composer-commands.js";
import { ComposerListbox, ComposerListboxState } from "./ComposerListbox.js";
import { BanIcon, SearchIcon, WarningIcon } from "./Icons.js";

export interface SlashCommandMenuProps {
  listboxId: string;
  /** Ranked matches; the menu groups them, each group once, best match's group first. */
  commands: readonly ComposerCommand[];
  /** The typed token, sigil included, for the no-match row. */
  query: string;
  activeCommandId?: string | null;
  hasAttachments?: boolean;
  onActiveCommandChange: (commandId: string) => void;
  onSelectCommand: (command: ComposerCommand) => void;
  /** The typed token names no command and Enter won't send it (#2176). The menu says so, offers
   * Send as Text, and lists `suggestions` under Close Matches; none of them is active until the
   * arrow keys reach it. Without this, an unmatched query shows the plain no-match row. */
  unknown?: {
    suggestions: readonly ComposerCommand[];
    onSendAsText: () => void;
    sendAsTextDisabled?: boolean;
  };
}

/** Send as Text's tooltip, in the picker and in the notice. */
export const SEND_AS_TEXT_TOOLTIP = "Send the message exactly as typed, the same as starting it with //.";

function safeIdSuffix(value: string): string {
  const encoded = Array.from(value, (character) => character.codePointAt(0)!.toString(16)).join("-");
  return encoded || "empty";
}

export function slashCommandOptionId(listboxId: string, commandId: string): string {
  return `${listboxId}-option-${safeIdSuffix(commandId)}`;
}

export function SlashCommandMenu({
  listboxId,
  commands,
  query,
  activeCommandId,
  hasAttachments = false,
  onActiveCommandChange,
  onSelectCommand,
  unknown,
}: SlashCommandMenuProps) {
  const unknownState = unknown && commands.length === 0 ? unknown : undefined;
  const sections = useMemo(() => unknownState
    ? [{ key: "close-matches", label: "Close Matches", items: unknownState.suggestions }]
    : groupRankedComposerCommands(commands).map((section) => ({
      key: section.groupId,
      label: section.label,
      items: section.commands,
    })), [commands, unknownState]);

  // The second line: a disabled command's reason always, or the active row's attachment note.
  const secondLine = (command: ComposerCommand) => !command.available
    ? command.disabledReason ?? "This command is unavailable."
    : command.id === activeCommandId && durableCommandPreservesAttachments(command, hasAttachments)
      ? durableCommandAttachmentNote(command.label)
      : null;

  return (
    <ComposerListbox
      listboxId={listboxId}
      label="Slash Commands"
      sections={sections}
      getKey={(command) => command.id}
      getOptionId={(command) => slashCommandOptionId(listboxId, command.id)}
      activeKey={activeCommandId ?? null}
      isDisabled={(command) => !command.available}
      getOptionProps={(command) => {
        const optionId = slashCommandOptionId(listboxId, command.id);
        const described = [
          command.description ? `${optionId}-desc` : null,
          secondLine(command) ? `${optionId}-reason` : null,
        ].filter(Boolean).join(" ");
        return {
          "aria-labelledby": `${optionId}-token`,
          ...(described ? { "aria-describedby": described } : {}),
        };
      }}
      renderItem={(command) => {
        const optionId = slashCommandOptionId(listboxId, command.id);
        const reason = secondLine(command);
        return <>
          <span className="picker-line">
            <span className="picker-token" id={`${optionId}-token`}>
              {command.label}
              {command.argumentHint && <span className="picker-hint"> {command.argumentHint}</span>}
            </span>
            {command.description && (
              <span className="picker-desc" id={`${optionId}-desc`}>{command.description}</span>
            )}
          </span>
          {reason && (
            <span className={`picker-reason${command.available ? " is-note" : ""}`} id={`${optionId}-reason`}>
              {!command.available && <BanIcon size={14} />}
              {reason}
            </span>
          )}
        </>;
      }}
      onActiveChange={(command) => onActiveCommandChange(command.id)}
      onSelect={onSelectCommand}
      leadingState={unknownState && (
        <ComposerListboxState
          icon={<WarningIcon size={16} />}
          role="status"
          detail={unknownState.suggestions.length
            ? "Enter won't send it. Choose a close match, or send it as text."
            : "Enter won't send it. Keep typing, or send it as text."}
          action={(
            <button
              type="button"
              className="btn sm"
              title={SEND_AS_TEXT_TOOLTIP}
              disabled={unknownState.sendAsTextDisabled}
              onClick={unknownState.onSendAsText}
            >
              Send as Text
            </button>
          )}
        >
          “{query}” isn't a recognized command.
        </ComposerListboxState>
      )}
      states={commands.length === 0 && !unknownState && (
        <ComposerListboxState icon={<SearchIcon size={16} />} role="status">
          No commands match “{query}”.
        </ComposerListboxState>
      )}
      enterLabel={unknownState ? "Insert" : "Run or Insert"}
    />
  );
}
