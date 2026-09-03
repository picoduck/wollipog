/**
 * CodexDriver — drives the native `codex exec --json` CLI (one process per turn,
 * multi-turn via `codex exec resume <thread_id>`). Uses the machine's
 * `~/.codex/auth.json` (ChatGPT-plan subscription) — no API key.
 *
 * Codex `exec` has no interactive per-tool approval; the **sandbox mode**
 * (read-only / workspace-write / danger-full-access) is the approval control,
 * mapped from SessionConfig.permissionMode.
 *
 * Event schema (verified against codex 0.142.3):
 *   {type:"thread.started",thread_id}
 *   {type:"turn.started"}
 *   {type:"item.started|updated|completed", item:{id,type,...}}   // agent_message|reasoning|command_execution|file_change|mcp_tool_call|web_search|todo_list
 *   {type:"turn.completed", usage:{input_tokens,output_tokens,...}}
 *   {type:"error", message}
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, PlanEntry, PromptImage, SessionConfig } from "@wollipog/protocol";
import { killTree, spawnAgent, terminateDescendantBoundaries, type AgentProcess } from "../spawn.js";
import { BoundedNdjsonBuffer } from "../bounded-ndjson.js";
import type { Driver, DriverCallbacks, DriverOptions, StopReason } from "./driver.js";
import { isProviderAuthenticationFailure } from "./provider-auth-failure.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

interface CodexDriverDeps {
  spawn: typeof spawnAgent;
  kill: typeof killTree;
}

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function normalizedCodexItemId(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return `item-${value}`;
  return undefined;
}
let imgSeq = 0;

/** Stage pasted images to files codex can read via `-i`, and return the `-i <path>`
 * args plus the HOST paths to clean up afterward. For a WSL-bridged agent the file
 * must live inside the distro (a Windows tmp path is unreadable in Linux), so we write
 * it into the distro's /tmp via its UNC path and pass the Linux path to codex. */
function writeImageArgs(
  images: PromptImage[] | undefined,
  context: AgentContext | undefined,
): { args: string[]; temps: string[] } {
  const args: string[] = [];
  const temps: string[] = [];
  const distro = context?.kind === "wsl" ? context.distro : null;
  for (const img of images ?? []) {
    const ext = MIME_EXT[img.mimeType] ?? "png";
    const name = `wollipog-codex-img-${process.pid}-${++imgSeq}.${ext}`;
    try {
      if (distro) {
        const hostPath = `\\\\wsl.localhost\\${distro}\\tmp\\${name}`;
        writeFileSync(hostPath, Buffer.from(img.data, "base64"));
        temps.push(hostPath); // unlinkSync works on the UNC path too
        args.push("-i", `/tmp/${name}`); // path as seen inside the distro
      } else {
        const p = join(tmpdir(), name);
        writeFileSync(p, Buffer.from(img.data, "base64"));
        temps.push(p);
        args.push("-i", p);
      }
    } catch {
      /* skip an image we can't stage */
    }
  }
  return { args, temps };
}

export class CodexDriver implements Driver {
  private threadId: string | null = null;
  private child: AgentProcess | null = null;
  private cwd: string;
  private disposed = false;
  private cancelled = false;
  private config: SessionConfig;
  private readonly deps: CodexDriverDeps;
  private readonly descendantOwner = {};
  /** track tool items we've announced so updates map to the same toolCallId */
  private readonly seenItems = new Set<string>();
  /** temp image files staged for the in-flight turn, removed when it ends. */
  private tempImages: string[] = [];

  /** Remove this turn's staged image temp files (idempotent). */
  private cleanupImages(): void {
    for (const p of this.tempImages) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
    this.tempImages = [];
  }

  constructor(
    private readonly opts: DriverOptions,
    private readonly cb: DriverCallbacks,
    deps: Partial<CodexDriverDeps> = {},
  ) {
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.deps = {
      spawn: deps.spawn ?? spawnAgent,
      kill: deps.kill ?? killTree,
    };
    // Phase 2 resume: a persisted threadId makes the first turn use `codex resume <id>`.
    if (opts.resumeId) this.threadId = opts.resumeId;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  agentSessionId(): string | null {
    return this.threadId;
  }

  async initialize(): Promise<void> {
    // No persistent process; each turn spawns `codex exec`.
  }

  async newSession(cwd: string): Promise<string> {
    this.cwd = cwd;
    return this.threadId ?? "codex-pending";
  }

  setConfig(config: SessionConfig): void {
    this.config = config;
  }

  prompt(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason> {
    // A disposed driver must never spawn a fresh agent process (a caller racing stop()/restart
    // against an awaited pre-turn step would otherwise launch an invisible rogue turn).
    if (this.disposed) return Promise.resolve("cancelled");
    return new Promise<StopReason>((resolve) => {
      this.cancelled = false;
      this.seenItems.clear(); // dedup is per-turn; each turn re-emits item.started ids
      const promptText = slashCommand ? `/${slashCommand}${text ? " " + text : ""}`.trim() : text;

      const cfg = this.config;
      const sandbox = cfg.permissionMode && SANDBOX_MODES.has(cfg.permissionMode) ? cfg.permissionMode : "workspace-write";

      // model/effort apply to both first turn and resume.
      const modelEffort: string[] = [];
      if (cfg.model && cfg.model !== "default") modelEffort.push("-m", cfg.model);
      if (cfg.effort) modelEffort.push("-c", `model_reasoning_effort=${cfg.effort}`);

      // Pasted images are staged to temp files and passed via `-i` (cleaned up when the
      // turn ends, on cancel/dispose, or if the spawn itself throws).
      const { args: imageArgs, temps: tempImages } = writeImageArgs(images, this.opts.context);
      this.tempImages = tempImages;

      // The prompt is passed as "-" and written to stdin so a multi-line prompt (or
      // one containing %VAR%, quotes, etc.) can't be mangled by the Windows shell.
      const args = [...this.opts.args, "exec"];
      if (this.threadId) {
        // `resume` inherits cwd + sandbox from the original session (no -C/-s).
        args.push("resume", "--json", "--skip-git-repo-check", ...modelEffort, ...imageArgs, this.threadId, "-");
      } else {
        args.push("--json", "--skip-git-repo-check", "-C", this.cwd, "-s", sandbox, ...modelEffort, ...imageArgs, "-");
      }

      let child: AgentProcess;
      try {
        // Subscription auth comes from ~/.codex/auth.json; a stray OPENAI_API_KEY in the
        // daemon's environment would silently switch billing to the API. An explicit
        // agent-config env entry still wins (a deliberately API-keyed agent keeps working).
        child = this.deps.spawn({
          command: this.opts.command,
          args,
          cwd: this.cwd,
          env: this.opts.env,
          context: this.opts.context,
          scrubInheritedEnv: ["OPENAI_API_KEY"],
          isolation: this.opts.isolation,
          containerAgentLaunch: true,
          cloudAgentLaunch: true,
          descendantOwner: this.descendantOwner,
        });
      } catch (err) {
        this.cleanupImages();
        this.cb.onEvent({ kind: "error", message: (err as Error).message });
        return resolve("refusal");
      }
      this.child = child;

      let stopReason: StopReason = "end_turn";
      let settled = false;
      const finish = (r: StopReason) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      const processLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const r = this.handleEvent(msg);
        if (r) stopReason = r;
      };
      const stdout = new BoundedNdjsonBuffer(processLine, () => {
        this.cb.onStderr("discarded oversized NDJSON record from Codex stdout");
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.disposed || this.cancelled) return;
        stdout.push(chunk);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (t: string) => {
        if (this.disposed || this.cancelled) return;
        const s = String(t).trim();
        if (s && !/Reading additional input from stdin/i.test(s)) {
          if (isProviderAuthenticationFailure(s)) this.signalAuthenticationFailure();
          else this.cb.onStderr(s);
        }
      });

      child.on("error", (err: Error) => {
        this.child = null;
        this.cleanupImages();
        this.cb.onStderr(`spawn error: ${err.message}`);
        finish("refusal");
      });

      // `close`, not `exit`: stdout can still deliver the final NDJSON record after
      // the process exits. Finalize only once every stdio stream has drained.
      child.on("close", (code) => {
        this.child = null;
        this.cleanupImages();
        if (this.disposed || this.cancelled) return finish("cancelled");
        // Flush a trailing partial line — `turn.completed` (token_usage) may arrive
        // without a trailing newline.
        processLine(stdout.takeTrailing());
        if (code && code !== 0 && !settled) {
          this.cb.onEvent({ kind: "error", message: `codex exited with code ${code}` });
          return finish("refusal");
        }
        finish(stopReason);
      });

      // Prompt is read from stdin (the "-" positional). Write it, then EOF.
      try {
        child.stdin.write(promptText);
        child.stdin.end();
      } catch {
        /* ignore */
      }
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (this.child) this.deps.kill(this.child);
    this.cleanupImages();
  }

  resolvePermission(_requestId: string, _optionId: string | null): boolean {
    // codex exec gates via sandbox mode, not interactive approval (v1) — nothing ever waits.
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) this.deps.kill(this.child);
    this.child = null;
    terminateDescendantBoundaries(this.descendantOwner);
    // Synchronous cleanup so files are gone before a shutdown process.exit().
    this.cleanupImages();
  }

  private handleEvent(msg: Json): StopReason | null {
    if (this.disposed) return null;
    switch (msg.type) {
      case "thread.started":
        if (msg.thread_id) this.threadId = msg.thread_id;
        return null;
      case "turn.started":
        return null;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.handleItem(msg.type, msg.item);
        return null;
      case "turn.completed": {
        const u = msg.usage ?? {};
        this.cb.onEvent({
          kind: "token_usage",
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cachedInputTokens: u.cached_input_tokens,
          ...(typeof u.reasoning_output_tokens === "number" ? { reasoningOutputTokens: u.reasoning_output_tokens } : {}),
          ...(this.config.model && this.config.model !== "default" ? { model: this.config.model } : {}),
        });
        return "end_turn";
      }
      case "turn.failed":
        if (msg.error?.message) this.emitErrorOrAuthenticationFailure(String(msg.error.message));
        return "refusal";
      case "error":
        this.emitErrorOrAuthenticationFailure(String(msg.message ?? "codex error"));
        return "refusal";
      default:
        return null;
    }
  }

  private emitErrorOrAuthenticationFailure(message: string): void {
    if (isProviderAuthenticationFailure(message)) this.signalAuthenticationFailure();
    else this.cb.onEvent({ kind: "error", message });
  }

  private signalAuthenticationFailure(): void {
    if (this.cb.onAuthenticationFailure) this.cb.onAuthenticationFailure();
    else this.cb.onStderr("provider authentication is required");
  }

  private handleItem(phase: string, item: Json): void {
    if (!item) return;
    const id = normalizedCodexItemId(item.id) ?? "item";
    const completed = phase === "item.completed";
    switch (item.type) {
      case "agent_message":
        if (completed && item.text) this.cb.onEvent({ kind: "agent_message", text: item.text, messageId: id, final: true });
        break;
      case "reasoning":
        // Current `codex exec --json` exposes readable reasoning only as an authoritative
        // item.completed record. Matching that observed boundary also prevents an older dashboard
        // from rendering a hypothetical partial plus the completed whole item as two thoughts.
        if (completed && item.text) this.cb.onEvent({ kind: "agent_thought", text: item.text, messageId: id, final: true });
        break;
      case "command_execution": {
        const status = completed ? (item.exit_code === 0 || item.status === "completed" ? "completed" : "failed") : "in_progress";
        if (!this.seenItems.has(id)) {
          this.seenItems.add(id);
          this.cb.onEvent({ kind: "tool_call", toolCallId: id, title: `$ ${truncate(String(item.command ?? ""), 80)}`, toolKind: "execute", status });
        } else {
          this.cb.onEvent({ kind: "tool_call_update", toolCallId: id, status });
        }
        const out = item.aggregated_output ?? item.output;
        if (out) this.cb.onEvent({ kind: "command_output", text: truncate(String(out), 2000) });
        break;
      }
      case "file_change": {
        const changes: Json[] = item.changes ?? [];
        for (const ch of changes) {
          if (ch?.path) this.cb.onEvent({ kind: "file_edit", path: ch.path, diff: ch.diff });
        }
        const status = completed ? "completed" : "in_progress";
        if (!this.seenItems.has(id)) {
          this.seenItems.add(id);
          this.cb.onEvent({ kind: "tool_call", toolCallId: id, title: `edit ${changes.length} file(s)`, toolKind: "edit", status });
        } else {
          this.cb.onEvent({ kind: "tool_call_update", toolCallId: id, status });
        }
        break;
      }
      case "mcp_tool_call":
      case "web_search": {
        const title = item.type === "web_search" ? `web_search: ${item.query ?? ""}` : `${item.server ?? ""}/${item.tool ?? ""}`;
        const status = completed ? "completed" : "in_progress";
        if (!this.seenItems.has(id)) {
          this.seenItems.add(id);
          this.cb.onEvent({ kind: "tool_call", toolCallId: id, title, toolKind: item.type === "web_search" ? "fetch" : "other", status });
        } else {
          this.cb.onEvent({ kind: "tool_call_update", toolCallId: id, status });
        }
        break;
      }
      case "todo_list": {
        const items: Json[] = item.items ?? [];
        const entries: PlanEntry[] = items.map((t) => ({
          content: String(t.text ?? t.content ?? ""),
          status: t.completed || t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
        }));
        if (entries.length) this.cb.onEvent({ kind: "plan", entries });
        break;
      }
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
