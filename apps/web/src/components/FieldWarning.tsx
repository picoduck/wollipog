import type { ReactNode } from "react";
import { WarningIcon } from "./Icons.js";

/**
 * A non-blocking warning about a field's valid value (docs/design-system.md §8.5), under its
 * helper. Unlike a field error it never blocks submission, so the words stay in the helper's color
 * and only the icon carries the warning tone. Pass `id` and point the field's `aria-describedby`
 * at it, which names the words alone: `action`, at most one `.btn.sm` that applies the fix they
 * name, follows them without becoming part of the description.
 */
export function FieldWarning({ id, children, action }: { id?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <p className="field-warn">
      <WarningIcon className="field-warn-icon" size={14} aria-hidden="true" />
      <span id={id}>{children}</span>
      {action}
    </p>
  );
}
