/**
 * Display privacy for structured personal identifiers.
 *
 * A provider-reported account email is personal information, and the dashboard is often on a
 * shared or streamed screen. App-controlled identity surfaces therefore render these values masked
 * until a person explicitly reveals one, and that reveal lives only in the component instance that
 * showed it: nothing here is persisted, so a reload or another surface starts hidden again.
 *
 * Two kinds of value reach those surfaces:
 * - provider-reported identifiers (the email a Claude or Codex login reports) are always personal;
 * - user-chosen aliases (a provider account label such as "Work", a person's display name) help
 *   people tell accounts apart and stay visible — unless the alias itself is an email address,
 *   which is how people often name accounts.
 *
 * This is structured-field treatment only. Transcripts, user-authored content, and artifacts are
 * never scanned: detecting arbitrary email-like text there is unreliable and would hide content the
 * reader needs.
 */

// Deliberately broad: a false positive only costs one explicit reveal, while a miss exposes the value.
const EMAIL_ADDRESS = /[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"'.]+/u;
const EMAIL_ADDRESSES = new RegExp(EMAIL_ADDRESS.source, "gu");

/** Fixed-length so the mask never discloses the hidden value's length. */
export const MASKED_IDENTIFIER = "••••••••";

/** Safe stand-in for a hidden account label inside sentences, tooltips, and notifications. */
export const HIDDEN_ACCOUNT = "Hidden Account";

/** Whether an alias or display value carries an email address and must be masked by default. */
export function isPersonalIdentifier(value: string | null | undefined): boolean {
  return typeof value === "string" && EMAIL_ADDRESS.test(value);
}

/**
 * Text for a label that must appear inside a plain string — a toast, `title`, `aria-label`, or
 * sentence — where no reveal control can accompany it. A personal identifier becomes `hidden`.
 */
export function accountLabelText(label: string, hidden = HIDDEN_ACCOUNT): string {
  return isPersonalIdentifier(label) ? hidden : label;
}

/**
 * Replace every email address in app-generated status text (for example a server detail that
 * names an account label). Never apply this to transcripts or user-authored content.
 */
export function redactPersonalIdentifiers(text: string, replacement = HIDDEN_ACCOUNT): string {
  return text.replace(EMAIL_ADDRESSES, replacement);
}

/**
 * Picker titles for a list of labels. Aliases pass through; hidden identifiers become `hidden`,
 * numbered in list order when several are hidden so the choices stay distinct without revealing
 * any of them.
 */
export function maskedAccountTitles(labels: readonly string[], hidden = HIDDEN_ACCOUNT): string[] {
  const hiddenCount = labels.filter(isPersonalIdentifier).length;
  let ordinal = 0;
  return labels.map((label) => {
    if (!isPersonalIdentifier(label)) return label;
    ordinal += 1;
    return hiddenCount > 1 ? `${hidden} ${ordinal}` : hidden;
  });
}
