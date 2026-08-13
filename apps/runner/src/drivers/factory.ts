import type { AgentDriverKind } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./driver.js";
import { AcpDriver } from "./acp-driver.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { CodexDriver } from "./codex.js";
import { CodexAppServerDriver } from "./codex-app-server.js";

export function makeDriver(
  driver: AgentDriverKind,
  opts: DriverOptions,
  cb: DriverCallbacks,
): Driver {
  switch (driver) {
    case "claude-code":
      return new ClaudeCodeDriver(opts, cb);
    case "codex":
      return new CodexDriver(opts, cb);
    case "codex-app-server":
      return new CodexAppServerDriver(opts, cb);
    case "acp":
    default:
      return new AcpDriver(opts, cb);
  }
}

export type { Driver, DriverCallbacks, DriverOptions } from "./driver.js";
