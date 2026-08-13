import { useEffect, useMemo, useRef } from "react";
import {
  DURABLE_COMMAND_ATTACHMENT_NOTICE,
  durableCommandPreservesAttachments,
  type ComposerCommand,
} from "../composer-commands.js";

export interface SlashCommandMenuProps {
  listboxId: string;
  commands: readonly ComposerCommand[];
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

function slashCommandGroupLabelId(
  listboxId: string,
  groupId: string,
  sectionIndex: number,
): string {
  return `${listboxId}-group-${groupId}-${sectionIndex}`;
}

function slashCommandDetailId(listboxId: string): string {
  return `${listboxId}-detail`;
}

export function SlashCommandMenu({
  listboxId,
  commands,
  activeCommandId,
  hasAttachments = false,
  onActiveCommandChange,
  onSelectCommand,
}: SlashCommandMenuProps) {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeCommand = useMemo(
    () => commands.find((command) => command.id === activeCommandId),
    [activeCommandId, commands],
  );
  const commandSections = useMemo(() => {
    const sections: Array<{
      groupId: ComposerCommand["groupId"];
      label: string;
      commands: ComposerCommand[];
    }> = [];
    for (const command of commands) {
      const current = sections.at(-1);
      if (current?.groupId === command.groupId) current.commands.push(command);
      else sections.push({ groupId: command.groupId, label: command.groupLabel, commands: [command] });
    }
    return sections;
  }, [commands]);
  const detailId = slashCommandDetailId(listboxId);
  const attachmentNotice = durableCommandPreservesAttachments(activeCommand, hasAttachments);

  useEffect(() => {
    if (!activeCommandId) return;
    optionRefs.current.get(activeCommandId)?.scrollIntoView({ block: "nearest" });
  }, [activeCommandId]);

  return (
    <div className="slash-palette">
      <div className="slash-command-list" id={listboxId} role="listbox" aria-label="Slash Commands">
        {commandSections.map(({ groupId, label, commands: sectionCommands }, sectionIndex) => {
          const labelId = slashCommandGroupLabelId(listboxId, groupId, sectionIndex);
          return (
            <div
              className="slash-section"
              role="group"
              aria-labelledby={labelId}
              key={`${groupId}-${sectionIndex}`}
            >
              <div className="slash-section-label" id={labelId}>{label}</div>
              {sectionCommands.map((command) => {
                const active = command.id === activeCommandId;
                const describedBy = active && (
                  command.description || command.argumentHint || command.disabledReason || attachmentNotice
                )
                  ? detailId
                  : undefined;
                return (
                  <button
                    key={command.id}
                    ref={(element) => {
                      if (element) optionRefs.current.set(command.id, element);
                      else optionRefs.current.delete(command.id);
                    }}
                    id={slashCommandOptionId(listboxId, command.id)}
                    className={`slash-item${active ? " active" : ""}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={active}
                    aria-disabled={!command.available || undefined}
                    aria-describedby={describedBy}
                    onMouseEnter={() => onActiveCommandChange(command.id)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelectCommand(command);
                    }}
                  >
                    <span className="slash-item-main">
                      <span className="slash-name">{command.label}</span>
                      {command.description && <span className="slash-desc">{command.description}</span>}
                    </span>
                    <span className="slash-src">{command.sourceLabel}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {activeCommand && (
        activeCommand.description || activeCommand.argumentHint || activeCommand.disabledReason || attachmentNotice
      ) && (
        <div className="slash-detail" id={detailId}>
          <div className="slash-detail-head">
            <span className="slash-detail-name">{activeCommand.label}</span>
            <span className="slash-detail-source">{activeCommand.sourceLabel}</span>
          </div>
          {activeCommand.description && <p className="slash-detail-description">{activeCommand.description}</p>}
          {activeCommand.argumentHint && (
            <div className="slash-detail-argument">
              <span className="slash-detail-argument-label">Arguments</span>
              <code>{activeCommand.argumentHint}</code>
            </div>
          )}
          {!activeCommand.available && activeCommand.disabledReason && (
            <p className="slash-detail-disabled">{activeCommand.disabledReason}</p>
          )}
          {attachmentNotice && (
            <p className="slash-detail-attachments">{DURABLE_COMMAND_ATTACHMENT_NOTICE}</p>
          )}
        </div>
      )}
    </div>
  );
}
