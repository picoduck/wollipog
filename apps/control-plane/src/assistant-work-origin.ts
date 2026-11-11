/** Structural interface implemented by #4467's db.assistantWork. Keeping the interface here
 * lets the session tools land first without importing the event/work implementation. */
export interface AssistantWorkOriginStore {
  reserveOrigin(connectionId: string, input: {
    commandId: string; workId: string; bindingId: string; requesterId: string; projectId?: string;
  }): void;
  attachAcceptedOrigin(origin: AssistantSessionWorkOrigin, sessionId: string): unknown;
}

export interface AssistantSessionWorkOrigin {connectionId: string; commandId: string}

/** Supplied only by trusted ingress which authenticated the requester and bound the exact
 * command operation/digest/target. Never deserialize this from model arguments or request JSON. */
export interface AuthenticatedAssistantWorkOrigin {
  requesterId: string;
  workId: string;
  bindingId: string;
}
