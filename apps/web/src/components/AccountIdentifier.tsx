import React from "react";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { accountLabelText } from "../personal-identifiers.js";
import { PersonalIdentifier, PersonalIdentifierRevealButton, usePersonalIdentifierReveal } from "./PersonalIdentifier.js";

/** Provider account identifiers follow the device preference; other personal fields keep theirs. */
export function AccountIdentifier({ identity = "", ...props }: React.ComponentProps<typeof PersonalIdentifier> & {
  /** Include IDs or an open-surface scope when accounts can share a label. */
  identity?: string;
}) {
  const privacy = useAccountEmailPrivacy();
  if (!privacy.hide) {
    return <span className={`pid-value${props.className ? ` ${props.className}` : ""}`}>{props.value}</span>;
  }
  return <PersonalIdentifier key={JSON.stringify([privacy.revision, identity, props.value])} {...props} />;
}

export function useAccountIdentifierReveal(identity: string): [boolean, () => void] {
  const privacy = useAccountEmailPrivacy();
  const [revealed, toggle] = usePersonalIdentifierReveal(JSON.stringify([privacy.revision, identity]));
  return [!privacy.hide || revealed, toggle];
}

export function AccountIdentifierRevealButton(props: React.ComponentProps<typeof PersonalIdentifierRevealButton>) {
  const privacy = useAccountEmailPrivacy();
  return privacy.hide ? <PersonalIdentifierRevealButton {...props} /> : null;
}

/** Live text for generated sentences, including toasts retained outside the caller's render. */
export function AccountLabel({ value, hidden }: { value: string; hidden?: string }) {
  const privacy = useAccountEmailPrivacy();
  return accountLabelText(value, hidden, privacy.hide);
}
