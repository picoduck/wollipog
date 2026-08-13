/** AcpDriver — adapts the existing AcpClient to the Driver interface (no behavior change). */

import type { PromptImage, SessionConfig } from "@wollipog/protocol";
import { AcpClient } from "../acp.js";
import type {
  Driver,
  DriverCallbacks,
  DriverCommandInput,
  DriverOptions,
  PreparedDriverCommand,
  StopReason,
} from "./driver.js";

export class AcpDriver implements Driver {
  private readonly client: AcpClient;
  private sessionId: string | null = null;
  private readonly resumeId: string | undefined;
  private readonly initialConfig: SessionConfig;
  private readonly preparedCommands = new WeakSet<object>();

  constructor(opts: DriverOptions, cb: DriverCallbacks) {
    this.client = new AcpClient(
      {
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        context: opts.context,
        initialCommands: opts.resumeId ? opts.capabilities?.slashCommands : undefined,
        sessionContext: opts.acpSessionContext,
        isolation: opts.isolation,
        containerAgentLaunch: true,
        cloudAgentLaunch: true,
      },
      cb,
    );
    this.resumeId = opts.resumeId;
    this.initialConfig = opts.config;
  }

  get pid(): number | undefined {
    return this.client.pid;
  }

  agentSessionId(): string | null {
    // Persisted only after the handshake proves whether this adapter can resume/load it later.
    return this.sessionId;
  }

  initialize(): Promise<void> {
    return this.client.initialize();
  }

  async newSession(cwd: string): Promise<string> {
    this.sessionId = this.resumeId
      ? await this.client.resumeSession(this.resumeId, cwd)
      : await this.client.newSession(cwd);
    await this.client.restoreInitialConfig(this.initialConfig);
    return this.sessionId;
  }

  prompt(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason> {
    return this.client.prompt(text, images, slashCommand);
  }

  prepareCommand(input: DriverCommandInput): PreparedDriverCommand {
    if (input.executionMode !== "structured") {
      throw new Error(`ACP does not support ${input.executionMode} session commands`);
    }
    if (!input.commandName || /\s/u.test(input.commandName)) {
      throw new Error("invalid ACP command name");
    }
    const prepared = Object.freeze({
      commandName: input.commandName,
      argumentText: input.argumentText,
      executionMode: "structured" as const,
    }) as PreparedDriverCommand;
    this.preparedCommands.add(prepared);
    return prepared;
  }

  invokeCommand(command: PreparedDriverCommand): Promise<StopReason> {
    if (!this.preparedCommands.delete(command)) {
      throw new Error("session command was not prepared by this ACP driver");
    }
    return this.client.invokeCommand(command.commandName, command.argumentText);
  }

  setConfig(config: SessionConfig): Promise<void> {
    return this.client.setConfig(config);
  }

  cancel(): void {
    this.client.cancel();
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    return this.client.resolvePermission(requestId, optionId);
  }

  logout(): Promise<void> {
    return this.client.logout();
  }

  async close(): Promise<boolean> {
    const closed = await this.client.closeSession();
    if (closed) this.sessionId = null;
    return closed;
  }

  dispose(): void {
    this.client.dispose();
  }
}
