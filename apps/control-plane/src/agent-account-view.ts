import { createHash } from "node:crypto";
import { isProviderAccountRef, PROVIDER_ACCOUNT_REF_PREFIX } from "@wollipog/protocol";

/** The opaque name agent tools use for an account (#4353), since an account's id embeds its label.
 * It is stable for one account on one Machine and means nothing outside this control plane's check. */
export function providerAccountRef(runnerId: string, accountId: string): string {
  const digest = createHash("sha256").update(`wollipog-provider-account-ref\0${runnerId}\0${accountId}`).digest("hex");
  return `${PROVIDER_ACCOUNT_REF_PREFIX}${digest.slice(0, 16)}`;
}

/**
 * What an agent's credential receives of a response (#4508). Account labels are personal data,
 * often emails, and account ids are derived from them, so no `providerAccountLabel` and no raw
 * `providerAccountId` survives anywhere in it: a session's own binding, its account switch
 * failure, provider-HOME refusal and wait, a `provider_account_switched` event, and the sessions a
 * launch, run or workflow returns. An object that also names its `runnerId`, as every session does,
 * gets the account's opaque `providerAccountRef` instead, the same reference
 * `get_provider_account_selection` lists and `create_session` accepts. A reference an agent sent
 * is kept as it is. Everything else is returned unchanged and nothing is mutated, so a cached view
 * a person reads keeps both fields.
 */
export function withoutProviderAccountNames<T>(value: T): T {
  return narrow(value) as T;
}

function narrow(value: unknown): unknown {
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((item, index) => {
      const narrowed = narrow(item);
      if (narrowed !== item) (copy ??= [...value])[index] = narrowed;
    });
    return copy ?? value;
  }
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(record)) {
    if (key === "providerAccountLabel" || (key === "providerAccountId" && !(typeof child === "string" && isProviderAccountRef(child)))) {
      copy ??= { ...record };
      delete copy[key];
      continue;
    }
    const narrowed = narrow(child);
    if (narrowed !== child) (copy ??= { ...record })[key] = narrowed;
  }
  const accountId = record.providerAccountId;
  if (copy && typeof accountId === "string" && accountId && !isProviderAccountRef(accountId) && typeof record.runnerId === "string") {
    copy.providerAccountRef = providerAccountRef(record.runnerId, accountId);
  }
  return copy ?? value;
}
