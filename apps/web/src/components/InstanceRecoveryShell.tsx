import React, { useEffect, useState, type ReactNode } from "react";
import { useWindowTitle, windowDragRegion } from "../desktop-window.js";
import type { InstanceProfile } from "../desktop-instances.js";
import { instanceAvailabilityMeta, useInstances, type InstanceManager } from "../instances-context.js";
import type { StatusTone } from "../status-meta.js";
import { Spinner } from "./common.js";
import { CloudOffIcon, KeyIcon, SearchOffIcon, UpdateIcon } from "./Icons.js";
import { InstanceSelector } from "./InstanceSelector.js";
import { InstancesPanel, lastConnection } from "./InstancesPanel.js";
import { Rail } from "./Rail.js";
import { SettingsTrigger } from "./SettingsTrigger.js";
import { State } from "./State.js";
import { statusToneClass } from "./StatusBadge.js";

/** Connecting offers Retry only once a connection has been trying this long (#3004). */
export const RECOVERY_RETRY_AFTER_MS = 20_000;
/** §12.3: a load shorter than this shows nothing new, so the skeleton waits for it. */
export const RECOVERY_SKELETON_DELAY_MS = 300;

/**
 * Which state the recovery screen shows (#3004), from the provider's phase and the active instance's
 * availability. One per row of the issue's table.
 */
export type InstanceRecoveryKind =
  | "loading"
  | "connecting"
  | "offline"
  | "pairing-required"
  | "update-required"
  | "not-found"
  | "this-machine-unavailable";

export function instanceRecoveryKind(
  manager: Pick<InstanceManager, "phase" | "activeProfile" | "statusByProfile">,
): InstanceRecoveryKind {
  switch (manager.phase) {
    case "loading": return "loading";
    case "missing": return "not-found";
    case "failed": break;
    // The boundary shows this screen until the instance's runtime exists, so "ready" is still opening.
    default: return "connecting";
  }
  if (manager.activeProfile.kind === "local") return "this-machine-unavailable";
  switch (manager.statusByProfile[manager.activeProfile.id]?.availability) {
    case "authentication-required":
    case "missing-credential": return "pairing-required";
    case "incompatible": return "update-required";
    default: return "offline";
  }
}

/** The host a sentence names: "studio.example:4317" from its origin, or the origin as saved. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

type RecoveryAction = "retry" | "go-to-this-machine" | "re-pair";

/** What the panel shows for one state: its words, its tone and icon tile, and its actions in order. */
export interface InstanceRecoveryContent {
  title: string;
  sentence: string | null;
  /** The fact line under the sentence; Connecting's elapsed time is added by the screen. */
  fact: string | null;
  tone: StatusTone | null;
  /** The first is the primary, unless `noPrimary` (Connecting, where waiting is the default). */
  actions: RecoveryAction[];
  noPrimary?: boolean;
}

/**
 * The issue's table (#3004): each state's title, sentence, fact and next steps. The tone is the
 * status word's (#3002, §11.2), so the panel, the rail tile and the rows agree.
 */
export function instanceRecoveryContent(
  kind: InstanceRecoveryKind,
  manager: Pick<InstanceManager, "activeProfile" | "statusByProfile">,
): InstanceRecoveryContent {
  const profile: InstanceProfile = manager.activeProfile;
  const name = profile.label;
  const host = hostOf(profile.origin);
  const remote = profile.kind === "remote";
  const status = manager.statusByProfile[profile.id];
  const message = status?.message?.toLowerCase() ?? "";
  const tone = (availability: Parameters<typeof instanceAvailabilityMeta>[0]) => instanceAvailabilityMeta(availability)?.tone ?? null;
  switch (kind) {
    case "loading":
      return { title: "Loading Instances", sentence: null, fact: null, tone: null, actions: [] };
    case "connecting":
      return {
        title: `Connecting to ${name}`,
        sentence: remote ? `Opening a secure connection to ${host}.` : "Opening Wollipog on this computer.",
        fact: null,
        tone: tone("connecting"),
        // This Machine is the one opening, so it has nowhere to go back to; Retry joins after 20s.
        actions: remote ? ["go-to-this-machine", "retry"] : ["retry"],
        noPrimary: true,
      };
    case "offline":
      return {
        title: `Can't Reach ${name}`,
        sentence: message.includes("refused")
          ? `It refused the connection at ${host}. Wollipog may not be running there.`
          : `It didn't answer at ${host}. It may be asleep, or Wollipog isn't running there.`,
        fact: lastConnection(profile),
        tone: tone("offline"),
        actions: ["retry", "go-to-this-machine"],
      };
    case "pairing-required":
      return {
        title: `${name} Needs a New Pairing`,
        sentence: status?.availability === "missing-credential"
          ? `This app has no saved pairing for it. Create a pairing link on ${name} and paste it here to connect.`
          : `It no longer accepts this app's saved credential. Create a pairing link on ${name} and paste it here to reconnect.`,
        fact: null,
        tone: tone("authentication-required"),
        actions: ["re-pair", "go-to-this-machine"],
      };
    case "update-required":
      return {
        title: `${name} Needs an Update`,
        sentence: message.includes("different wollipog instance")
          ? "It answers as a different Wollipog instance than the one saved here. Check it on that computer, then retry."
          : "It runs an older Wollipog that this app can't use. Update Wollipog on that computer, then retry.",
        fact: null,
        tone: tone("incompatible"),
        actions: ["go-to-this-machine", "retry"],
      };
    case "not-found":
      return {
        title: "Instance Not Found",
        sentence: "This link points to an instance that isn't saved in this app anymore. Choose one below, or go back to this computer.",
        fact: null,
        tone: "neutral",
        actions: ["go-to-this-machine"],
      };
    case "this-machine-unavailable":
      return {
        title: "Can't Reach Wollipog on This Machine",
        sentence: "Wollipog on this computer didn't answer. It may still be starting.",
        fact: null,
        tone: tone("offline"),
        actions: ["retry"],
      };
  }
}

const RECOVERY_ICONS: Record<Exclude<InstanceRecoveryKind, "loading" | "connecting">, () => ReactNode> = {
  "offline": () => <CloudOffIcon />,
  "pairing-required": () => <KeyIcon />,
  "update-required": () => <UpdateIcon />,
  "not-found": () => <SearchOffIcon />,
  "this-machine-unavailable": () => <CloudOffIcon />,
};

/** Changes to a new value when `key` does, and counts up from it every second while `running`. */
function useElapsed(key: string, running: boolean): number {
  const [start, setStart] = useState(() => ({ key, at: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  let since = start.at;
  if (start.key !== key) {
    since = Date.now();
    setStart({ key, at: since });
    setNow(since);
  }
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [key, running]);
  return Math.max(0, now - since);
}

/** True once `delay` has passed since mount (§12.3's 300ms before a skeleton). */
function useDelayed(delay: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setPassed(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  return passed;
}

/** The Instances list before the registry loads: skeleton rows at the rows' height and anatomy. */
function InstanceListSkeleton() {
  return (
    <div className="surface instance-list" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="row row-2 instance-row instance-skeleton-row" key={index}>
          <span className="skeleton-bar title" />
          <span className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

/**
 * The desktop app's screen while the active instance is loading, opening, failed or missing (#3004):
 * the shell's 64px rail, disabled, with the instance tile at its top, and one page whose heading is
 * a status panel that says what is happening and the one next step, then the Instances list
 * (#3002's rows, `recovery` variant), which says nothing the panel already said.
 */
export function InstanceRecoveryShell() {
  const instances = useInstances();
  const kind = instanceRecoveryKind(instances);
  const content = instanceRecoveryContent(kind, instances);
  const connecting = kind === "connecting";
  // Each switch, retry or re-pair starts a new connection, and Connecting counts from its start.
  const elapsed = useElapsed(`${kind}:${instances.activeProfile.id}:${instances.currentConnection?.() ?? ""}`, connecting);
  const seconds = Math.floor(elapsed / 1000);
  const skeleton = useDelayed(RECOVERY_SKELETON_DELAY_MS);
  useWindowTitle(content.title);

  // The screen replaces the shell, or one state replaces another, and the control that had focus
  // can go with it; focus then lands on the page's title, as a route change's does (§16.1).
  useEffect(() => {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      document.getElementById("page-title")?.focus({ preventScroll: true });
    }
  }, [kind]);

  const actions = content.actions
    .filter((action) => !(connecting && action === "retry" && elapsed < RECOVERY_RETRY_AFTER_MS))
    .map((action, index) => {
      const primary = index === 0 && !content.noPrimary;
      const className = primary ? "btn primary" : "btn";
      switch (action) {
        case "retry":
          return <button key={action} type="button" className={className} onClick={() => void instances.retryActive()}>Retry</button>;
        case "go-to-this-machine":
          return (
            <button key={action} type="button" className={className} onClick={() => void instances.goToThisMachine()}>
              Go to This Machine
            </button>
          );
        case "re-pair":
          // A rejected or missing pairing cannot be retried away: Re-Pair… opens the provider's one
          // dialog for this instance (#3003).
          return (
            <button
              key={action}
              type="button"
              className={className}
              aria-haspopup="dialog"
              onClick={(event) => instances.openInstanceDialog({
                mode: "repair",
                profileId: instances.activeProfile.id,
                returnFocus: event.currentTarget,
              })}
            >
              Re-Pair…
            </button>
          );
      }
    });

  const fact = connecting ? `Trying for ${seconds}s` : content.fact;
  const icon = kind === "loading" ? undefined : connecting ? <Spinner decorative /> : RECOVERY_ICONS[kind]();
  const failed = instances.phase === "failed";

  return (
    <div className="app">
      <Rail
        view={{ name: "inbox" }}
        blockedCount={0}
        stalledCount={0}
        onNavigate={() => undefined}
        disabled
        instanceControl={<InstanceSelector />}
        settingsControl={<SettingsTrigger active={false} onOpen={() => undefined} disabled />}
      />
      <main className="main">
        <div className="main-body">
          <div className="page instance-recovery-page">
            <header {...windowDragRegion()}>
              <State
                icon={icon}
                title={content.title}
                headingLevel={1}
                titleId="page-title"
                live={false}
                actions={actions.length > 0 ? actions : undefined}
                details={failed && instances.error ? instances.error : undefined}
                className={["instance-recovery-state", content.tone ? statusToneClass(content.tone) : ""].filter(Boolean).join(" ")}
              >
                {(content.sentence || fact) && (
                  <>
                    {content.sentence && <p>{content.sentence}</p>}
                    {fact && <p className="instance-recovery-fact">{fact}</p>}
                  </>
                )}
              </State>
            </header>
            {/* A screen reader hears each state change by its title, never the ticking fact; the
                sentence is said once, in the panel. */}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{content.title}</span>
            {/* The list stays while an instance opens, so another one is a Switch away (#3002). */}
            {kind === "loading"
              ? skeleton && <InstanceListSkeleton />
              : <InstancesPanel variant="recovery" />}
          </div>
        </div>
      </main>
    </div>
  );
}
