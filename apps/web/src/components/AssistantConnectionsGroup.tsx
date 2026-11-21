import React from "react";
import { LinkRow, SettingsGroup } from "./ui/SettingsRows.js";

export function AssistantConnectionsGroup({ onOpen }: { onOpen(): void }) {
  return (
    <SettingsGroup title="Assistant Connections" scope="This Server">
      <LinkRow title="Manage Assistant Connections" description="Organization owners can grant, inspect or revoke standing access for external assistants." onClick={onOpen} />
    </SettingsGroup>
  );
}
