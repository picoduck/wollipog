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

/** Copy `text`, falling back to a selected field where the Clipboard API is refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
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
        // The shell's sentence is for a developer, so it goes to the console. The person gets what
        // happened and the URL itself, which Copy Link always turns into a way forward; a browser
        // that refused a link once usually refuses it again, so there is no Retry (#1975).
        const detail = errorDetail(cause);
        const blocked = detail.startsWith(EXTERNAL_URL_POLICY_ERROR_PREFIX);
        console.warn("[desktop] could not open a link:", blocked ? detail.slice(EXTERNAL_URL_POLICY_ERROR_PREFIX.length) : detail);
        showToast(blocked ? "Wollipog only opens web links in your browser." : "Couldn't open the link in your browser.", {
          tone: blocked ? "warning" : "error",
          detail: url,
          detailStyle: "mono",
          action: {
            label: "Copy Link",
            progress: "Copying the link…",
            run: async () => {
              if (await copyText(url)) {
                showToast("Link copied.", { tone: "success" });
                return;
              }
              // The URL stays on screen to select by hand.
              showToast("Couldn't copy the link. Select it and copy it instead.", { tone: "error", detail: url, detailStyle: "mono" });
            },
          },
        });
      });
    };
    document.addEventListener("click", activate, true);
    return () => document.removeEventListener("click", activate, true);
  }, [desktop, showToast]);

  return null;
}
