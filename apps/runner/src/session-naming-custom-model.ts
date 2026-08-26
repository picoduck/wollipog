import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  GenerateSessionTitleMessage,
  GenerateSessionTitleResultMessage,
  SessionNamingCustomModelErrorCode,
  SessionNamingCustomModelResultMessage,
} from "@wollipog/protocol";
import { normalizeRunnerSessionTitle } from "./session-naming.js";

const CONFIG_FILE = "custom-model.json";
const API_KEY_FILE = "custom-model.key";
const MAX_CONFIG_BYTES = 8 * 1024;
const MAX_API_KEY_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 200;
const MAX_INPUT_MESSAGES = 9;
const MAX_INPUT_CHARS = 12_000;
const MAX_CONCURRENT_REQUESTS = 2;
const RATE_LIMIT_STARTS = 12;
const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RunnerSessionNamingCustomModelConfig {
  endpoint: string;
  model: string;
  timeoutMs: number;
}

export interface RunnerSessionNamingCustomModelStatus {
  configured: boolean;
  apiKeyConfigured: boolean;
  configDigest?: string;
}

class CustomModelFailure extends Error {
  override readonly name = "CustomModelFailure";
  constructor(readonly code: SessionNamingCustomModelErrorCode) {
    super(code);
  }
}

function validateConfig(input: RunnerSessionNamingCustomModelConfig): RunnerSessionNamingCustomModelConfig {
  if (typeof input.endpoint !== "string" || !input.endpoint.trim() || input.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new CustomModelFailure("invalid_configuration");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint.trim());
  } catch {
    throw new CustomModelFailure("invalid_configuration");
  }
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.search) {
    throw new CustomModelFailure("invalid_configuration");
  }
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > MAX_MODEL_LENGTH || /[\0-\x1f\x7f]/u.test(model)) {
    throw new CustomModelFailure("invalid_configuration");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS) {
    throw new CustomModelFailure("invalid_configuration");
  }
  return { endpoint: endpoint.toString(), model, timeoutMs: input.timeoutMs };
}

function validateApiKey(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_API_KEY_BYTES || /[\0\r\n]/u.test(value)) {
    throw new CustomModelFailure("invalid_configuration");
  }
  return value;
}

function endpointProtectsApiKey(endpoint: string): boolean {
  const url = new URL(endpoint);
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

export function sessionNamingCustomModelDigest(config: RunnerSessionNamingCustomModelConfig): string {
  return createHash("sha256")
    .update(`${config.endpoint}\0${config.model}\0${config.timeoutMs}`)
    .digest("hex");
}

function ensureProtectedDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe session naming secret directory");
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are owned by the runner account. */ }
}

function protectedRead(file: string, maxBytes: number): Buffer {
  if (lstatSync(file).isSymbolicLink()) throw new Error("unsafe symlinked session naming secret file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error("unsafe session naming secret file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function protectedReplace(file: string, contents: string): void {
  ensureProtectedDirectory(dirname(file));
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error("refusing to replace a symlinked session naming secret file");
  }
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try { chmodSync(temp, 0o600); } catch { /* Windows ACLs are owned by the runner account. */ }
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are owned by the runner account. */ }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new CustomModelFailure("endpoint_failed");
  if (!response.body) throw new CustomModelFailure("endpoint_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new CustomModelFailure("endpoint_failed");
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CustomModelFailure("endpoint_failed");
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Failure diagnostics are deliberately ignored and never returned or logged.
  }
}

export class RunnerSessionNamingCustomModel {
  private readonly configFile: string;
  private readonly apiKeyFile: string;
  private activeRequests = 0;
  private readonly recentStarts: number[] = [];

  constructor(root: string) {
    this.configFile = join(root, CONFIG_FILE);
    this.apiKeyFile = join(root, API_KEY_FILE);
  }

  private readConfig(): RunnerSessionNamingCustomModelConfig | null {
    try {
      const parsed = JSON.parse(protectedRead(this.configFile, MAX_CONFIG_BYTES).toString("utf8")) as
        Partial<RunnerSessionNamingCustomModelConfig>;
      return validateConfig(parsed as RunnerSessionNamingCustomModelConfig);
    } catch {
      return null;
    }
  }

  private readApiKey(): string | undefined {
    try {
      return validateApiKey(protectedRead(this.apiKeyFile, MAX_API_KEY_BYTES).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  status(): RunnerSessionNamingCustomModelStatus {
    const config = this.readConfig();
    return {
      configured: config !== null,
      apiKeyConfigured: this.readApiKey() !== undefined,
      ...(config ? { configDigest: sessionNamingCustomModelDigest(config) } : {}),
    };
  }

  configure(input: RunnerSessionNamingCustomModelConfig, apiKey?: string): RunnerSessionNamingCustomModelStatus {
    const config = validateConfig(input);
    const validatedKey = apiKey === undefined ? undefined : validateApiKey(apiKey);
    if ((validatedKey !== undefined || this.readApiKey() !== undefined) && !endpointProtectsApiKey(config.endpoint)) {
      throw new CustomModelFailure("invalid_configuration");
    }
    protectedReplace(this.configFile, `${JSON.stringify(config)}\n`);
    if (validatedKey !== undefined) protectedReplace(this.apiKeyFile, validatedKey);
    return this.status();
  }

  deleteApiKey(): RunnerSessionNamingCustomModelStatus {
    rmSync(this.apiKeyFile, { force: true });
    return this.status();
  }

  async generate(messages: GenerateSessionTitleMessage["messages"], timeoutOverride?: number): Promise<string> {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_INPUT_MESSAGES ||
        messages.some((message) => (message.role !== "user" && message.role !== "assistant") ||
          typeof message.text !== "string" || !message.text) ||
        messages.reduce((total, message) => total + message.text.length, 0) > MAX_INPUT_CHARS) {
      throw new CustomModelFailure("invalid_configuration");
    }
    const config = this.readConfig();
    if (!config) throw new CustomModelFailure("unavailable");
    const now = Date.now();
    while (this.recentStarts.length && now - this.recentStarts[0]! >= RATE_LIMIT_WINDOW_MS) this.recentStarts.shift();
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS || this.recentStarts.length >= RATE_LIMIT_STARTS) {
      throw new CustomModelFailure("rate_limited");
    }
    this.activeRequests += 1;
    this.recentStarts.push(now);
    const timeoutMs = timeoutOverride === undefined
      ? config.timeoutMs
      : Math.min(config.timeoutMs, Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutOverride)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const apiKey = this.readApiKey();
      if (apiKey && !endpointProtectsApiKey(config.endpoint)) throw new CustomModelFailure("endpoint_failed");
      let response: Response;
      try {
        response = await fetch(config.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
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
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new CustomModelFailure("timed_out");
        throw new CustomModelFailure("endpoint_failed");
      }
      if (response.status === 401 || response.status === 403) {
        await discardResponseBody(response);
        throw new CustomModelFailure("authentication_failed");
      }
      if (!response.ok) {
        await discardResponseBody(response);
        throw new CustomModelFailure("endpoint_failed");
      }
      const body = await boundedJson(response) as { choices?: Array<{ message?: { content?: unknown } }> };
      const title = normalizeRunnerSessionTitle(body.choices?.[0]?.message?.content);
      if (!title) throw new CustomModelFailure("endpoint_failed");
      return title;
    } finally {
      clearTimeout(timer);
      this.activeRequests -= 1;
    }
  }

  async test(): Promise<void> {
    await this.generate([{ role: "user", text: "Connection test" }]);
  }

  async generateResult(message: GenerateSessionTitleMessage): Promise<GenerateSessionTitleResultMessage> {
    try {
      return {
        type: "generate_session_title_result",
        requestId: message.requestId,
        ok: true,
        title: await this.generate(message.messages, message.timeoutMs),
        provider: "custom",
        billingSource: "api",
      };
    } catch (error) {
      const code = error instanceof CustomModelFailure && error.code === "timed_out"
        ? "timed_out" as const
        : error instanceof CustomModelFailure && error.code === "rate_limited"
          ? "rate_limited" as const
        : error instanceof CustomModelFailure && error.code === "unavailable"
          ? "provider_unsupported" as const
          : "provider_failed" as const;
      return { type: "generate_session_title_result", requestId: message.requestId, ok: false, code };
    }
  }

  result(
    requestId: string,
    operation: SessionNamingCustomModelResultMessage["operation"],
    work: () => RunnerSessionNamingCustomModelStatus,
  ): SessionNamingCustomModelResultMessage {
    try {
      return { type: "session_naming_custom_model_result", requestId, operation, ok: true, status: work() };
    } catch (error) {
      return {
        type: "session_naming_custom_model_result",
        requestId,
        operation,
        ok: false,
        code: error instanceof CustomModelFailure ? error.code : "unavailable",
      };
    }
  }

  async testResult(requestId: string): Promise<SessionNamingCustomModelResultMessage> {
    try {
      await this.test();
      return { type: "session_naming_custom_model_result", requestId, operation: "test", ok: true, status: this.status() };
    } catch (error) {
      return {
        type: "session_naming_custom_model_result",
        requestId,
        operation: "test",
        ok: false,
        code: error instanceof CustomModelFailure ? error.code : "unavailable",
      };
    }
  }
}
