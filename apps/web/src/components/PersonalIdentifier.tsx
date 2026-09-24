import React, { useState } from "react";
import { isPersonalIdentifier, MASKED_IDENTIFIER } from "../personal-identifiers.js";
import { EyeIcon, EyeOffIcon } from "./Icons.js";

/**
 * Explicit reveal control shared by an inline identifier and by a picker that hides several at
 * once. Its accessible name and tooltip describe the action only; they never carry the value.
 */
export function PersonalIdentifierRevealButton({
  label,
  revealed,
  onToggle,
  controls,
  withText = false,
}: {
  /** Title Case name of what is hidden, e.g. "Account Email" or "Account Emails". */
  label: string;
  revealed: boolean;
  onToggle: () => void;
  controls?: string;
  /** Show the action as text beside the icon, for picker-level toggles with room for it. */
  withText?: boolean;
}) {
  const action = `${revealed ? "Hide" : "Show"} ${label}`;
  return (
    <button
      type="button"
      className={`personal-identifier-toggle${withText ? " with-text" : ""}`}
      aria-label={withText ? undefined : action}
      aria-controls={controls}
      title={withText ? undefined : action}
      onClick={onToggle}
    >
      {revealed ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      {withText && <span>{action}</span>}
    </button>
  );
}

/**
 * A structured personal identifier, masked until the person explicitly reveals it.
 *
 * While masked the value is absent from the DOM entirely — not in text, a tooltip, an accessible
 * name, or a data attribute — so neither assistive technology, copy, nor an alternate layout can
 * expose it. The reveal is bound to the exact value it was granted for: when the value changes (an
 * account switched while the card stayed open) it is hidden again, and it is never persisted.
 *
 * Non-sensitive aliases render as plain text. `sensitive` forces masking for values that are
 * personal by provenance, such as a provider-reported email, whatever their shape.
 */
export function PersonalIdentifier({
  value,
  label,
  sensitive,
  className,
}: {
  value: string;
  /** Title Case name of the value, e.g. "Account Email"; used for the reveal control. */
  label: string;
  sensitive?: boolean;
  className?: string;
}) {
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const masked = sensitive ?? isPersonalIdentifier(value);
  if (!masked) return <span className={className}>{value}</span>;
  const revealed = revealedValue === value;
  return (
    <span className={`personal-identifier${className ? ` ${className}` : ""}`} data-revealed={revealed}>
      {revealed
        ? <span className="personal-identifier-value">{value}</span>
        : (
          <span className="personal-identifier-mask">
            <span aria-hidden="true">{MASKED_IDENTIFIER}</span>
            <span className="sr-only">Hidden</span>
          </span>
        )}
      <PersonalIdentifierRevealButton
        label={label}
        revealed={revealed}
        onToggle={() => setRevealedValue(revealed ? null : value)}
      />
    </span>
  );
}
