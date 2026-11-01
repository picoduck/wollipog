import type { InstancePairingError } from "../instance-pairing.js";

/** The instance dialog's three forms (#3003). */
export type RemoteInstanceDialogMode = "add" | "edit" | "repair";

/** The fields whose errors the dialog shows under them (§8.5). */
export type RemoteInstanceField = "label" | "link" | "origin" | "token";

export const NOT_A_PAIRING_LINK = "This isn't a Wollipog pairing link. Copy the whole link, including #pair=.";
export const HTTPS_REQUIRED = "Use an https:// address. http:// works only for this computer or a Tailscale address.";
export const NAME_REQUIRED = "Enter a name for the instance.";

/**
 * What a field says when instance-pairing.ts refuses it: one sentence in the person's words, what is
 * wrong and how to fix it (§8.5). The parser's own messages name its rules ("ending in
 * #pair=<token>", "100.64.0.0/10"); the codes say which rule failed, so the sentence is chosen here.
 */
export function pairingFieldError(error: Pick<InstancePairingError, "code" | "field">): string {
  if (error.code === "CLEARTEXT_NOT_ALLOWED") return HTTPS_REQUIRED;
  switch (error.field) {
    case "link":
      return error.code === "EMPTY_INPUT" ? "Paste the pairing link from the other computer." : NOT_A_PAIRING_LINK;
    case "origin":
      if (error.code === "EMPTY_INPUT") return "Enter the server address.";
      if (
        error.code === "PATH_NOT_ALLOWED"
        || error.code === "QUERY_NOT_ALLOWED"
        || error.code === "FRAGMENT_NOT_ALLOWED"
        || error.code === "CREDENTIALS_NOT_ALLOWED"
      ) return "Enter only the address, such as https://studio.example.com, with nothing after it.";
      return "Enter the full address, starting with https://.";
    case "token":
      return error.code === "EMPTY_INPUT"
        ? "Enter the pairing code."
        : "This isn't a complete pairing code. Copy the whole code from Manual Setup.";
  }
}

/** Re-Pair: the link names another address than the profile's (#3003). */
export function repairMismatchError(name: string): string {
  return `This link is for a different address than ${name}. Create the link on ${name}.`;
}

/** Edit: the replacement link names another address than the one just entered. */
export function editMismatchError(origin: string): string {
  return `This link is for a different address than ${origin}. Create the link on the instance at that address.`;
}

export interface RemoteInstanceFailure {
  /** Title Case: what did not happen. */
  title: string;
  /** One sentence in the person's words, with what to do next. */
  message: string;
  /** The desktop app's own words, behind Show Details. */
  detail?: string;
}

const FAILURE_TITLES: Record<RemoteInstanceDialogMode, string> = {
  add: "Couldn't Add the Instance",
  edit: "Couldn't Save the Changes",
  repair: "Couldn't Re-Pair the Instance",
};

/**
 * A failure after submit (§7.3, §13.2): the desktop app refused or could not reach the other
 * instance. Its strings come from instances.rs and remote_transport.rs, which have no codes for
 * these commands, so the sentence is chosen by what the message says; anything unrecognised still
 * keeps its raw words behind Show Details.
 */
export function remoteInstanceFailure(cause: unknown, mode: RemoteInstanceDialogMode): RemoteInstanceFailure {
  const raw = (cause instanceof Error ? cause.message
    : cause && typeof cause === "object" && typeof (cause as { message?: unknown }).message === "string"
      ? (cause as { message: string }).message
      : typeof cause === "string" ? cause : "").trim();
  const lower = raw.toLowerCase();
  let message = "Something went wrong. Try again.";
  if (lower.includes("pairing token was rejected")) {
    message = "The other computer didn't accept this pairing. Create a new link with Pair Device… and try again.";
  } else if (lower.includes("could not connect")) {
    message = "This app couldn't reach that address. Check that the other computer is on and reachable, then try again.";
  } else if (lower.includes("not a wollipog control plane") || lower.includes("valid wollipog health response")) {
    message = "That address didn't answer as Wollipog. Check the address and try again.";
  } else if (
    lower.includes("unsupported api version")
    || lower.includes("does not support remote instances")
    || lower.includes("compatibility")
  ) {
    message = "That instance's version of Wollipog doesn't work with this app. Update the older one and try again.";
  } else if (lower.includes("already saved under another address")) {
    message = "This instance is already saved under another address.";
  } else if (lower.includes("already saved")) {
    message = "An instance with this address is already saved.";
  } else if (lower.includes("different wollipog instance")) {
    message = "That address belongs to a different Wollipog instance. Add it as a new instance instead.";
  } else if (lower.includes("no longer exists")) {
    message = "This instance is no longer saved in this app.";
  }
  return { title: FAILURE_TITLES[mode], message, ...(raw ? { detail: raw } : {}) };
}
