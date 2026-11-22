import { ASSISTANT_TRANSCRIPT_RECEIPT_KEY } from "@wollipog/protocol";

const receiptPrefix = new RegExp(`^\\s*\\{\\s*"${ASSISTANT_TRANSCRIPT_RECEIPT_KEY}"\\s*:\\s*"([a-f0-9-]{36})"`, "u");

/** Assistant results put the control plane's opaque key first. Only read the small prefix, even
 * when a provider sent a large or truncated result. Callers must identify the Assistant tool. */
export function assistantTranscriptReceiptKey(text: unknown): string | undefined {
  return typeof text === "string" ? receiptPrefix.exec(text.slice(0, 128))?.[1] : undefined;
}
