import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const rail = readFileSync(new URL("./components/Rail.tsx", import.meta.url), "utf8");
const inbox = readFileSync(new URL("./components/InboxView.tsx", import.meta.url), "utf8");
const inboxCreateMenu = readFileSync(new URL("./components/InboxCreateMenu.tsx", import.meta.url), "utf8");
const inboxList = readFileSync(new URL("./components/InboxList.tsx", import.meta.url), "utf8");
const inboxRow = readFileSync(new URL("./components/InboxRow.tsx", import.meta.url), "utf8");
const inboxShortcutRail = readFileSync(new URL("./components/InboxShortcutRail.tsx", import.meta.url), "utf8");
const projectSplitMenu = readFileSync(new URL("./components/ProjectSplitMenu.tsx", import.meta.url), "utf8");
const projectsView = readFileSync(new URL("./components/ProjectsView.tsx", import.meta.url), "utf8");
const createProjectDialog = readFileSync(new URL("./components/CreateProjectDialog.tsx", import.meta.url), "utf8");
const commandPalette = readFileSync(new URL("./components/CommandPalette.tsx", import.meta.url), "utf8");
const projectLocationDialog = readFileSync(new URL("./components/ProjectLocationDialog.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("./components/SessionDetail.tsx", import.meta.url), "utf8");
const sessionHeader = readFileSync(new URL("./components/SessionHeader.tsx", import.meta.url), "utf8");
const shortcutHint = readFileSync(new URL("./components/ShortcutHint.tsx", import.meta.url), "utf8");
const shortcuts = readFileSync(new URL("./shortcuts.ts", import.meta.url), "utf8");
const newSessionShortcut = readFileSync(new URL("./useNewSessionShortcut.ts", import.meta.url), "utf8");

test("the application shell is rail-first and the legacy sidebar is fully retired", () => {
  const combined = [app, rail, inbox, shortcuts, css].join("\n");
  assert.equal(app.match(/<BannerStatusIcon kind=/g)?.length, 3,
    "every offline and pairing banner uses the same scalable status icon treatment");
  for (const retired of [
    ["Projects", "Sidebar"].join(""),
    ["Sidebar", "View", "Switcher"].join(""),
    ["Sidebar", "Create", "Actions"].join(""),
    ["toggle", "sidebar"].join("-"),
    ["mam", "sidebar", ""].join("."),
    ["mam", "projects", "collapsed"].join("."),
  ]) assert.equal(combined.includes(retired), false, retired);

  assert.match(app, /<Rail[\s\S]*blockedCount=\{blockedSessions\}[\s\S]*stalledCount=\{stalledSessions\}[\s\S]*onlineConnections=\{onlineRunners\}/);
  // The rail still renders every destination from the one canonical list; on a phone the tail moves
  // behind "More" rather than being dropped. Behavioural coverage lives in Rail.dom.test.tsx.
  assert.match(rail, /visibleItems\.map/);
  assert.match(rail, /visibleItems = isMobile[\s\S]*?GLOBAL_VIEW_ITEMS/);
  assert.match(rail, /overflowItems = isMobile[\s\S]*?GLOBAL_VIEW_ITEMS/);
  // Creation is an Inbox action, never a navigation destination or breakpoint-specific shell action.
  assert.match(rail, /const RAIL_ICON_SIZE = 26;[\s\S]*<Icon size=\{RAIL_ICON_SIZE\}/);
  assert.doesNotMatch(rail, /onNewSession|rail-action|PlusIcon/);
  assert.doesNotMatch(app, /title="New Session"[\s\S]*aria-label="New Session"/);
  assert.match(app, /mobileInstanceControl=\{isMobile \?/);
  assert.match(app, /mobileSettingsControl=\{isMobile \?/);
  assert.match(css, /\.app-rail\s*\{\s*width:\s*66px/);
  assert.match(css, /\.rail-brand img\s*\{[^}]*width:\s*39px;[^}]*height:\s*39px/);
  assert.match(css, /\.app-rail \.rail-item > \.app-icon,[\s\S]*?\.rail-settings \.settings-trigger svg\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px/);
  assert.match(css, /\.rail-item\.active\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent/);
  assert.match(css, /\.rail-item\.active::before\s*\{[^}]*left:\s*-11px;[^}]*width:\s*3px;[^}]*background:\s*var\(--accent\)/);
  assert.match(css, /\.rail-number\s*\{[^}]*right:\s*-7px;[^}]*bottom:\s*2px/);
  assert.match(css, /\.rail-badge\s*\{[^}]*top:\s*2px;[^}]*right:\s*-9px/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.app-rail\s*\{[\s\S]*width:\s*100%[\s\S]*flex-direction: row/);
});

test("heartbeat activity feeds cards, preview, split/footer counts, and independent rail badges", () => {
  assert.match(inbox, /stalledCount[\s\S]*inbox-activity-footer/);
  assert.match(inboxList, /state\.activity\.get\(props\.session\.id\)/);
  assert.match(detail, /<ActivityStrip activity=\{activity\} now=\{activityNow\}/);
  assert.match(rail, /rail-badge blocked[\s\S]*rail-badge stalled/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*activity-strip/);
});

test("live-follow status owns a reserved transcript strip with a compact centered control cluster", () => {
  // Dogfooding IDEA-007/BUG-009 (2026-08-10): the pager hints flank the follow-state control
  // inside ONE centered cluster, and the resume keycap lives INSIDE the control.
  assert.match(detail, /className="transcript-status-strip"[\s\S]*className="transcript-status-context"[\s\S]*<ContextWindowMeter session=\{session\} \/>[\s\S]*className="follow-tail-control"[\s\S]*label="Page Up"[\s\S]*className=\{`follow-tail-chip[\s\S]*className="follow-tail-kbd"[\s\S]*label="Page Down"[\s\S]*className="transcript-status-trailing"/,
    "Page Up, the follow-state control with its resume keycap, and Page Down form one cluster");
  assert.match(detail, /className="follow-tail-kbd"\s*aria-hidden="true"\s*data-shortcut-hint=\{shortcutDisplay\(mode === "preview" \? "inbox-follow-latest" : "session-reading-latest"\)\}/,
    "the in-control keycap is decorative; the control's tooltip carries the chord for assistive tech");
  assert.match(detail, /activePane === "reader"[\s\S]*<ShortcutHint[\s\S]*label="Reply"[\s\S]*shortcut=\{shortcutDisplay\("session-reading-reply"\)\}/);
  assert.match(shortcutHint, /className="shortcut-hint-label"[\s\S]*<kbd aria-hidden=\{interactive \? "true" : undefined\}>[\s\S]*className=\{`shortcut-hint shortcut-hint-button/,
    "Reply and transcript discovery hints must share the same component and keycap markup");
  assert.match(detail, /className="detail-main"[\s\S]*data-active-pane=\{activePane\}[\s\S]*onFocusCapture=\{\(\) => setActivePane\("reader"\)\}/);
  assert.match(detail, /className="composer"[\s\S]*onFocusCapture=\{\(\) => setActivePane\("composer"\)\}/);
  assert.match(detail, /className="composer-bar"[\s\S]*className="cbar-usage"[\s\S]*className="cbar-right"/,
    "session-level usage sits between the composer's permission and model controls, not in the strip");
  assert.doesNotMatch(detail, /transcript-usage-copy|follow-live-shortcut/,
    "the strip hosts neither usage copy nor edge-distributed or spacer-balanced shortcut hints");
  assert.match(css, /\.transcript-status-strip\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(0,\s*1fr\);[^}]*flex:\s*none;[^}]*min-height:\s*42px;[^}]*padding:\s*6px 14px;[^}]*background:\s*var\(--bg\);/);
  assert.doesNotMatch(css.match(/\.transcript-status-strip\s*\{[^}]*\}/)?.[0] ?? "", /border-top/,
    "the reader status strip remains visually continuous with the transcript");
  assert.match(css, /\.transcript-status-context\s*\{[^}]*grid-column:\s*1;[^}]*justify-self:\s*end;/);
  assert.match(css, /\.transcript-status-trailing\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*stretch;/);
  assert.match(css, /\.transcript-status-actions\s*\{[^}]*margin-left:\s*auto;/);
  assert.match(css, /\.follow-tail-control\s*\{[^}]*grid-column:\s*2;[^}]*display:\s*inline-flex;[^}]*gap:\s*8px;[^}]*justify-self:\s*center;/,
    "cluster items sit at the standard inter-control gap — no flexible spacers or space-between");
  assert.doesNotMatch(css.match(/\.follow-tail-control\s*\{[^}]*\}/)?.[0] ?? "", /1fr|space-between/,
    "no flexible tracks may push the pager hints toward the strip edges");
  assert.match(css, /\.follow-tail-chip\s*\{[^}]*position:\s*static;/,
    "the live-follow control must participate in the strip layout instead of covering transcript content");
  assert.match(css, /\.shortcut-hint kbd,\s*\.follow-tail-kbd\s*\{[^}]*border:\s*1px solid var\(--border-strong\);[^}]*border-radius:\s*var\(--radius-xs\);[^}]*font:\s*9px "Cascadia Code", Consolas, monospace;/,
    "the in-control resume keycap shares the Reply keycap treatment");
  assert.doesNotMatch(detail, /Preview Next|Preview Previous/);
  assert.doesNotMatch(sessionHeader, /ContextWindowMeter|formatTokens|formatCost/,
    "expanded usage belongs with the composer controls rather than the session header");
});

test("the global keyboard layer wires rail navigation, Inbox search, creation, and F6 zones", () => {
  const navigationIds = [
    "navigate-inbox",
    "navigate-projects",
    "navigate-board",
    "navigate-runs",
    "navigate-pods",
    "navigate-automations",
    "navigate-usage",
    "navigate-connections",
    "navigate-archived",
  ];
  for (const id of [
    ...navigationIds,
    "focus-inbox-search",
    "focus-next-zone",
    "focus-previous-zone",
  ]) assert.match(app, new RegExp(`matchesShortcut\\(event, "${id}"\\)|"${id}"`), id);
  assert.match(newSessionShortcut, /matchesShortcut\(event, "new-session"\)/);
  assert.match(app, /useNewSessionShortcut\(!isMobile, openContextualNewSession\)/);
  assert.match(app, /if \(isMobile\) return;/);
  assert.match(app, /xtermOwnsKey\(event\.target\)/);
  assert.match(app, /cycleFocusZone\(document, "next"\)/);
  const destinations = app.match(/const destinations = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.deepEqual(
    [...destinations.matchAll(/\["(navigate-[^"]+)"/g)].map((match) => match[1]),
    navigationIds,
    "the global keyboard destination order stays aligned with the rail",
  );
});

test("Inbox focus, unread state, and shortcuts use non-overlapping visual treatments", () => {
  assert.equal([inboxList, inboxRow, css].join("\n").includes("inbox-row-actions"), false,
    "session rows must remain compact and contain no shortcut rail");
  assert.match(inbox, /<footer className="inbox-activity-footer"[\s\S]*?<InboxShortcutRail/,
    "the shortcut rail belongs to the full-width Inbox footer");
  assert.match(inboxShortcutRail, /session\.pendingApproval[\s\S]*?label="Approve"[\s\S]*?label="Deny"/,
    "approval actions are contextual to the selected session");
  assert.match(inboxShortcutRail, /inbox-shortcut-rail is-empty/);
  assert.doesNotMatch(inboxShortcutRail, /inbox-shortcut-rail empty/,
    "the empty shortcut rail must not inherit the global dashed empty-state card");
  assert.match(css, /\.inbox-activity-footer\s*\{[^}]*height:\s*34px;[^}]*min-height:\s*34px;[^}]*max-height:\s*34px;[^}]*flex:\s*none;[^}]*overflow:\s*hidden;/,
    "the Inbox footer stays fixed immediately above the resize divider");
  assert.match(css, /\.inbox-shortcut-rail\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;[^}]*\}[\s\S]*\.inbox-shortcut-rail::-webkit-scrollbar\s*\{\s*display:\s*none;/,
    "overflowing shortcuts remain scrollable without a cross-axis scrollbar clipping the fixed footer");
  assert.match(css, /\.inbox-zero\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;[^}]*overflow:\s*auto;/,
    "the empty state consumes the flexible list area so the footer remains bottom-pinned");
  assert.match(css, /\.inbox-shortcut-rail\s*\{[\s\S]*?justify-content:\s*flex-end/);
  assert.match(css, /\.inbox-list-pane:has\(> \.inbox-list:focus-visible\)::after,[\s\S]*?\.inbox-preview-pane:has\(\.detail-scroll:focus-visible\)::after[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?border:\s*2px solid var\(--accent\);[\s\S]*?pointer-events:\s*none;/,
    "active panes draw one stable overlay above Inbox and transcript contents");
  assert.match(css, /\.inbox-list:focus-visible,[\s\S]*?\.detail-scroll:focus-visible \{ outline: none; \}/,
    "scrolling contents must not own the focus boundary");
  assert.match(css, /\.inbox-row-shell\.unread \.inbox-row\s*\{[\s\S]*?linear-gradient[\s\S]*?inset 3px 0 0/,
    "unread sessions need a distinct surface and leading accent");
});

test("Inbox project tabs stay balanced, hide overflow chrome, and reveal contextual actions", () => {
  // The focus handoff no longer lives INSIDE exitSearch, and that is the fix rather than a
  // regression: clearing the query re-renders urgently with the previous deferred value, so
  // focusing in the same tick landed on a `.inbox-zero` that the deferred commit then replaced.
  // What must still hold is that exiting clears the query and that focus is restored — now once
  // both the immediate and deferred values have converged.
  assert.match(inbox, /const exitSearch = useCallback\([\s\S]{0,200}setQuery\(""\)/,
    "exiting search clears the query");
  assert.match(inbox, /query !== "" \|\| deferredQuery !== ""[\s\S]{0,240}\.inbox-zero[\s\S]{0,80}\.focus\(\)/,
    "focus returns to the Inbox once the list it should land on is the one that is mounted");
  assert.match(inbox, /onKeyDown=\{\(event\) => \{[\s\S]*event\.key !== "Escape"[\s\S]*exitSearch\(\)/,
    "Escape exits the search field even when the query is already empty");
  assert.match(inbox, /inbox-tab-group\$\{hasMenu \? " has-menu" : ""\}/,
    "project actions are owned by their tab instead of a separate layout item");
  assert.match(projectSplitMenu, /createPortal\([\s\S]*document\.body\)/,
    "project menus must render outside the overflow-clipped tab strip");
  assert.match(css, /\.menu-pop\s*\{[^}]*overflow-y:\s*auto;/,
    "capped Project action menus scroll instead of painting outside their surface");
  assert.match(css, /\.inbox-toolbar\s*\{[^}]*align-items:\s*center;[^}]*padding:\s*7px 14px;/);
  assert.match(css, /\.inbox-tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*scrollbar-width:\s*none;/);
  assert.match(css, /\.inbox-tabs::-webkit-scrollbar\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.inbox-project-menu\s*\{[^}]*width:\s*44px;[\s\S]*\.inbox-project-menu-trigger\s*\{[^}]*flex:\s*0 0 44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[\s\S]*\.inbox-tab-group\.has-menu \.inbox-tab\s*\{\s*padding-right:\s*48px;/,
    "touch layouts reserve enough room for the always-visible Project action target");
  assert.match(css, /\.inbox-project-menu\s*\{[^}]*width:\s*34px;[^}]*linear-gradient\(90deg, transparent, var\(--bg-elev-2\) 42%\)/,
    "the hover action overlays and fades the tab's trailing text");
  assert.match(css, /\.inbox-tab-group:hover \.inbox-project-menu,[\s\S]*opacity:\s*1;/,
    "project actions appear on hover and keyboard focus");
  assert.match(css, /\.inbox-project-menu\s*\{[^}]*pointer-events:\s*none;/,
    "the fade overlay never steals clicks from the Project tab");
  assert.match(css, /\.inbox-tab-group:hover \.inbox-project-menu-trigger,[\s\S]*pointer-events:\s*auto;/,
    "only the visible Project action icon receives pointer events");
  assert.match(css, /\.inbox-project-menu-trigger:hover,[\s\S]*color:\s*var\(--accent\);[\s\S]*background:\s*transparent;/,
    "the project action highlights only its icon");
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.inbox-project-menu\s*\{[^}]*opacity:\s*1;[\s\S]*\.inbox-project-menu-trigger\s*\{[^}]*pointer-events:\s*auto;/,
    "touch users can reach project actions without first establishing hover");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.rail-item\.active::before\s*\{[^}]*bottom:\s*-6px;[^}]*left:\s*6px;[^}]*width:\s*auto;[^}]*height:\s*3px/,
    "the horizontal mobile rail uses a visible bottom-edge active indicator");
  assert.match(css, /\.right-panel\s*\{[^}]*bottom:\s*calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\)/,
    "mobile overlays must stop above the enlarged bottom rail");
});

test("Inbox unifies Session and Project creation while the shell exposes no duplicate action", () => {
  assert.match(rail, /projects:\s*ProjectsIcon/);
  assert.match(rail, /if \(view\.name === "session"\) return "inbox"/,
    "session detail remains owned by Inbox");
  assert.doesNotMatch(rail, /view\.name === "projects"[\s\S]*return "inbox"/,
    "Projects owns its rail active state");
  assert.doesNotMatch(rail, /onNewSession|rail-action|PlusIcon/,
    "the desktop rail has no creation action");
  assert.doesNotMatch(app, /title="New Session"[\s\S]*aria-label="New Session"/,
    "the mobile top bar has no creation action");
  assert.match(inbox, /<InboxCreateMenu[\s\S]*onNewSession=\{\(\) => onNewSession\?\.\(activeNewSessionPreset\)\}[\s\S]*onNewProject=\{projectsSupported \? \(\) => setCreatingProject\(true\) : undefined\}/,
    "the Inbox menu routes each choice into its existing context-aware workflow");
  assert.match(inboxCreateMenu, /aria-label="Create"[\s\S]*New Session[\s\S]*New Project/,
    "the control and both visible choices use accessible Title Case names");
  assert.match(inboxCreateMenu, /useAccessibleMenu[\s\S]*useAnchoredMenuStyle/,
    "the same focus-managed, viewport-anchored menu works for desktop and touch layouts");
  assert.match(inbox, /creatingProject && \([\s\S]*<CreateProjectDialog/,
    "New Project opens the existing Project creation workflow");
  assert.doesNotMatch(inbox, /inbox-manage-projects|Manage Projects/,
    "Project management lives in the rail instead of the Project bar");
  assert.doesNotMatch(commandPalette, /views\.splice\([^;]*Manage Projects/,
    "the command palette derives its single Projects destination from the global rail vocabulary");
  assert.match(css, /\.inbox-create-control\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px;/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.inbox-create-control\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/,
    "the shared creation control keeps a touch-sized target");
  assert.match(projectsView, /Projects organize related sessions\. Locations are folders on connected machines where sessions run\./);
  assert.match(projectsView, /className="muted project-detail-meta">Project ID:/);
  assert.match(projectsView, /className="muted project-detail-meta">\{projectAudienceVisibilitySummary/);
  assert.match(css, /\.project-detail-meta\s*\{\s*display:\s*block;/,
    "Project identity and audience metadata render on distinct lines");
  assert.match(projectsView, /label="Inbox Visibility"/,
    "the Inbox show-or-hide filter does not reuse the Project audience label");
  for (const label of ["Create Project", "Add Location", "Make Default", "Archive Sessions", "Delete Project"]) {
    assert.equal(projectsView.includes(label), true, label);
  }
  assert.match(projectsView, /Sessions will move to No Project[\s\S]*Sessions and files are not deleted/,
    "Project deletion states its non-destructive consequences");
  assert.match(inbox, /activeSplit\.count > 0[\s\S]*title: "Loading Sessions"[\s\S]*still syncing/,
    "authoritative Project counts must not momentarily render a false empty state");
  assert.match(createProjectDialog, /const close = \(\) => \{\s*if \(!busy\) onClose\(\);/,
    "create cannot be dismissed while its mutation is in flight");
  assert.match(projectLocationDialog, /const close = \(\) => \{\s*if \(!busyKey\) onClose\(\);/,
    "location changes cannot be dismissed while their mutation is in flight");
  assert.equal(projectsView.match(/const close = \(\) => \{\s*if \(!busy\) onClose\(\);/g)?.length, 1,
    "delete confirmation cannot be dismissed while its mutation is in flight");
  assert.match(projectLocationDialog, /candidates\.length === 0 \? "No Locations Found" : "No Matching Locations"/,
    "an empty search result stays distinct from having no Locations to manage");
  assert.match(projectLocationDialog, /targetLink\?\.availability === "runner_removed"[\s\S]*"Relink Location"/,
    "a returned exact workspace offers stable-identity relinking instead of duplicating its tombstone");
  for (const contract of [
    /await onCreate\(\{[\s\S]*runnerId: selectedRunnerId,[\s\S]*path: selectedFolder,[\s\S]*owner: selectedScope\.owner/,
    /Create New Location[\s\S]*<span>Machine<\/span>/,
    /Browse for a Folder…/,
    /<DirectoryPicker/,
  ]) assert.match(projectLocationDialog, contract,
    "Add Location can register a browsed folder on a selected online machine");
  assert.match(projectLocationDialog,
    /const \[createExpanded, setCreateExpanded\] = useState\(false\)[\s\S]*aria-expanded=\{createExpanded\}[\s\S]*createExpanded &&/,
    "new Location creation stays behind an explicit progressive disclosure");
  assert.match(projectLocationDialog, /<strong>Existing Locations<\/strong>[\s\S]*<input\s+autoFocus/,
    "the common existing-Location path owns initial focus");
  assert.match(projectLocationDialog, /"Add to Project"/);
  assert.doesNotMatch(projectLocationDialog, /Move (?:Here|to|Location)/,
    "adding a shared Location does not imply moving it from another Project");
  assert.match(projectsView, /onCreate=\{async \(location\)[\s\S]*api\.createProjectLocation/,
    "Project management uses the atomic Project-scoped Location creation API");
  assert.match(css, /\.project-location-create-toggle\s*\{[^}]*width:\s*100%;[^}]*text-align:\s*left;/,
    "the collapsed creation disclosure remains a full-width readable target");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.project-manager-back\s*\{[^}]*min-height:\s*44px/,
    "the mobile Projects back target remains usable without a coarse-pointer media query");
});

test("Inbox Search is compact by default and expands for keyboard or populated use", () => {
  assert.match(inbox, /className=\{`inbox-search\$\{query \? " has-query" : ""\}`\}/);
  assert.match(inbox, /<SearchIcon size=\{15\} \/>/);
  assert.match(css, /\.inbox-search\s*\{[^}]*width:\s*34px;[^}]*min-width:\s*34px;[^}]*height:\s*34px;/,
    "idle Search only occupies one icon target");
  assert.match(css, /\.inbox-search:focus-within,\s*\.inbox-search\.has-query\s*\{[^}]*width:\s*min\(250px, 28vw\);[^}]*min-width:\s*150px;/,
    "focus and a retained query both keep Search expanded");
  assert.match(css, /\.inbox-search:focus-within input,\s*\.inbox-search\.has-query input\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.inbox-search\s*\{[^}]*width:\s*100%;[^}]*flex:\s*1;/,
    "small screens retain the full-width Search control");
});

/**
 * Six mobile reachability and focus failures, each verified by reintroducing the defect.
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("the software keyboard shrinks the layout viewport, not just the visual one", () => {
  // 100dvh measures the full screen when only the visual viewport shrinks, so the fixed bottom
  // rail ends up behind the keyboard and no destination is tappable until it is dismissed.
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(viewport, "the viewport meta must exist");
  assert.match(viewport!, /interactive-widget=resizes-content/,
    "without this the keyboard covers the bottom rail");
  assert.match(viewport!, /viewport-fit=cover/, "and the notch handling must survive");
});

test("an open More sheet suppresses the toast stack", () => {
  // The merged suppression named .menu-pop and .instance-selector-pop. The More sheet is neither,
  // so persistent toasts still covered and intercepted taps on its lower destinations.
  const rule = /body:has\(\.rail-more-sheet\) \.toast-region/.test(css);
  assert.ok(rule, "the More sheet must suppress toasts like every other open menu");
});

test("More menu items activate with Space as well as Enter", () => {
  // An <a> activates on Enter natively but never on Space, while role="menuitem" promises both.
  const menuItem = rail.slice(rail.indexOf('role="menuitem"'));
  const handler = menuItem.slice(menuItem.indexOf("onKeyDown"), menuItem.indexOf("</a>"));
  assert.ok(handler.length > 0, "menu items must handle keys themselves");
  assert.match(handler, /event\.key !== " "/, "Space must be recognised");
  assert.match(handler, /preventDefault/, "and must not scroll the sheet instead");
  assert.match(handler, /onNavigate\(destination\)/, "and must actually navigate");
});


test("focus ownership is recorded before the breakpoint unmounts the rail", () => {
  // By the time an effect runs after the crossing, activeElement is already <body>, so reading
  // ownership then always reported "outside" and the handoff never fired.
  assert.match(rail, /addEventListener\("focusin"/,
    "focus ownership must be tracked continuously, not sampled after the unmount");
  assert.match(rail, /useLayoutEffect\(\(\) => \{\s*if \(isMobile\) return;/,
    "the handoff must run in a layout effect");
  assert.match(rail, /focusInsideRailRef\.current/, "and must consult the recorded ownership");
});

test("Settings survives the breakpoint because it is a route", () => {
  // This test used to assert that Shell owned the dialog's open state, because two SettingsDialog
  // instances existed — one per layout — and crossing 760px unmounted the open one and mounted a
  // fresh closed one, so the dialog vanished and Modal's saved trigger was gone. Hoisting the state
  // was the fix available to a dialog.
  //
  // Settings is a route now, so the problem does not exist: the URL does not care which layout is
  // mounted, and there is no open state to preserve. What still has to hold is that both layouts
  // render a trigger and that the trigger navigates rather than opening anything.
  const triggers = [...app.matchAll(/<SettingsTrigger\s/g)];
  assert.ok(triggers.length >= 2, "each layout must render its own trigger");
  assert.doesNotMatch(app, /SettingsDialog/, "the dialog is replaced by the route, not kept beside it");
  assert.doesNotMatch(app, /settingsOpen/, "there is no open state to hoist once it is a route");
  assert.match(app, /onOpen=\{\(\) => navigate\(\{ name: "settings" \}\)\}/,
    "the trigger navigates to the route");
});

test("the phone topbar cannot push its controls off-screen", () => {
  // The icon-only treatment existed but was scoped to .rail-instance, which this row does not use,
  // so a long instance name pushed Settings past the right edge with no way to scroll it back.
  assert.match(css, /\.topbar-mobile-controls \.instance-selector-label,\s*\n\s*\.topbar-mobile-controls \.instance-selector-chevron \{ display: none; \}/,
    "the instance trigger must be icon-only in the phone topbar");
  assert.match(css, /\.topbar-mobile-controls \.instance-selector-trigger \{[^}]*flex: none/,
    "and must not grow with the instance name");
  assert.match(css, /\.topbar:has\(\.topbar-mobile-controls\) h1 \{[^}]*text-overflow: ellipsis/,
    "the title must yield before any control does");
});

test("Settings is the trailing control in the unified phone topbar cluster", () => {
  const start = app.indexOf('<div className="topbar-actions topbar-mobile-controls">');
  const end = app.indexOf("</div>", start);
  assert.ok(start >= 0 && end > start, "the phone controls must share one ordered cluster");

  const mobileCluster = app.slice(start, end);
  const instanceIndex = mobileCluster.indexOf("mobileInstanceControl");
  const createIndex = mobileCluster.indexOf("topbar-create");
  const sessionActionsIndex = mobileCluster.indexOf("sessionActions");
  const settingsIndex = mobileCluster.indexOf("mobileSettingsControl");
  assert.ok(instanceIndex >= 0 && createIndex >= 0 && sessionActionsIndex >= 0 && settingsIndex >= 0,
    "the phone cluster must include every control category");
  assert.ok(instanceIndex < settingsIndex,
    "the instance control must precede Settings");
  assert.ok(createIndex < settingsIndex,
    "creation actions must precede Settings");
  assert.ok(sessionActionsIndex < settingsIndex,
    "session actions must precede Settings");
  assert.match(css, /\.topbar-mobile-controls \{[^}]*flex-wrap: nowrap/,
    "the unified control cluster must stay on one line");
});

test("the Collaboration Pod header action is one accessible plus-icon control across layouts", () => {
  assert.match(app, /function NewPodHeaderButton[\s\S]*className="icon-btn topbar-create"[\s\S]*title="New Collaboration Pod"[\s\S]*aria-label="New Collaboration Pod"[\s\S]*<PlusIcon/);
  assert.equal([...app.matchAll(/<NewPodHeaderButton onClick=\{onNewPod\} \/>/g)].length, 2,
    "mobile and desktop paths must reuse the same pod action");
  assert.match(css, /\.topbar-create\.icon-btn \{[^}]*width: 32px;[^}]*height: 32px/,
    "the desktop action must remain compact");
  assert.match(css, /\.topbar-mobile-controls \.topbar-create\.icon-btn \{[^}]*width: 44px;[^}]*height: 44px/,
    "the phone action must retain a full touch target");
});

test("keyboard reachability does not depend on optional viewport metadata alone", () => {
  // interactive-widget=resizes-content is not universally implemented. Where it is ignored, only
  // the visual viewport shrinks, 100dvh still measures the full screen, and the fixed bottom rail
  // sits behind the keyboard.
  // Comments stripped first: an earlier version of this test matched "offsetTop" in the very
  // comment explaining why offsetTop is needed, so removing it from the computation still passed.
  const fallback = readFileSync(new URL("./mobile-viewport.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.match(fallback, /visualViewport/, "the fallback must read the visual viewport");
  assert.match(fallback, /innerHeight\s*-\s*viewport\.offsetTop\s*-\s*viewport\.height/,
    "the occlusion is the residual BOTTOM gap — browsers that pan rather than resize the visual " +
    "viewport leave offsetTop above it, which the height alone does not account for");
  assert.match(fallback, /--keyboard-inset/, "and must publish the occlusion the layout consumes");

  // Keyed off the residual bottom gap, with no boolean threshold above noise. A 120px threshold
  // meant a PANNED visual viewport — 300px shorter but only 100px of bottom gap — switched the
  // fallback off entirely and put the rail back under the keyboard.
  assert.doesNotMatch(fallback, /THRESHOLD/, "a keyboard-presence threshold reintroduces that gap");

  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  assert.match(main, /installMobileViewportFallback\(\)/, "and it must actually be installed");

  assert.match(css, /height: calc\(100dvh - var\(--keyboard-inset, 0px\)\)/,
    "the app height must consume it, falling back to plain 100dvh where it is absent");
});

test("More-sheet toast suppression covers the whole rail breakpoint", () => {
  // The rail and its sheet are active to 760px; the suppression sat in a 600px block, so at 667px
  // the toast stack still covered the sheet's lower destinations.
  const block = /@media \(max-width: 760px\) \{[^@]*?body:has\(\.rail-more-sheet\) \.toast-region \{[^}]*\}/s.test(css);
  assert.ok(block, "suppression must apply through 760px, not just the phone breakpoint");
});

test("crossing the breakpoint always closes More", () => {
  // Gating the close on focus ownership left an open sheet alive when focus had moved elsewhere
  // (a toast action, an assistive-technology jump); it reappeared on the way back down.
  const effect = rail.slice(rail.indexOf("useLayoutEffect"), rail.indexOf("const visibleItems"));
  const closeAt = effect.indexOf("more.close(false)");
  const guardAt = effect.indexOf("if (!hadFocus) return;");
  assert.ok(closeAt > 0 && guardAt > 0, "both the close and the focus guard must exist");
  assert.ok(closeAt < guardAt, "the close must not sit behind the focus-ownership guard");
});

test("the fixed More sheet clears the software keyboard too", () => {
  // position: fixed anchors to the LAYOUT viewport, so shortening the root leaves the sheet where
  // it was — its destinations stayed behind the keyboard even though the rail that opened it moved.
  const sheet = /\.rail-more-sheet \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(sheet, ".rail-more-sheet must exist");
  assert.match(sheet!, /bottom:[^;]*var\(--keyboard-inset, 0px\)/,
    "the sheet's bottom offset must clear the occlusion");
  assert.match(sheet!, /max-height:[\s\S]*?var\(--keyboard-inset, 0px\)/,
    "and its height must shrink by it, or the top destinations scroll out of reach");
});

test("Shortcut Reference restores focus after a breakpoint change", () => {
  // Opened from Settings, its saved return target is the Settings trigger — which the crossing
  // removes. Both the saved element and Modal's captured row are then disconnected.
  assert.match(app, /shortcutReturnSelectorRef/,
    "a disconnected element needs a selector to re-resolve against the current layout");
  const close = app.slice(app.indexOf("const closeShortcutReference"), app.indexOf("}, []);", app.indexOf("const closeShortcutReference")));
  assert.match(close, /target\?\.isConnected/, "the saved element still wins when it survives");
  assert.match(close, /document\.querySelector<HTMLElement>\(selector\)/,
    "and the selector is the fallback when it does not");
  // The selector can miss too — opened from the Settings Keyboard row, then Back while the
  // reference is still open, and the row it named is gone as well. The page heading exists on
  // every view in both layouts, so the chain cannot end on <body>.
  assert.match(close, /\?\? document\.getElementById\("page-title"\)/,
    "a fallback chain that can still resolve to nothing is not a fallback");
});

test("the Inbox reminder filter joins option borders without a wrapper outline", () => {
  assert.match(inbox, /<SegmentedControl<ReminderInboxMode>[\s\S]*className="inbox-reminder-view"/,
    "the reminder filter must opt into the scoped joined treatment");
  assert.match(css, /\.ui-seg\.inbox-reminder-view \{[^}]*isolation: isolate;[^}]*gap: 0;[^}]*padding: 0;[^}]*border: 0;[^}]*background: transparent/,
    "the reminder wrapper must not paint an outer outline or nested gap");
  assert.match(css, /\.inbox-reminder-view \.ui-seg-option \{[^}]*border-color: var\(--control-outline\)/,
    "each reminder choice must carry its own boundary");
  assert.match(css, /\.inbox-reminder-view \.ui-seg-option \+ \.ui-seg-option \{ margin-left: -1px; \}/,
    "adjacent reminder borders must collapse to one seam");
  assert.match(css, /\.inbox-reminder-view \.ui-seg-option\.is-selected \{[^}]*z-index: var\(--z-sticky\);[^}]*border-color: var\(--accent\)/,
    "the selected boundary must paint above its neighbor");
  assert.match(css, /\.inbox-reminder-view \.ui-seg-option:focus-visible \{[^}]*z-index: var\(--z-dock\)/,
    "the keyboard focus ring must paint above every segment");
  assert.match(css, /\.ui-seg \{[^}]*gap: 2px;[^}]*padding: 2px;[^}]*border: 1px solid var\(--control-outline\)/,
    "unrelated shared segmented controls must retain their established appearance");
});
