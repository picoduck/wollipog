import type {
  SessionNamingAccountBoundary,
  SessionNamingConnectionTestResult,
  SessionNamingMode,
  SessionNamingSettingsView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { effortLabel } from "../format.js";
import type { SelectOption } from "./ui/ChoiceControls.js";

/**
 * Settings › Behavior › Session Titles (#3025): the words and rules the group and its two dialogs
 * share. The protocol's mode values are unchanged; only what a person reads is.
 */

/** Without owner or admin permission every source is refused, with this as the visible reason. */
export const TITLE_SOURCE_NO_PERMISSION = "Only an organization owner or admin can change this.";

export const LOAD_FAILED = "Couldn't load session title settings.";

/** A request that never reached Wollipog: the browser's own words for it ("Failed to fetch") say nothing useful. */
const UNREACHABLE = "Check the connection, then try again.";

const SOURCES: ReadonlyArray<{ value: SessionNamingMode; label: string; description: string }> = [
  { value: "prompt_text_only", label: "First Message", description: "Use your first message. No model needed." },
  { value: "session_agent_account", label: "Agent", description: "An agent on one of your machines writes the title." },
  { value: "custom_model_endpoint", label: "Custom Endpoint", description: "An OpenAI-compatible endpoint you run writes the title." },
];

/**
 * The Title Source options. Agent and Custom Endpoint stay choosable while there is somewhere to set
 * them up (a machine with an agent, a machine to send through) even if they are not usable yet: the
 * dialog is how they become usable. An option that cannot be used shows its reason as its second line.
 */
export function titleSourceOptions(settings: SessionNamingSettingsView | null): SelectOption<SessionNamingMode>[] {
  return SOURCES.map((source) => {
    if (!settings) return { ...source };
    const availability = settings.modes[source.value];
    const settable = source.value === "session_agent_account"
      ? Boolean(settings.harnessMachines?.length) || availability.available
      : source.value === "custom_model_endpoint"
        ? Boolean(settings.customModelTargets?.length) || availability.available
        : availability.available;
    const reason = !settings.canManage && source.value !== "prompt_text_only"
      ? TITLE_SOURCE_NO_PERMISSION
      : settable ? undefined : availability.reason ?? "Not available on this server.";
    return reason ? { ...source, disabled: true, disabledReason: reason } : { ...source };
  });
}

const PROVIDERS: Record<SessionNamingAccountBoundary["provider"], string> = { claude: "Claude", codex: "Codex" };

const SIGN_IN: Record<SessionNamingAccountBoundary["billingSource"], string> = {
  subscription: "signed in with a subscription",
  api: "using an API key",
  bedrock: "through Amazon Bedrock",
  vertex: "through Google Vertex AI",
  gateway: "through a gateway",
  provider_account: "signed in with a provider account",
  unknown: "sign-in not reported",
};

/** An agent by its provider and how it signs in: "Claude, signed in with a subscription". */
export function agentDescription(agent: Pick<SessionNamingAccountBoundary, "provider" | "billingSource">): string {
  return `${PROVIDERS[agent.provider]}, ${SIGN_IN[agent.billingSource]}`;
}

function endpointHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** The set-up source in sentence case, for the row under Title Source. Null for First Message. */
export function setupSummary(settings: SessionNamingSettingsView): { title: string; description?: string } | null {
  if (settings.mode === "session_agent_account") {
    const target = settings.harnessTarget;
    // A migrated preference with no target follows each session's own agent.
    if (!target) return { title: "Each session uses its own agent" };
    return {
      title: `${target.harnessName} on ${target.machineName}`,
      description: `${target.modelName}, ${effortLabel(target.effort).toLowerCase()} effort`,
    };
  }
  if (settings.mode === "custom_model_endpoint") {
    const custom = settings.customModel;
    if (!custom) return { title: "Custom endpoint not set up" };
    const host = endpointHost(custom.endpointOrigin);
    if (custom.configurationSource === "environment") {
      return { title: host, description: `${custom.model}, set on the server` };
    }
    return {
      title: custom.machineName ? `${host} through ${custom.machineName}` : host,
      description: `${custom.model}, ${custom.timeoutMs.toLocaleString("en-US")} ms timeout`,
    };
  }
  return null;
}

/** When the chosen source cannot be used, why, and what new sessions do instead. */
export function fallbackSentence(settings: SessionNamingSettingsView): string | null {
  if (settings.mode === settings.effectiveMode) return null;
  const reason = settings.mode === "session_agent_account"
    ? settings.harnessTarget?.reason ?? settings.modes.session_agent_account.reason
    : settings.modes[settings.mode].reason;
  return `${reason ?? "This source isn't available right now."} New sessions use their first message instead.`;
}

/** What went wrong, in plain words, and the server's own words (if it answered) for Show Details. */
export interface PlainFailure {
  message: string;
  detail?: string;
}

/** `sentence` says what did not happen. A request that never reached the server adds how to fix it
 * and keeps the browser's words ("Failed to fetch", "Load failed") out of sight. */
export function plainFailure(cause: unknown, sentence: string, retry = "Try again."): PlainFailure {
  if (!(cause instanceof ApiError)) return { message: `${sentence} ${UNREACHABLE}` };
  const detail = cause.message.trim();
  return { message: `${sentence} ${retry}`.trim(), ...(detail ? { detail } : {}) };
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const MIN_TIMEOUT_MS = 250;
export const MAX_TIMEOUT_MS = 30_000;
const MAX_MODEL_LENGTH = 200;

function loopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

/**
 * The server's endpoint rules, said before the request: an http or https URL without credentials,
 * a query or a fragment, and https for a key unless the endpoint is loopback-only.
 */
export function endpointUrlError(value: string, sendsKey: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full URL, starting with https://.";
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    return "Enter a full URL, starting with https://.";
  }
  if (sendsKey && url.protocol !== "https:" && !loopback(url)) return "Use an https:// URL to send an API key.";
  return null;
}

export function modelIdError(value: string): string | null {
  const model = value.trim();
  if (!model) return "Enter the model ID.";
  if (model.length > MAX_MODEL_LENGTH || /[\0-\x1f\x7f]/u.test(model)) return "Enter a model ID of up to 200 characters.";
  return null;
}

export function timeoutError(value: string): string | null {
  const timeout = Number(value);
  return value.trim() && Number.isInteger(timeout) && timeout >= MIN_TIMEOUT_MS && timeout <= MAX_TIMEOUT_MS
    ? null
    : "Enter a timeout from 250 to 30,000 ms.";
}

/** Test Connection's answer, as a compact notice in the dialog. */
export function connectionResult(result: SessionNamingConnectionTestResult): { tone: "success" | "warning"; message: string } {
  switch (result.status) {
    case "available": return { tone: "success", message: "The endpoint answered." };
    case "authentication_failed": return { tone: "warning", message: "The endpoint refused the API key." };
    case "timed_out": return { tone: "warning", message: "The endpoint didn't answer in time." };
    case "endpoint_failed": return { tone: "warning", message: "The endpoint answered with an error." };
    default: return { tone: "warning", message: "The machine couldn't reach the endpoint." };
  }
}
