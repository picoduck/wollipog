import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { DesktopUpdateNotifier } from "../components/DesktopUpdateNotifier.js";
import { DesktopExternalLinkRouter, EXTERNAL_URL_POLICY_ERROR_PREFIX, type ExternalLinkDesktop } from "../components/DesktopExternalLinkRouter.js";
import { createCloseGuardLinks, type CloseGuardSession } from "../desktop-close-guard.js";
import { DESKTOP_UPDATE_CHANNEL_CHANGED, DESKTOP_UPDATE_CHECKED, useDesktopUpdateSetting, type DesktopUpdateOutcome, type DesktopUpdateRuntime, type DesktopUpdateStatus } from "../desktop-updates.js";
import { AboutPanel } from "../components/SettingsView.js";
import { ApiProvider } from "../api-context.js";
import { createApiClient } from "../api.js";
import "../styles.css";

/**
 * The desktop update toast, the held-update confirmation and the link-error toasts (#1975, #1682) in
 * a real browser, through the real `FeedbackProvider`, with a fake desktop runtime in place of the
 * Tauri shell, which CI cannot screenshot. Nothing here reaches a real updater or browser.
 *
 * `?state=in-place` (the default) announces 0.29.0 with Install and Restart; installing it is held
 * for two working sessions the local instance knows, and a confirmed install is recorded and never
 * finishes, as a restart would not. `?state=release-page` is a package-manager install, pointed at
 * the release page. `?state=link-failure` clicks a link the system browser refuses, and
 * `?state=link-policy` a `file:` link the shell's policy blocks, and `?state=link-long` refuses a link
 * several kilobytes long. `?theme=light` switches theme.
 * Chosen by query string so every state is a clean reload; the page records what reached the fake.
 */

const VERSION = "0.29.0";
const RELEASE_URL = `https://github.com/picoduck/wollipog/releases/tag/v${VERSION}`;
const FAILED_LINK = "https://github.com/picoduck/wollipog/pull/2040/files#diff-4f8c2d1e9b7a6035c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
const BLOCKED_LINK = "file:///Users/avery/Projects/wollipog/docs/design-system.md";

const SESSIONS: Record<string, CloseGuardSession> = {
  s_rounding: { title: "Fix the half-cent rounding bug in invoice totals before the quarterly close", status: "running", pendingApproval: null },
  s_migration: { title: "Review the migration plan", status: "input_required", pendingApproval: null },
};

/** A refused link several kilobytes long: its detail scrolls inside the toast. */
const LONG_LINK = `https://example.com/report?filters=${Array.from({ length: 200 }, (_, index) => `session-${index}`).join(",")}`;

type State = "in-place" | "release-page" | "link-failure" | "link-policy" | "link-long" | "channels";
const STATES: readonly State[] = ["in-place", "release-page", "link-failure", "link-policy", "link-long", "channels"];
const LINK_STATES: readonly State[] = ["link-failure", "link-policy", "link-long"];

/** Real Settings panel and hook; only the native command boundary is simulated. */
function ChannelSettingsHarness() {
  const [desktop] = useState<DesktopUpdateRuntime>(() => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const status: DesktopUpdateStatus = {
      currentVersion: "0.29.1", install: { mode: "inPlace" }, automaticChecks: false,
      prereleaseUpdates: localStorage.getItem("e2e-prerelease-updates") === "true",
      checksAllowed: true, releasesUrl: "https://github.com/picoduck/wollipog/releases", lastCheck: null,
    };
    return {
      isTauri: () => true,
      listen: async (event, handler) => { handlers.set(event, handler); return () => { handlers.delete(event); }; },
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command === "desktop_update_status") return { ...status } as T;
        if (command === "set_prerelease_updates") {
          status.prereleaseUpdates = args?.enabled === true;
          localStorage.setItem("e2e-prerelease-updates", String(status.prereleaseUpdates));
          status.lastCheck = null;
          handlers.get(DESKTOP_UPDATE_CHANNEL_CHANGED)?.({ ...status });
          return { ...status } as T;
        }
        if (command === "set_automatic_update_checks") return (status.automaticChecks = args?.enabled === true) as T;
        if (command === "check_for_desktop_update") {
          status.lastCheck = status.prereleaseUpdates
            ? { state: "available", version: "0.30.0-rc.1", releaseUrl: "https://github.com/picoduck/wollipog/releases/tag/v0.30.0-rc.1", checkedAt: Date.now(), prereleaseUpdates: true }
            : { state: "current", checkedAt: Date.now(), prereleaseUpdates: false };
          handlers.get(DESKTOP_UPDATE_CHECKED)?.(status.lastCheck);
          return status.lastCheck as T;
        }
        throw new Error(`The channel harness does not answer ${command}.`);
      },
    };
  });
  const [api] = useState(() => createApiClient({
    instanceId: "channel-fixture", publicOrigin: window.location.origin, close() {},
    request: async () => new Response(JSON.stringify({ appVersion: "0.29.1" }), { headers: { "content-type": "application/json" } }),
  }));
  const update = useDesktopUpdateSetting(desktop);
  return <ApiProvider client={api}><main style={{ maxWidth: 800, margin: "24px auto", padding: 16 }}><AboutPanel update={update} /></main></ApiProvider>;
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  const requested = params.get("state") as State | null;
  const state: State = requested && STATES.includes(requested) ? requested : "in-place";
  const [installs, setInstalls] = useState<string[]>([]);
  const [opened, setOpened] = useState<string[]>([]);
  const [copied, setCopied] = useState<string[]>([]);

  const [updates] = useState<DesktopUpdateRuntime>(() => {
    const status: DesktopUpdateStatus = {
      currentVersion: "0.28.2",
      install: state === "release-page"
        ? { mode: "releasePage", reason: "This app was installed from a .deb package. Install the new package from the release page." }
        : { mode: "inPlace" },
      automaticChecks: true,
      checksAllowed: true,
      releasesUrl: "https://github.com/picoduck/wollipog/releases",
      lastCheck: { state: "available", version: VERSION, releaseUrl: RELEASE_URL, checkedAt: Date.UTC(2026, 8, 29, 16, 5) },
    };
    return {
      isTauri: () => state === "in-place" || state === "release-page",
      invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "check_for_desktop_update") return status.lastCheck as T;
        if (command === "desktop_update_status") return status as T;
        if (command === "open_external_url") {
          setOpened((list) => [...list, String(args?.url)]);
          return undefined as T;
        }
        if (command === "install_desktop_update") {
          const confirmed = args?.confirmed === true;
          setInstalls((list) => [...list, confirmed ? "confirmed" : "unconfirmed"]);
          // A confirmed install restarts the app, so it never answers.
          if (confirmed) return new Promise<T>(() => undefined);
          const held: DesktopUpdateOutcome = {
            outcome: "heldForWork",
            sessions: 2,
            sessionIds: ["s_rounding", "s_migration"],
          };
          return held as T;
        }
        throw new Error(`The harness does not answer ${command}.`);
      },
    };
  });

  const [links] = useState<ExternalLinkDesktop>(() => ({
    isTauri: () => LINK_STATES.includes(state),
    invoke: async () => {
      if (state === "link-policy") {
        throw `${EXTERNAL_URL_POLICY_ERROR_PREFIX}Wollipog can open only HTTP and HTTPS links in your system browser; file links are blocked.`;
      }
      throw "The system browser could not open this link: No application is registered to open https links (os error 2)";
    },
  }));

  const [sessions] = useState(() => {
    const registry = createCloseGuardLinks();
    registry.provide({ session: (id) => SESSIONS[id] ?? null });
    return registry;
  });

  // The clipboard is faked too, so Copy Link is observable without a browser permission.
  useState(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { setCopied((list) => [...list, text]); } },
    });
    return null;
  });

  // The link states click their link once the router below is listening: a child's effect runs first.
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (LINK_STATES.includes(state)) anchor.current?.click();
  }, [state]);

  return (
    <FeedbackProvider>
      {state === "channels" && <ChannelSettingsHarness />}
      <DesktopExternalLinkRouter desktop={links} />
      <DesktopUpdateNotifier
        desktop={updates}
        firstCheckDelayMs={0}
        recheckIntervalMs={60 * 60 * 1000}
        links={sessions}
      />
      {/* Clicked by the page, never shown; the records are read by the spec. */}
      <div className="sr-only">
        <a ref={anchor} href={state === "link-policy" ? BLOCKED_LINK : state === "link-long" ? LONG_LINK : FAILED_LINK} tabIndex={-1}>Link</a>
        <output data-testid="installs">{installs.join(",")}</output>
        <output data-testid="opened">{opened.join(",")}</output>
        <output data-testid="copied">{copied.join(",")}</output>
      </div>
    </FeedbackProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
