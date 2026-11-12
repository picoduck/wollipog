import { randomUUID } from "node:crypto";
import { AssistantRefusal, type AssistantConnection, type AssistantOperationReceipt, type AssistantTarget } from "./assistant-connections.js";
import type { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";

/** A safe, actionable operation error whose receipt must retain possible effects. Unlike an
 * arbitrary Error, this message may be returned through MCP without exposing transport logs. */
export class ManagementUncertainOutcome extends Error {}

/** Narrow adapter to the operation-agnostic durable command store. No arguments or results persist. */
export interface ManagementCommands {
  get(connectionId: string, commandId: string): AssistantOperationReceipt | null;
  reserve(receipt: Omit<AssistantOperationReceipt, "status">, associate?: () => void): {created: boolean; receipt: AssistantOperationReceipt};
  settle(connectionId: string, commandId: string, status: "succeeded" | "failed" | "uncertain", resultReference?: string): unknown;
}

export class ManagementMutations {
  private confirmations = new Map<string, {digest: string; expires: number}>();
  constructor(private readonly commands: ManagementCommands, private readonly controlPlaneId: string,
    private readonly digest: (args: unknown) => string,
    private readonly currentConnection: (id: string) => AssistantConnection,
    private readonly confirmationPolicy: (id: string) => "none" | "confirm",
    private readonly durableConfirmations?: Pick<AssistantCommandConfirmations, "issue" | "consume">) {}
  async run(input: {
    connection: AssistantConnection; operation: string; args: Record<string, unknown>; target: AssistantTarget;
    impact(): unknown; destructive?: boolean; recheck(): Promise<unknown>;
    execute(): unknown | Promise<unknown>; resourceId?(): string | undefined;
  }): Promise<unknown> {
    let {connection} = input;
    const {args, operation} = input;
    if (typeof args.operationId !== "string" || !/^[\w:-]{1,128}$/.test(args.operationId)) throw new AssistantRefusal("Provide a durable operationId and reconcile that id before retrying.");
    const {confirmationId: _confirmation, ...request} = args;
    const argumentsDigest = this.digest({operation, request});
    const prior = this.commands.get(connection.id, args.operationId);
    if (prior) {
      if (prior.operation !== operation || prior.argumentsDigest !== argumentsDigest) throw new AssistantRefusal("operationId was already used with different arguments.");
      return {receipt: prior};
    }
    await input.recheck();
    connection = this.currentConnection(connection.id);
    const impact = input.impact();
    const currentPolicy = this.confirmationPolicy(connection.id);
    const binding = {connectionId: connection.id, grantRevision: connection.revision, operation, argumentsDigest,
      targetDigest: this.digest({target: input.target, impact})};
    const durableConfirmation = input.destructive && currentPolicy === "confirm" && !!this.durableConfirmations;
    if (durableConfirmation && args.confirmationId === undefined) {
      return {confirmationRequired: true, ...this.durableConfirmations!.issue(binding), impact};
    }
    if (input.destructive && currentPolicy === "confirm" && !durableConfirmation) {
      const digest = this.digest({connectionId: connection.id, revision: connection.revision, argumentsDigest, impact});
      const confirmation = typeof args.confirmationId === "string" ? this.confirmations.get(args.confirmationId) : undefined;
      if (!confirmation || confirmation.digest !== digest || confirmation.expires <= Date.now()) {
        for (const [id, item] of this.confirmations) if (item.expires <= Date.now()) this.confirmations.delete(id);
        if (this.confirmations.size >= 1000) throw new AssistantRefusal("Too many pending confirmations. Retry after they expire.");
        const confirmationId = randomUUID();
        this.confirmations.set(confirmationId, {digest, expires: Date.now() + 300_000});
        return {confirmationRequired: true, confirmationId, expiresInSeconds: 300, impact};
      }
      this.confirmations.delete(args.confirmationId as string);
    }
    const reservation = this.commands.reserve({controlPlaneId: this.controlPlaneId, connectionId: connection.id,
      operationId: args.operationId, operation, argumentsDigest, grantRevision: connection.revision, target: input.target}, () => {
        if (durableConfirmation) {
          if (typeof args.confirmationId !== "string") throw new AssistantRefusal("confirmationId is required.");
          this.durableConfirmations!.consume(args.confirmationId, binding);
        }
      });
    if (!reservation.created) return {receipt: reservation.receipt};
    try {
      const result = await input.execute();
      this.commands.settle(connection.id, args.operationId, "succeeded", input.resourceId?.());
      return {receipt: this.commands.get(connection.id, args.operationId), result, impact};
    } catch (error) {
      this.commands.settle(connection.id, args.operationId, error instanceof AssistantRefusal ? "failed" : "uncertain");
      throw error;
    }
  }
}
