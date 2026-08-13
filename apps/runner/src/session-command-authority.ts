import { randomUUID } from "node:crypto";
import type {
  AgentSlashCommand,
  SessionCommandExecutionMode,
  SessionCommandInvocationErrorCode,
  SessionSnapshot,
} from "@wollipog/protocol";

export const SESSION_COMMAND_AUTHORITY_PROTOCOL_VERSION = 75;

export type SessionCommandAuthorizationErrorCode = Extract<
  SessionCommandInvocationErrorCode,
  "COMMAND_CATALOG_STALE" | "COMMAND_UNAVAILABLE" | "COMMAND_MODE_UNSUPPORTED"
>;

export interface ResolveSessionCommandRequest {
  sessionId: string;
  providerCommandId: string;
  catalogRevision: string;
  expectedExecutionMode: SessionCommandExecutionMode;
}

export type SessionCommandAuthorizationResult =
  | {
      ok: true;
      command: AgentSlashCommand;
      commandName: string;
      executionMode: SessionCommandExecutionMode;
    }
  | {
      ok: false;
      code: SessionCommandAuthorizationErrorCode;
    };

interface AuthorizedCommand {
  command: AgentSlashCommand;
  providerCommandId: string;
}

interface AuthorizedCatalog {
  catalogRevision: string;
  fingerprint: string;
  provenance: string;
  executionMode: SessionCommandExecutionMode;
  commands: AuthorizedCommand[];
}

function commandWithoutInvocation(command: AgentSlashCommand): AgentSlashCommand {
  return {
    name: command.name,
    source: command.source,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
  };
}

function normalizeCatalog(commands: readonly AgentSlashCommand[]): AgentSlashCommand[] {
  return commands.map(commandWithoutInvocation);
}

function catalogFingerprint(commands: readonly AgentSlashCommand[]): string {
  return JSON.stringify(commands.map((command) => [
    command.name,
    command.source,
    command.description ?? null,
    command.argumentHint ?? null,
  ]));
}

function withInvocation(
  command: AgentSlashCommand,
  providerCommandId: string,
  catalogRevision: string,
  executionMode: SessionCommandExecutionMode,
): AgentSlashCommand {
  return {
    ...command,
    invocation: {
      id: providerCommandId,
      catalogRevision,
      executionMode,
    },
  };
}

/**
 * Owns live, process-local authorization for provider commands.
 *
 * Catalog revisions and provider command IDs intentionally never enter persisted session metadata.
 * A fresh runner process therefore starts with no command authority, even if its session snapshot
 * still contains a display-only catalog.
 */
export class SessionCommandAuthorityRegistry {
  private readonly catalogs = new Map<string, AuthorizedCatalog>();

  /**
   * Authorize a freshly discovered mode-specific catalog. Exact catalog, provenance, and mode
   * reuse within this registry preserves IDs; every other refresh rotates the revision and all
   * command IDs.
   */
  refresh(
    sessionId: string,
    commands: readonly AgentSlashCommand[],
    provenance: string,
    executionMode: SessionCommandExecutionMode = "passthrough",
  ): AgentSlashCommand[] {
    const normalized = normalizeCatalog(commands);
    const fingerprint = catalogFingerprint(normalized);
    const current = this.catalogs.get(sessionId);
    if (current?.fingerprint === fingerprint && current.provenance === provenance &&
        current.executionMode === executionMode) {
      return this.overlayCommands(current);
    }

    const catalog: AuthorizedCatalog = {
      catalogRevision: `catalog_${randomUUID()}`,
      fingerprint,
      provenance,
      executionMode,
      commands: normalized.map((command) => ({
        command,
        providerCommandId: `command_${randomUUID()}`,
      })),
    };
    this.catalogs.set(sessionId, catalog);
    return this.overlayCommands(catalog);
  }

  clear(sessionId: string): boolean {
    return this.catalogs.delete(sessionId);
  }

  clearAll(): void {
    this.catalogs.clear();
  }

  resolve(request: ResolveSessionCommandRequest): SessionCommandAuthorizationResult {
    const catalog = this.catalogs.get(request.sessionId);
    if (!catalog) {
      return { ok: false, code: "COMMAND_UNAVAILABLE" };
    }
    if (request.catalogRevision !== catalog.catalogRevision) {
      return { ok: false, code: "COMMAND_CATALOG_STALE" };
    }

    const authorized = catalog.commands.find(
      (candidate) => candidate.providerCommandId === request.providerCommandId,
    );
    if (!authorized) {
      return { ok: false, code: "COMMAND_UNAVAILABLE" };
    }
    if (request.expectedExecutionMode !== catalog.executionMode) {
      return { ok: false, code: "COMMAND_MODE_UNSUPPORTED" };
    }

    return {
      ok: true,
      command: { ...authorized.command },
      commandName: authorized.command.name,
      executionMode: catalog.executionMode,
    };
  }

  /** Return a new snapshot with live authority overlaid for v75 peers and stripped for older peers. */
  overlaySnapshot(
    snapshot: SessionSnapshot,
    controlPlaneProtocolVersion: number | null,
  ): SessionSnapshot {
    const capabilities = snapshot.agentCapabilities;
    const visibleCommands = capabilities?.slashCommands?.map(commandWithoutInvocation);
    const catalog = this.catalogs.get(snapshot.id);
    const commands = controlPlaneProtocolVersion !== null
      && controlPlaneProtocolVersion >= SESSION_COMMAND_AUTHORITY_PROTOCOL_VERSION
      && catalog
      ? this.overlayCommands(catalog)
      : visibleCommands;

    if (!capabilities && commands === undefined) {
      return snapshot;
    }
    if (!capabilities) {
      return {
        ...snapshot,
        agentCapabilities: { slashCommands: commands ?? [] },
      };
    }
    return {
      ...snapshot,
      agentCapabilities: {
        ...capabilities,
        ...(commands === undefined ? {} : { slashCommands: commands }),
      },
    };
  }

  private overlayCommands(catalog: AuthorizedCatalog): AgentSlashCommand[] {
    return catalog.commands.map(({ command, providerCommandId }) => withInvocation(
      command,
      providerCommandId,
      catalog.catalogRevision,
      catalog.executionMode,
    ));
  }
}
