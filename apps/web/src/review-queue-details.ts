import type { ApprovalQueueItem } from "@wollipog/protocol";

export interface ApprovalQueueDetail {
  label: string;
  input: string;
}

/**
 * Return the runner-bounded approval trust surface without rewriting or truncating it. The
 * control plane already caps this field; the phone queue must show those exact bytes instead of
 * replacing them with the shorter approval title.
 */
export function approvalQueueDetail(item: ApprovalQueueItem): ApprovalQueueDetail | null {
  const input = item.approval.context?.input;
  if (typeof input !== "string" || input.length === 0) return null;
  const toolName = item.approval.context?.toolName?.trim();
  return {
    label: toolName ? `Exact Command or Tool Input · ${toolName}` : "Exact Command or Tool Input",
    input,
  };
}
