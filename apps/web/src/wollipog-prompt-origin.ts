import { OWNER_CONFIRMATION_NOTICE_PREFIX, type WollipogPromptOrigin } from "@wollipog/protocol";

export type TimelinePromptOrigin = WollipogPromptOrigin | { kind: "legacy_confirmation" };

/** Legacy history lacks trustworthy provenance. Recognize the envelope without deriving
 * an authorization, receipt, or navigation target from conversational text. */
export function legacyOwnerConfirmationOrigin(text: string): TimelinePromptOrigin | undefined {
  if (!text.startsWith(OWNER_CONFIRMATION_NOTICE_PREFIX + " ")) return undefined;
  const notice = text.slice(OWNER_CONFIRMATION_NOTICE_PREFIX.length + 1);
  if (!/^(Your owner approved |Your owner denied |Your request for )"/.test(notice)) return undefined;
  return { kind: "legacy_confirmation" };
}
