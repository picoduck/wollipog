import type { WollipogPromptOrigin } from "@wollipog/protocol";

type ConfirmationOrigin = Extract<WollipogPromptOrigin, { kind: "owner_confirmation" }>;
export type TimelinePromptOrigin = WollipogPromptOrigin | Omit<ConfirmationOrigin, "confirmationId">;

/** Older runners/control planes delivered the same text without display metadata. */
export function legacyOwnerConfirmationOrigin(text: string): TimelinePromptOrigin | undefined {
  const prefix = "[Wollipog Owner Confirmation] ";
  if (!text.startsWith(prefix)) return undefined;
  const notice = text.slice(prefix.length);
  const head = /^(Your owner approved|Your owner denied|Your request for) "([^"]+)" \([\w-]+\) on (\w+) ([\s\S]+?) \(([^()]+)\), command /.exec(notice);
  if (!head) return { kind: "system_notice" };
  const [, lead, title, kind, label, id] = head;
  const tail = notice.slice(head[0].length);
  const outcome = lead === "Your owner approved" ? "approved"
    : lead === "Your owner denied" ? "denied"
    : tail.includes(" expired before your owner answered.") ? "expired"
    : "refused";
  const receipt = /Wollipog ran it once; its receipt reads (accepted|running|succeeded|failed|uncertain)\./.exec(tail);
  return {
    kind: "owner_confirmation", title: title!, outcome, target: { kind: kind!, id: id!, label: label! },
    ...(receipt ? { receiptStatus: receipt[1] as ConfirmationOrigin["receiptStatus"] } : {}),
  };
}
