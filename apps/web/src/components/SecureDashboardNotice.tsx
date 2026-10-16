import React from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useRemoteAccess } from "../remote-access-context.js";
import { secureDashboardUrl } from "../remote-access-navigation.js";
import { Notice } from "./Notice.js";

/** Optional navigation leaves sign-in storage at its current origin and never transfers a token. */
export function SecureDashboardNotice({ connected }: { connected: boolean }) {
  const remote = useRemoteAccess();
  const secureOrigin = remote?.view?.phase === "ready" ? remote.view.origin : null;
  const insecure = !isTauri() && window.location.protocol === "http:" &&
    !/^(localhost|127\.[\d.]+|\[::1\])$/u.test(window.location.hostname);
  const href = secureOrigin ? secureDashboardUrl(secureOrigin, window.location) : null;
  if (!href || !connected || !insecure) return null;
  return <Notice tone="warning" title="Secure Dashboard Available" pageBanner actions={<a className="btn sm" href={href} rel="noreferrer">Open Secure Dashboard</a>}>
    Use the secure address for evidence review and your next bookmark. You may need a fresh pairing link from the administrator on the computer running Wollipog.
  </Notice>;
}
