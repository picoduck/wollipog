import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PlusIcon } from "../components/Icons.js";
import { Rail } from "../components/Rail.js";
import { installMobileViewportFallback } from "../mobile-viewport.js";
import type { View } from "../navigation.js";
import "../styles.css";

/**
 * The mobile bottom rail, with a software keyboard that can actually be opened.
 *
 * `mobile-viewport.test.ts` drives `installMobileViewportFallback` against a fake window and
 * asserts it publishes the right `--keyboard-inset`. That is half the chain. The half no unit test
 * reaches is whether the STYLESHEET consumes the variable — whether the rail and the More sheet
 * actually move above the keyboard, and the app actually shortens. Deleting
 * `- var(--keyboard-inset, 0px)` from the height rule, or `+ var(--keyboard-inset, 0px)` from the
 * sheet's `bottom`, leaves every existing test green and puts the controls back underneath the
 * keyboard, which is the bug #207 was about.
 *
 * Playwright cannot shrink the visual viewport independently of the layout viewport, and no browser
 * automation API exposes a software keyboard. So the fallback is installed against a window whose
 * `visualViewport` is a stub the test drives, while everything downstream — the real
 * `documentElement`, the real stylesheet, the real Rail — is genuine. What is faked is exactly the
 * one thing that cannot be automated, and nothing past it.
 */

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

declare global {
  interface Window {
    /**
     * Occlude `pixels` at the bottom, as a keyboard opening does on a browser that only shrinks the
     * visual viewport. `panned` is how far the browser scrolled the visual viewport toward the
     * focused field, which some browsers do instead of resizing in place — there the bottom gap is
     * smaller than the total shrink, and the bottom gap is what a bottom-anchored element must
     * clear. Called by the spec.
     */
    setKeyboard(pixels: number, panned?: number): void;
    /** Pan an already-shrunk viewport, changing only `offsetTop` and firing only `scroll`. */
    panKeyboard(offset: number): void;
    /**
     * How many times the fallback's coalesced frame has RUN.
     *
     * The fallback schedules through `requestAnimationFrame`, so a mutation is not observable the
     * moment `setKeyboard` returns. That is invisible for an assertion expecting a value — polling
     * simply waits — but it silently breaks every assertion expecting ABSENCE, which reads an
     * already-empty property and can succeed before the scheduled write ever happens. A round-2
     * mutation of `NOISE_FLOOR_PX` was reported caught on evidence that was really frame timing.
     * The spec reads this before each mutation and waits for it to advance.
     */
    keyboardApplies(): number;
    /**
     * Dispatch `count` resize events in one task, as a keyboard animating in does.
     *
     * The fallback coalesces a burst to one frame. Every other entry point here dispatches exactly
     * one event, so deleting `if (frame) return` left the whole suite green.
     */
    burstKeyboard(pixels: number, count: number): void;
    /** Run the fallback's teardown, so what it promises to release can be asserted. */
    stopKeyboard(): void;
    /** Every destination `onNavigate` has been called with, in order. */
    navigations: string[];
  }
}

/**
 * The mobile controls production keeps in the topbar rather than the rail.
 *
 * Not decoration. `App` always renders `Header`, whose root is `.topbar`, so
 * `.app:has(.topbar) > .app-rail { opacity: 0 }` erases the entire production navigation while
 * matching nothing in a fixture whose `<main>` is empty. The real Header needs the store and a live
 * control plane; its structural shape on a phone does not, and the shape is what a selector sees.
 */
function Topbar() {
  return (
    <header className="topbar">
      <h1>Inbox</h1>
      <div className="topbar-actions topbar-mobile-controls">
        {/* Both controls, because production renders both, and class-for-class rather than
            approximately: with `class="icon-btn settings-trigger"` here against production's plain
            `class="settings-trigger"`, a rule keyed on `.settings-trigger:not(.icon-btn)` erased
            the production rail and matched nothing. InstanceSelector and SettingsTrigger both need
            the store and a live control plane; the element shapes a selector sees do not. */}
        <div className="plus-menu instance-selector compact">
          <button type="button" className="instance-selector-trigger" aria-label="Instance">
            <span className="instance-selector-label">Local</span>
          </button>
        </div>
        <div className="settings-control">
          <button type="button" className="settings-trigger" aria-label="Settings" title="Settings">
            <PlusIcon size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}

function Harness() {
  // Production always sets one of these, through its bootstrap and ThemeProvider; the bare :root
  // fallback is a context production never renders in. A fixture that stays on it lets
  // `html[data-theme="light"] .app-rail { opacity: 0 }` erase the navigation for every light-theme
  // user while matching nothing here.
  const query = new URLSearchParams(window.location.search);
  const theme = query.get("theme") === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  // Connections renders a count badge when any runner is online. The badge is not the destination:
  // with one online, a capture of the whole item clears an ink floor with the icon erased, and the
  // zero case — which is what a new install renders — would be a blank square. The measurements
  // below target each icon directly, and this runs both ways so the badge-absent layout is real.
  const connections = Number(query.get("connections") ?? 1);
  // Which destination is current. Inbox is a PRIMARY destination, so with only that case the
  // active More trigger and the active overflow row — both real production states, reached by
  // visiting Runs, Pods, Automations or Usage — are never rendered, and a rule erasing them
  // matches nothing here.
  const view = { name: query.get("view") ?? "inbox" } as View;
  // How much the visual viewport is ALREADY occluded when the fallback installs. The fallback
  // calls `apply()` synchronously for exactly this case — a page loaded while the keyboard is
  // already open fires no resize and no scroll — and with the fixture always starting at full
  // height, deleting that call changed nothing.
  const occludedAtInstall = Number(query.get("keyboard") ?? 0);
  // Production passes live session counts, which render badges on Inbox. Hardcoding zero meant
  // `.app-rail:has(.rail-badge.blocked) { opacity: 0 }` — any blocked session at all — erased the
  // production navigation while matching nothing here.
  const blocked = Number(query.get("blocked") ?? 0);
  const stalled = Number(query.get("stalled") ?? 0);

  useEffect(() => {
    const viewport = new FakeVisualViewport(window.innerHeight - occludedAtInstall);
    let applies = 0;
    window.keyboardApplies = () => applies;
    // Everything except `visualViewport` is the real window, so the fallback writes to the real
    // documentElement and the real stylesheet responds.
    const win = new Proxy(window, {
      get(target, property) {
        if (property === "visualViewport") return viewport;
        // Counted here rather than in the fallback: production must not carry a test hook, and the
        // proxy already owns everything the fallback sees. Only the fallback holds this window, so
        // the count is exclusively its own frames — the Rail's own rAF goes to the real window.
        if (property === "requestAnimationFrame") {
          return (callback: FrameRequestCallback) => window.requestAnimationFrame((time) => {
            callback(time);
            applies += 1;
          });
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Window;

    const stop = installMobileViewportFallback(win);
    window.setKeyboard = (pixels: number, panned = 0) => {
      viewport.height = window.innerHeight - pixels;
      viewport.offsetTop = panned;
      viewport.dispatchEvent(new Event("resize"));
    };
    // Separate on purpose. A browser that pans an already-shrunk viewport toward the focused field
    // changes only `offsetTop` and fires only `scroll`. Driving both properties together and always
    // dispatching `resize` meant deleting the production `scroll` listener left every test green,
    // while the inset stayed at the pre-pan value and the rail was lifted 100px too far.
    window.panKeyboard = (offset: number) => {
      viewport.offsetTop = offset;
      viewport.dispatchEvent(new Event("scroll"));
    };
    window.burstKeyboard = (pixels: number, count: number) => {
      for (let step = 1; step <= count; step += 1) {
        viewport.height = window.innerHeight - Math.round((pixels * step) / count);
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      }
    };
    window.stopKeyboard = () => stop();
    return stop;
  }, [occludedAtInstall]);

  return (
    // Rail first, then main — production's order. Flex `order` makes their mobile geometry
    // equivalent either way, but a structural selector does not care about that:
    // `.app > .app-rail:first-child { opacity: 0 }` erases the production rail while matching
    // nothing in a fixture that puts main first.
    <div className="app">
      <Rail
        view={view}
        blockedCount={blocked}
        stalledCount={stalled}
        onlineConnections={connections}
        // Recorded, not discarded. With a no-op the suite proved a destination could be tapped and
        // nothing about where the tap went: pointing every primary link at Inbox left it green.
        onNavigate={(destination) => { window.navigations.push(destination.name); }}
      />
      <main className="main">
        <Topbar />
        {/* Production's `<main>` is never just a header; every view renders a `.main-body` under
            it. A fixture that omits it is distinguishable by `.app:has(.main-body)`. */}
        <div className="main-body" />
      </main>
    </div>
  );
}

window.navigations = [];

createRoot(document.getElementById("root")!).render(<Harness />);
