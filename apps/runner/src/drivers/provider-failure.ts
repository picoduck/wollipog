/** Provider evidence only: display text and tool output never manufacture a category. */
export type ProviderFailureCategory =
  | "capacity" | "authentication" | "permission" | "billing" | "quota" | "rate_limit"
  | "context" | "tool" | "transport" | "invalid_request" | "policy";

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

const codexCategories: Readonly<Record<string, ProviderFailureCategory>> = {
  serverOverloaded: "capacity", flexUnavailable: "capacity",
  contextWindowExceeded: "context", sessionBudgetExceeded: "quota", usageLimitExceeded: "quota",
  rateLimitExceeded: "rate_limit", unauthorized: "authentication", badRequest: "invalid_request",
  sandboxError: "permission", cyberPolicy: "policy", misalignmentPolicyViolation: "policy",
  tooManyDenials: "policy", internalServerError: "transport",
};

/** Codex's generated CodexErrorInfo enum, from the exact turn terminal or rejected turn/start. */
export function codexFailureCategory(error: unknown): ProviderFailureCategory | null {
  const value = record(error);
  if (!value) return null;
  if (value.transportFailure === true) return "transport";
  if (value.code === -32600 || value.code === -32601 || value.code === -32602) return "invalid_request";
  const info = value.codexErrorInfo ?? record(value.data)?.codexErrorInfo;
  if (typeof info === "string") return Object.hasOwn(codexCategories, info) ? codexCategories[info]! : null;
  const tagged = record(info);
  if (!tagged) return null;
  for (const key of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected",
    "responseTooManyFailedAttempts"]) {
    if (Object.hasOwn(tagged, key)) {
      const status = record(tagged[key])?.httpStatusCode;
      if (status === 401) return "authentication";
      if (status === 402) return "billing";
      if (status === 403) return "permission";
      if (status === 429) return "rate_limit";
      if (status === 400 || status === 404 || status === 409 || status === 413) return "invalid_request";
      // The wrapper can carry service/capacity failures as well as transport errors. Preserve
      // fallback for statuses whose category is not established, including ambiguous HTTP 503.
      if (status != null && status !== 500 && status !== 502 && status !== 504) return null;
      return "transport";
    }
  }
  return null;
}

/** Claude's terminal API status (https://platform.claude.com/docs/en/api/errors).
 * 400 and 429 can also describe spend limits; neither grants capacity retry authority. */
export function claudeFailureCategory(result: unknown): ProviderFailureCategory | null {
  const value = record(result);
  if (!value || value.is_error !== true) return null;
  switch (value.api_error_status) {
    case 529: return "capacity";
    case 401: return "authentication";
    case 402: return "billing";
    case 403: return "permission";
    case 429: return "rate_limit";
    case 400: case 404: case 409: case 413: return "invalid_request";
    case 500: case 502: case 503: case 504: return "transport";
    default: return null;
  }
}
