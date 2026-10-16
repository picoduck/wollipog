import { CODEX_EXEC_RETIRED_REASON, type AgentDriverKind } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./driver.js";
import { AcpDriver } from "./acp-driver.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { CodexAppServerDriver } from "./codex-app-server.js";
import { PiRpcDriver } from "./pi-rpc.js";

export function makeDriver(
  driver: AgentDriverKind,
  opts: DriverOptions,
  cb: DriverCallbacks,
): Driver {
  if (opts.artifactGuidance && driver === "pi") {
    // Pi accumulates append flags and resolves each text/file argument in its own execution
    // context. Preserve all originals (including extension flags), then add our own note.
    opts = { ...opts, args: [...opts.args, "--append-system-prompt", opts.artifactGuidance] };
  }
  switch (driver) {
    case "claude-code":
      return new ClaudeCodeDriver(opts, cb);
    case "codex":
      // Session start refuses this first; never fall through to the ACP default (#3259).
      throw new Error(CODEX_EXEC_RETIRED_REASON);
    case "codex-app-server":
      return new CodexAppServerDriver(opts, cb);
    case "pi":
      return new PiRpcDriver(opts, cb);
    case "acp":
    default:
      return new AcpDriver(opts, cb);
  }
}

export type { Driver, DriverCallbacks, DriverOptions } from "./driver.js";
