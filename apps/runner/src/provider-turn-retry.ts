import type { ProviderFailureCategory } from "./drivers/provider-failure.js";

/** Continue provider-owned history instead of replaying potentially completed tools or input. */
export const PROVIDER_RETRY_CONTINUATION = "Continue the interrupted task from the existing conversation. Check what already completed before taking further actions; do not repeat completed work.";

/** Only provider capacity diagnostics belong here, not billing limits or tool failures. */
export function isProviderCapacityFailure(message: string, category?: ProviderFailureCategory | null): boolean {
  if (category != null) return category === "capacity";
  // Provider error categories commonly separate their words with underscores or hyphens.
  const categoryText = message.replace(/[_-]+/g, " ");
  if (/\b(?:mcp[ _-]?server|connector|tool(?:[ _-]?call)?|quota|billing|credit|usage limit|rate limit|context[ _-]?(?:window|length)|auth(?:entication)?|unauthenticated|API key)\b/i.test(categoryText)) return false;
  return /^\s*overloaded\s*$/i.test(message) ||
    /\b(?:overloaded_error|model_capacity_exceeded)\b|\b(?:model|provider)\b[^\n]{0,100}\b(?:at capacity|overloaded|capacity (?:exhausted|exceeded))\b|\binsufficient (?:model )?capacity\b|\bno (?:available )?capacity\b[^\n]{0,80}\bmodel\b/i.test(message);
}
