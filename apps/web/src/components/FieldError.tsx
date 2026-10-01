import type { ReactNode } from "react";
import { ErrorIcon } from "./Icons.js";

/**
 * A field's error (docs/design-system.md §8.5): it replaces the helper under the field, with a 14px
 * `CircleAlert` and `--type-small` text in `--danger-text`. The field carries `aria-invalid="true"`
 * and points its `aria-describedby` at `id`. The sibling of FieldWarning, which never blocks.
 */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p className="field-error" id={id}>
      <ErrorIcon className="field-error-icon" size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
