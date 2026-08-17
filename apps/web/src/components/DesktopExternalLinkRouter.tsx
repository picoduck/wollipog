import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useFeedback } from "./FeedbackProvider.js";

export interface ExternalLinkDesktop {
  isTauri(): boolean;
  invoke(command: string, args: { url: string }): Promise<unknown>;
}

const shell: ExternalLinkDesktop = { isTauri, invoke };

export const EXTERNAL_URL_POLICY_ERROR_PREFIX = "wollipog-external-url-policy:";

/**
 * Return the exact href for an anchor that belongs in the system browser.
 *
 * App-relative and same-origin links remain WebView navigation. Every explicit non-HTTP scheme is
 * sent to the native validator too, so file:, mailto:, deep links, and other blocked schemes fail
 * visibly instead of navigating the WebView or disappearing silently. Download anchors remain
 * WebView-owned so generated blob downloads still work.
 */
export function externalHref(anchor: HTMLAnchorElement, location: Location): string | null {
  if (anchor.hasAttribute("download")) return null;
  const href = anchor.getAttribute("href");
  if (!href) return null;
  const explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:/u.test(href);
  try {
    void new URL(href, location.href);
  } catch {
    return explicitScheme ? href : null;
  }
  if (explicitScheme) return href;
  if (href.startsWith("//")) {
    const currentSchemeHref = `${location.protocol}${href}`;
    const absoluteHref = `https:${href}`;
    const sameBrowserOrigin = (location.protocol === "http:" || location.protocol === "https:")
      && new URL(currentSchemeHref).origin === location.origin;
    return sameBrowserOrigin ? null : absoluteHref;
  }
  return null;
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "The system browser did not accept the link.";
}

/** Route intentional anchors through the narrow native opener. Renders nothing in every runtime. */
export function DesktopExternalLinkRouter({ desktop = shell }: { desktop?: ExternalLinkDesktop } = {}) {
  const { showToast } = useFeedback();

  useEffect(() => {
    if (!desktop.isTauri()) return;
    const activate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const url = externalHref(anchor, window.location);
      if (!url) return;

      // Prevent WebView navigation synchronously. Do not stop propagation, move focus, or touch
      // scroll state: transcript selection, follow state, and surrounding interactions stay intact.
      event.preventDefault();
      const open = async () => {
        await desktop.invoke("open_external_url", { url });
      };
      void open().catch((cause) => {
        const detail = errorDetail(cause);
        if (detail.startsWith(EXTERNAL_URL_POLICY_ERROR_PREFIX)) {
          showToast(detail.slice(EXTERNAL_URL_POLICY_ERROR_PREFIX.length), { tone: "error" });
          return;
        }
        showToast(`Could not open link: ${detail}`, {
          tone: "error",
          durationMs: 0,
          action: {
            label: "Retry",
            busyLabel: "Retrying…",
            run: open,
            failureLabel: "Could not open link",
          },
        });
      });
    };
    document.addEventListener("click", activate, true);
    return () => document.removeEventListener("click", activate, true);
  }, [desktop, showToast]);

  return null;
}
