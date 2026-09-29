import React, { useState } from "react";
import { isPersonalIdentifier } from "../personal-identifiers.js";
import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "./Icons.js";

/** What a masked value is, so the mask can say what it hides without disclosing any of it. */
export type PersonalIdentifierKind = "email" | "other";

/** The visible words of a mask. They are also its accessible text, so they stay Title Case. */
export const HIDDEN_IDENTIFIER_TEXT: Record<PersonalIdentifierKind, string> = {
  email: "Email Hidden",
  other: "Hidden",
};

/** The leading icon of an identifier, masked or revealed, so revealing it moves the row less. */
function PersonalIdentifierIcon({ kind }: { kind: PersonalIdentifierKind }) {
  return kind === "email" ? <MailIcon size={14} /> : <LockIcon size={14} />;
}

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
  /** Title Case name of what is hidden, e.g. "Account Email", or "Emails" for a picker's toggle. */
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
      className={withText ? "btn sm ghost pid-toggle with-text" : "icon-btn sm pid-toggle"}
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
 * The mask: an icon and the words "Email Hidden" ("Hidden" for other kinds), which are also what
 * assistive technology hears. Nothing about the value itself — not its length, domain or first
 * letter — is part of it.
 */
export function PersonalIdentifierMask({ kind = "email" }: { kind?: PersonalIdentifierKind }) {
  return (
    <span className="pid-mask">
      <PersonalIdentifierIcon kind={kind} />
      <span>{HIDDEN_IDENTIFIER_TEXT[kind]}</span>
    </span>
  );
}

/**
 * Reveal state granted for exactly one `key` — an identifier, or the joined labels of a picker.
 *
 * Any change of key hides again, including a return to an earlier key: revealing A, then showing B,
 * then A again must not bring A back revealed. The reset happens during render (React's documented
 * pattern for state derived from props), so no frame ever paints a newly arrived value unmasked.
 */
export function usePersonalIdentifierReveal(key: string): [revealed: boolean, toggle: () => void] {
  const [grant, setGrant] = useState<{ key: string; revealed: boolean }>({ key, revealed: false });
  if (grant.key !== key) setGrant({ key, revealed: false });
  const revealed = grant.key === key && grant.revealed;
  return [revealed, () => setGrant({ key, revealed: !revealed })];
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
 *
 * A mask never stands alone: the caller puts a visible label before it, either in its own markup
 * (a field label, "Account:") or through `lead`, which is shown only when the value is masked, so
 * an alias still reads as the name it is.
 */
export function PersonalIdentifier({
  value,
  label,
  sensitive,
  kind,
  lead,
  className,
}: {
  value: string;
  /** Title Case name of the value, e.g. "Account Email"; used for the reveal control. */
  label: string;
  sensitive?: boolean;
  /**
   * What the value is. Without `sensitive` a value is masked only because it is email-shaped, so it
   * defaults to "email"; a value forced by provenance defaults to "other" unless the caller knows,
   * so the mask never discloses more about the value than the caller already does.
   */
  kind?: PersonalIdentifierKind;
  /** Visible label before a masked value, such as "Account", for a place with no label of its own. */
  lead?: string;
  className?: string;
}) {
  const [revealed, toggle] = usePersonalIdentifierReveal(value);
  const masked = sensitive ?? isPersonalIdentifier(value);
  if (!masked) return <span className={className}>{value}</span>;
  const shownKind = kind ?? (sensitive ? "other" : "email");
  return (
    <span className={`pid${className ? ` ${className}` : ""}`} data-revealed={revealed}>
      {lead && <span className="pid-lead">{lead}</span>}
      {revealed
        ? (
          <span className="pid-shown">
            <PersonalIdentifierIcon kind={shownKind} />
            <span className="pid-value">{value}</span>
          </span>
        )
        : <PersonalIdentifierMask kind={shownKind} />}
      <PersonalIdentifierRevealButton
        label={label}
        revealed={revealed}
        onToggle={toggle}
      />
    </span>
  );
}
