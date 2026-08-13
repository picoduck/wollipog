import React from "react";
import { createRoot } from "react-dom/client";
import {
  AboutPanel,
  AppearancePanel,
  BehaviorPanel,
  KeyboardPanel,
  NetworkPanel,
  NotificationsPanel,
  SettingsView,
} from "../components/SettingsView.js";
import {
  COLOR_SCHEMES,
  DENSITY_OPTIONS,
  THEME_OPTIONS,
  applySchemeToDocument,
  parseColorScheme,
  type ColorScheme,
} from "../theme.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "../navigation.js";
import "../styles.css";

/**
 * Settings as App.tsx actually builds it, in a state chosen by the URL.
 *
 * Mounting the row primitives standalone was not enough: a rule scoped to a wrapper the fixture
 * omitted would break the affordance in production while never matching here, and the contrast
 * measurement was wrong for the same reason, sampling the body background rather than the surface
 * the controls actually sit on.
 *
 * Review then found the same class of hole one level down. It is not enough to reproduce the
 * ANCESTORS; sibling position matters too, because `:last-child` and `:only-child` are ordinary
 * selectors. An earlier fixture put its busy switch third of four and Keyboard Shortcuts first of
 * two, so `.ui-row-switch.is-busy:last-child .ui-switch { opacity: 0 }` and
 * `.ui-row-nav:only-child .ui-row-chevron { opacity: 0 }` each erased a real production affordance
 * while every assertion here stayed green.
 *
 * And then it found the hole this file itself was: the fixture went on rendering a `Modal`, a
 * `.settings-dialog`, a Done button and the old four-section topology for a whole round after
 * Settings became a ROUTE. It reproduced a screen that no longer existed, so any route-layout
 * regression could ship with the suite green.
 *
 * The fix is structural rather than another careful copy: the harness imports the SAME panel
 * components the shell renders, so there is no second description of the topology to drift out of
 * step. What stays fixture-specific is only what the shell holds state for — the push and tailnet
 * settings, which are props precisely so that both callers can supply them.
 */

const STATES = ["rest", "busy-on", "busy-off", "disabled"] as const;
type State = (typeof STATES)[number];

/**
 * Production's rows are conditional, so "the" topology is a set of them.
 *
 * `NotifyRow` returns null when notifications are unsupported, `PushRow` when push is unavailable
 * (which includes Tauri), and the Tailnet switch is replaced by a disabled explanation when
 * Tailscale is absent. A fixture that always renders both notification switches and always the live
 * Tailnet row still misses `.settings-options > .ui-row-switch:only-child .ui-switch
 * { opacity: 0 }`, which erases Desktop Alerts wherever push is unavailable.
 *
 * `minimal` is the permutation that makes those match: one notification row, and Network in its
 * unavailable form.
 */
const TOPOLOGIES = ["full", "minimal"] as const;
type Topology = (typeof TOPOLOGIES)[number];

function Harness() {
  const params = new URLSearchParams(window.location.search);
  // Selected by query string rather than by a control on the page: a control would sit inside the
  // hierarchy under test, and a reload per variant guarantees a clean, settled paint.
  const theme = params.get("theme") === "light" ? "light" : "dark";
  const requested = params.get("state") as State | null;
  const state: State = requested && STATES.includes(requested) ? requested : "rest";
  const askedFor = params.get("topology") as Topology | null;
  const topology: Topology = askedFor && TOPOLOGIES.includes(askedFor) ? askedFor : "full";
  const requestedSection = params.get("section") as SettingsSection | null;
  const section: SettingsSection = SETTINGS_SECTIONS.some((entry) => entry.id === requestedSection)
    ? requestedSection!
    : "appearance";
  const schemes = params.get("copy") === "long"
    ? COLOR_SCHEMES.map((option) => ({
      ...option,
      description: `${option.description} — localized preview copy`,
    }))
    : COLOR_SCHEMES;
  document.documentElement.setAttribute("data-theme", theme);

  const disabled = state === "disabled";
  const busy = state === "busy-on" || state === "busy-off";
  // The confirmed value, which is what a busy row must keep showing. Both directions are rendered
  // because they fail differently: announcing ON early is a lie about a subscription that does not
  // exist yet, announcing OFF early is a lie about one that is still live.
  const pushChecked = state === "busy-on" ? true : state === "busy-off" ? false : true;

  /*
   * The palette, as the shell actually renders it: committed unless something is being browsed.
   *
   * `onSchemePreview` was a no-op here, which made the one thing about this control that can leave
   * the WHOLE PAGE wrong invisible to every browser test — a dismissal that forgot to withdraw its
   * preview looked identical to one that did, because nothing was ever applied. The same
   * `applySchemeToDocument` the provider calls, so a stale palette is a stale `data-scheme` a test
   * can read, and the commit path moves the same attribute. Storage is deliberately not touched:
   * this fixture is about what the document shows.
   */
  const [scheme, setScheme] = React.useState<ColorScheme>("wollipog");
  const [previewScheme, setPreviewScheme] = React.useState<ColorScheme | null>(null);
  React.useLayoutEffect(() => {
    applySchemeToDocument(document, previewScheme ?? scheme);
  }, [previewScheme, scheme]);

  // Production's structure above the view: `.app` > `main.main` > `.main-body`. A rule scoped to
  // `.app > .main .settings-view` would break the real page while never matching a fixture rooted
  // at #root, which is the class of miss every earlier round of this file was fixing.
  return (
    <div className="app">
      <main className="main">
        <header className="topbar"><h1 id="page-title" tabIndex={-1}>Settings</h1></header>
        <div className="main-body">
          <SettingsView
            section={section}
            onNavigate={() => undefined}
            onOpenShortcuts={() => undefined}
            panels={{
              appearance: (
                <AppearancePanel
                  options={THEME_OPTIONS}
                  value="system"
                  disabled={disabled}
                  // A reason, because the disabled state is rendered here to be MEASURED: a faded
                  // group with nothing to say for itself is the state §11.3 forbids, and a harness
                  // that never passes one cannot tell whether the plumbing reaches the group.
                  disabledReason="Managed by your workspace administrator."
                  onChange={() => undefined}
                  schemes={schemes}
                  scheme={scheme}
                  onSchemeChange={(value) => setScheme(parseColorScheme(value))}
                  onSchemePreview={(value) => setPreviewScheme(value === null ? null : parseColorScheme(value))}
                  resolvedTheme={theme}
                  densities={DENSITY_OPTIONS}
                  density="compact"
                  onDensityChange={() => undefined}
                />
              ),
              // The PRODUCTION panel, given injected state. The fixture used to copy two SwitchRows
              // that looked like its rows, and a copy is a second description of the topology —
              // the exact drift this file was rebuilt to remove, one level down.
              notifications: (
                <NotificationsPanel
                  notify={{ supported: true, on: false, toggle: () => undefined }}
                  push={topology === "full"
                    ? { state: busy ? "busy" : "on", confirmed: pushChecked, toggle: async () => undefined }
                    : { state: "unavailable", confirmed: false, toggle: async () => undefined }}
                  disabled={disabled}
                />
              ),
              keyboard: <KeyboardPanel shortcutLabel="Reference · ?" disabled={disabled} onOpenShortcuts={() => undefined} />,
              behavior: <BehaviorPanel />,
              network: (
                <NetworkPanel
                  tailnet={{
                    // `managed: false` is how production reaches a DISABLED tailnet switch: another
                    // control plane owns the port, so the row renders and cannot be operated.
                    status: topology === "full"
                      ? { available: true, enabled: true, managed: !disabled }
                      : null,
                    loading: false,
                    desktop: true,
                    busy,
                    error: null,
                    toggle: () => undefined,
                  }}
                />
              ),
              about: <AboutPanel />,
            }}
          />
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
