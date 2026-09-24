/**
 * Session-scoped Codex custom prompt discovery and expansion.
 *
 * Codex reads custom prompts from `$CODEX_HOME/prompts/*.md` (default `~/.codex/prompts`), but the
 * app-server neither lists nor expands them: its TUI does both client-side. Wollipog therefore scans
 * the prompts directory itself, advertises each prompt as a `/name` command, and sends the expanded
 * body as ordinary `turn/start` text.
 *
 * Only the top-level `.md` files are prompts. The scan shares the bounded, containment-checked
 * traversal of Claude command discovery. Container and cloud targets never read host prompts: Codex
 * has no project-level prompt directory, so those targets advertise none.
 */

import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { open, opendir } from "node:fs/promises";
import type { AgentContext, AgentSlashCommand } from "@wollipog/protocol";
import type { SessionMeta } from "../session-store.js";
import {
  CLAUDE_COMMAND_LIMITS,
  executeWithinWslBudget,
  includeClaudeUserCommandsForTarget,
  nativeCommandFiles,
  parseClaudeCommandMetadata,
  readBoundedNative,
  validateCommandRootBinding,
  wslAbsolutePathToUnc,
  type ClaudeSlashCommandDiscoveryDeps,
} from "./claude-commands.js";
import { run } from "./resolve.js";

export interface CodexPromptTemplate {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Prompt text after any frontmatter, before argument expansion. */
  body: string;
}

export interface CodexPromptDiscoveryRequest {
  context: AgentContext;
  /** The session's explicit `CODEX_HOME`, such as a provider account home. */
  codexHome?: string;
}

export type CodexPromptDiscoveryResult =
  | { ok: true; prompts: CodexPromptTemplate[] }
  | { ok: false; error: string };

export type CodexPromptDiscoveryDeps = Pick<
  ClaudeSlashCommandDiscoveryDeps,
  "nativeHome" | "run" | "wslDiscoveryTimeoutMs" | "nativeDiscoveryTimeoutMs" | "wslPathToWindows"
> & {
  /** Test seam for the runner's inherited `CODEX_HOME`; native launches only. */
  inheritedCodexHome?: () => string | undefined;
};

/** Advertised catalog entry for one prompt. Prompts are the user's own files, so they carry the
 * `user` source label. */
export function codexPromptCommand(prompt: CodexPromptTemplate): AgentSlashCommand {
  return {
    name: prompt.name,
    source: "user",
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
  };
}

/** The prompt text after a well-formed leading frontmatter block. */
export function codexPromptBody(content: string): string {
  const text = content.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text.trim();
  const limit = Math.min(lines.length, CLAUDE_COMMAND_LIMITS.maxFrontmatterLines + 1);
  for (let index = 1; index < limit; index += 1) {
    const marker = lines[index]!.trim();
    if (marker === "---" || marker === "...") return lines.slice(index + 1).join("\n").trim();
  }
  // Unterminated frontmatter is body text, matching metadata parsing.
  return text.trim();
}

/** Shell-like argument split: whitespace separates, and single or double quotes group. */
export function splitCodexPromptArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const PLACEHOLDER = /\$(\$|ARGUMENTS\b|[1-9]|[A-Z][A-Z0-9_]*)/gu;

/**
 * Expand a prompt the way Codex's TUI does: `$1`..`$9` are positional arguments, `$ARGUMENTS` is
 * all of them, `$NAME` is a `NAME=value` argument, and `$$` is a literal `$`. An uppercase name
 * with no matching argument stays literal so ordinary text such as `$PATH` survives. A prompt
 * without any argument placeholder receives its arguments after a blank line rather than losing
 * them.
 */
export function expandCodexPrompt(body: string, argumentText: string): string {
  const args = splitCodexPromptArguments(argumentText);
  const named = new Map<string, string>();
  for (const arg of args) {
    const match = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/u.exec(arg);
    if (match) named.set(match[1]!, match[2]!);
  }
  let consumedArguments = false;
  const expanded = body.replace(PLACEHOLDER, (token, key: string) => {
    if (key === "$") return "$";
    if (key === "ARGUMENTS") {
      consumedArguments = true;
      return args.join(" ");
    }
    if (/^[1-9]$/u.test(key)) {
      consumedArguments = true;
      return args[Number(key) - 1] ?? "";
    }
    if (!named.has(key)) return token;
    consumedArguments = true;
    return named.get(key)!;
  });
  const trimmedArguments = argumentText.trim();
  return !consumedArguments && trimmedArguments ? `${expanded}\n\n${trimmedArguments}` : expanded;
}

function nativeCodexHome(request: CodexPromptDiscoveryRequest, deps: CodexPromptDiscoveryDeps): string {
  const explicit = request.codexHome && isAbsolute(request.codexHome) ? request.codexHome : undefined;
  const inherited = (deps.inheritedCodexHome ?? (() => process.env.CODEX_HOME))();
  return explicit ?? (inherited && isAbsolute(inherited) ? inherited : join((deps.nativeHome ?? homedir)(), ".codex"));
}

export async function discoverCodexPrompts(
  request: CodexPromptDiscoveryRequest,
  deps: CodexPromptDiscoveryDeps = {},
): Promise<CodexPromptDiscoveryResult> {
  try {
    let root: string;
    let deadline: number;
    if (request.context.kind === "native") {
      deadline = Date.now() + Math.max(1, Math.min(
        deps.nativeDiscoveryTimeoutMs ?? CLAUDE_COMMAND_LIMITS.maxNativeDiscoveryMs,
        CLAUDE_COMMAND_LIMITS.maxNativeDiscoveryMs,
      ));
      root = join(nativeCodexHome(request, deps), "prompts");
    } else {
      deadline = Date.now() + Math.max(1, Math.min(
        deps.wslDiscoveryTimeoutMs ?? CLAUDE_COMMAND_LIMITS.maxWslDiscoveryMs,
        CLAUDE_COMMAND_LIMITS.maxWslDiscoveryMs,
      ));
      const distro = request.context.distro;
      let codexHome = request.codexHome && posix.isAbsolute(request.codexHome) ? request.codexHome : undefined;
      if (!codexHome) {
        const home = await executeWithinWslBudget(
          deps.run ?? run, deadline, "wsl.exe", ["-d", distro, "--exec", "printenv", "HOME"], { timeoutMs: 6_000 },
        );
        if (home.timedOut) throw new Error("WSL home lookup timed out");
        if (home.errorCode || home.code !== 0 || !home.stdout.trim()) {
          throw new Error((home.errorCode ?? home.stderr.trim()) || "could not resolve WSL home");
        }
        codexHome = posix.join(home.stdout.trim().split(/\r?\n/, 1)[0]!, ".codex");
      }
      root = (deps.wslPathToWindows ?? wslAbsolutePathToUnc)(distro, posix.join(codexHome, "prompts"));
    }

    const caseSensitiveRoot = request.context.kind === "wsl";
    const discovery = await nativeCommandFiles(root, "user", deadline, {
      caseSensitiveRoot,
      maxDepth: 0,
      openDirectory: (path) => opendir(path),
    });
    const prompts: CodexPromptTemplate[] = [];
    for (const file of discovery.files) {
      let content: string;
      try {
        content = await readBoundedNative(
          file.path, file.canonicalRoot!, deadline, caseSensitiveRoot, (path, flags) => open(path, flags),
        );
      } catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      // Only explicit frontmatter leaves the runner: the body stays launch-local, and Codex's own TUI
      // never derives a description from prompt text either.
      prompts.push({
        name: file.name,
        ...parseClaudeCommandMetadata(content, { descriptionFromBody: false }),
        body: codexPromptBody(content),
      });
    }
    if (discovery.binding) await validateCommandRootBinding(discovery.binding, deadline);
    // Codex prompt names are case-sensitive file stems; keep the first of any case-folded pair so
    // the composer never offers two commands it cannot tell apart.
    const byName = new Map<string, CodexPromptTemplate>();
    for (const prompt of prompts.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const key = prompt.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, prompt);
    }
    return { ok: true, prompts: [...byName.values()] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Codex prompt discovery failed: ${detail || "unknown error"}` };
  }
}

export type CodexPromptPreparationResult =
  | { outcome: "not_applicable" }
  | { outcome: "prepared"; prompts: CodexPromptTemplate[] }
  | { outcome: "failed"; error: string };

/** Discover prompts for one Codex App Server launch. The persisted session catalog carries only
 * display metadata; prompt bodies stay with the launch that read them. */
export async function prepareCodexPromptCatalog(
  meta: Pick<SessionMeta, "driver" | "context" | "env" | "executionTarget">,
  deps: CodexPromptDiscoveryDeps = {},
): Promise<CodexPromptPreparationResult> {
  if (meta.driver !== "codex-app-server") return { outcome: "not_applicable" };
  if (!includeClaudeUserCommandsForTarget(meta.executionTarget?.adapter ?? "host")) {
    return { outcome: "prepared", prompts: [] };
  }
  const discovered = await discoverCodexPrompts({
    context: meta.context,
    ...(meta.env.CODEX_HOME ? { codexHome: meta.env.CODEX_HOME } : {}),
  }, deps);
  return discovered.ok
    ? { outcome: "prepared", prompts: discovered.prompts }
    : { outcome: "failed", error: discovered.error };
}
