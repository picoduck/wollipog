import type { ReactNode } from "react";
import { ErrorIcon } from "./Icons.js";

/**
 * A field's error (docs/design-system.md §8.5): it replaces the helper under the field, with a 14px
 * `CircleAlert` and `--type-small` text in `--danger-text`. The field carries `aria-invalid="true"`
 * and points its `aria-describedby` at `id` while the error shows, which is why `id` is required.
 * Not an alert: on submit, focus moves to the first invalid field, which announces it. The message
 * is one sentence that says what is wrong and how to fix it. The sibling of FieldWarning, which
 * never blocks.
 */
export function FieldError({ id, children, as: Tag = "p", className }: {
  id: string;
  children: ReactNode;
  /** `span` inside phrasing content, such as a choice row's label. */
  as?: "p" | "span";
  className?: string;
}) {
  return (
    <Tag className={`field-error${className ? ` ${className}` : ""}`} id={id}>
      <ErrorIcon className="field-error-icon" size={14} aria-hidden="true" />
      <span>{children}</span>
    </Tag>
  );
}
