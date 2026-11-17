/** Shared owner-issued authority. Credentials are never part of this view. */
export interface AssistantGrant {
  operations: "all" | string[];
  projects: "all" | string[];
  /** Omitted legacy/create inputs normalize to none; stored/read grants include the value. */
  destructiveConfirmation?: "none" | "confirm";
}
export interface AssistantConnection {
  id: string;
  name: string;
  ownerUserId: string;
  organizationId: string;
  grant: AssistantGrant;
  revision: number;
  revoked: boolean;
  /** v384 (#4663): the Wollipog Assistant thread this connection belongs to. Its credential is
   * minted and rotated by that thread's runner proxy, never shown to anyone. */
  threadId?: string;
  /** When the current credential stops authenticating; absent for an owner-issued connection. */
  expiresAt?: number | null;
}
