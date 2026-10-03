import { useMemo } from "react";
import {
  durableCommandAttachmentNote,
  durableCommandPreservesAttachments,
  groupRankedComposerCommands,
  type ComposerCommand,
} from "../composer-commands.js";
import { ComposerListbox, ComposerListboxState } from "./ComposerListbox.js";
import { BanIcon, SearchIcon } from "./Icons.js";

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
}

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
}: SlashCommandMenuProps) {
  const sections = useMemo(() => groupRankedComposerCommands(commands).map((section) => ({
    key: section.groupId,
    label: section.label,
    items: section.commands,
  })), [commands]);

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
      states={commands.length === 0 && (
        <ComposerListboxState icon={<SearchIcon size={16} />} role="status">
          No commands match “{query}”.
        </ComposerListboxState>
      )}
      enterLabel="Run or Insert"
    />
  );
}
