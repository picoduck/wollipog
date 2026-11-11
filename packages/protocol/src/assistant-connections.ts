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
}
