import type { SessionEvent } from "@wollipog/protocol";

export const SESSION_TITLE_MAX_LENGTH = 120;
export const TITLE_CONTEXT_MAX_MESSAGES = 9;
export const TITLE_CONTEXT_MAX_CHARS = 12_000;
export const TITLE_CONTEXT_REDACTION_MAX_CHARS = 64 * 1_024;

export interface SessionTitleMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionTitleRequest {
  /** Present for control-plane initiated naming so runtime organization settings can be resolved. */
  sessionId?: string;
  messages: readonly SessionTitleMessage[];
  signal: AbortSignal;
}

export type SessionTitleGenerator = (request: SessionTitleRequest) => Promise<string>;

/** Accept plain text or a small JSON envelope, then apply the same durable title rules as manual
 * renames. Model chatter, markdown headings, and malformed/multiline output fail closed. */
export function normalizeGeneratedSessionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    try {
      const parsed = JSON.parse(candidate) as { title?: unknown };
      if (typeof parsed.title !== "string") return null;
      candidate = parsed.title.trim();
    } catch {
      return null;
    }
  }
  if (!candidate || candidate.includes("\n") || candidate.includes("\r")) return null;
  candidate = candidate.replace(/^#{1,6}\s+/, "").replace(/^["'`]|["'`]$/g, "").replace(/\s+/g, " ").trim();
  if (!candidate || candidate.length > SESSION_TITLE_MAX_LENGTH) return null;
  return candidate;
}

/** Keep only completed semantic conversation messages. Images, thoughts, tools, command output,
 * partial streaming chunks, and queued submissions are excluded by construction. */
export function boundedSessionTitleContext(
  events: readonly SessionEvent[],
  transformText: (text: string) => string = (text) => text,
): SessionTitleMessage[] {
  const messages = events.flatMap((event): SessionTitleMessage[] => {
    const payload = event.payload;
    if (payload.kind === "user_message" && payload.final !== false && !payload.commandInvocation) {
      return [{
        role: "user",
        text: transformText(payload.text.slice(0, TITLE_CONTEXT_REDACTION_MAX_CHARS)).trim(),
      }];
    }
    if (payload.kind === "agent_message" && payload.final === true && !payload.parentToolUseId) {
      return [{
        role: "assistant",
        text: transformText(payload.text.slice(0, TITLE_CONTEXT_REDACTION_MAX_CHARS)).trim(),
      }];
    }
    return [];
  }).filter((message) => message.text);
  if (!messages.length) return [];

  // Preserve the original objective and add the newest completed context within both bounds.
  const first = messages[0]!;
  const recent = messages.slice(1).reverse();
  const selected: SessionTitleMessage[] = [first];
  let chars = first.text.length;
  for (const message of recent) {
    if (selected.length >= TITLE_CONTEXT_MAX_MESSAGES) break;
    const remaining = TITLE_CONTEXT_MAX_CHARS - chars;
    if (remaining <= 0) break;
    selected.splice(1, 0, { ...message, text: message.text.slice(0, remaining) });
    chars += Math.min(message.text.length, remaining);
  }
  return selected.map((message) => ({ ...message, text: message.text.slice(0, TITLE_CONTEXT_MAX_CHARS) }));
}

interface OpenAiTitleConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
}

export function openAiCompatibleTitleGenerator(config: OpenAiTitleConfig): SessionTitleGenerator {
  return async ({ messages, signal }) => {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: "Return one concise semantic title for this coding session. Use plain text only, no quotes, no markdown, and at most 120 characters.",
          },
          ...messages.map((message) => ({ role: message.role, content: message.text })),
        ],
        temperature: 0,
        max_tokens: 40,
        reasoning_effort: "minimal",
      }),
      signal,
    });
    if (!response.ok) throw new Error(`title model returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("title model returned no text");
    return content;
  };
}

export function sessionTitleGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  generator?: SessionTitleGenerator;
  timeoutMs: number;
  customModel?: { endpoint: string; model: string; apiKeyConfigured: boolean };
} {
  const endpoint = env.WOLLIPOG_TITLE_MODEL_URL?.trim();
  const model = env.WOLLIPOG_TITLE_MODEL?.trim();
  const configuredTimeout = env.WOLLIPOG_TITLE_MODEL_TIMEOUT_MS?.trim();
  const rawTimeout = Number(configuredTimeout || 5_000);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(30_000, Math.max(250, Math.floor(rawTimeout))) : 5_000;
  if (!endpoint || !model || env.WOLLIPOG_TITLE_GENERATION?.trim().toLowerCase() === "disabled") {
    return { timeoutMs };
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { timeoutMs };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { timeoutMs };
  return {
    generator: openAiCompatibleTitleGenerator({
      endpoint: parsed.toString(),
      model,
      apiKey: env.WOLLIPOG_TITLE_MODEL_API_KEY?.trim() || undefined,
    }),
    timeoutMs,
    customModel: {
      endpoint: parsed.toString(),
      model,
      apiKeyConfigured: Boolean(env.WOLLIPOG_TITLE_MODEL_API_KEY?.trim()),
    },
  };
}
