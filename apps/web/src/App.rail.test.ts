import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MOBILE_BREAKPOINT_PX } from "./components/useIsMobile.js";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const offlineBanner = readFileSync(new URL("./components/OfflineBanner.tsx", import.meta.url), "utf8");
const pairingBanner = readFileSync(new URL("./components/PairingBanner.tsx", import.meta.url), "utf8");
const remoteInstanceBanner = readFileSync(new URL("./components/RemoteInstanceBanner.tsx", import.meta.url), "utf8");
const feedbackProvider = readFileSync(new URL("./components/FeedbackProvider.tsx", import.meta.url), "utf8");
const rail = readFileSync(new URL("./components/Rail.tsx", import.meta.url), "utf8");
const railTooltip = readFileSync(new URL("./components/RailTooltip.tsx", import.meta.url), "utf8");
const settingsTrigger = readFileSync(new URL("./components/SettingsTrigger.tsx", import.meta.url), "utf8");
const inbox = readFileSync(new URL("./components/InboxView.tsx", import.meta.url), "utf8");
const groupTabs = readFileSync(new URL("./components/SessionGroupTabs.tsx", import.meta.url), "utf8");
const inboxList = readFileSync(new URL("./components/InboxList.tsx", import.meta.url), "utf8");
const inboxRow = readFileSync(new URL("./components/InboxRow.tsx", import.meta.url), "utf8");
const projectSplitMenu = readFileSync(new URL("./components/ProjectSplitMenu.tsx", import.meta.url), "utf8");
const menuSurface = readFileSync(new URL("./components/Menu.tsx", import.meta.url), "utf8");
const projectsView = readFileSync(new URL("./components/ProjectsView.tsx", import.meta.url), "utf8");
const pageHeader = readFileSync(new URL("./components/PageHeader.tsx", import.meta.url), "utf8");
const runsView = readFileSync(new URL("./components/RunsView.tsx", import.meta.url), "utf8");
const podsView = readFileSync(new URL("./components/PodsView.tsx", import.meta.url), "utf8");
const createProjectDialog = readFileSync(new URL("./components/CreateProjectDialog.tsx", import.meta.url), "utf8");
const commandPalette = readFileSync(new URL("./components/CommandPalette.tsx", import.meta.url), "utf8");
const projectLocationDialog = readFileSync(new URL("./components/ProjectLocationDialog.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("./components/SessionDetail.tsx", import.meta.url), "utf8");
const sessionHeader = readFileSync(new URL("./components/SessionHeader.tsx", import.meta.url), "utf8");
const shortcuts = readFileSync(new URL("./shortcuts.ts", import.meta.url), "utf8");
const newSessionShortcut = readFileSync(new URL("./useNewSessionShortcut.ts", import.meta.url), "utf8");

test("the application shell is rail-first and the legacy sidebar is fully retired", () => {
  const combined = [app, rail, inbox, shortcuts, css].join("\n");
  // docs/design-system.md §13.3: the offline and pairing banners are one Notice page banner, whose
  // tone icon is the scalable status icon treatment.
  // Each lives in its own component: the offline banner so its Retry Now and build variants are
  // testable, the remote instance banner so the instance harness can show it (#1970), and the pairing
  // banner so its browser and desktop copy is DOM tested (#2303). The shell itself draws none.
  assert.doesNotMatch(app, /<Notice\b/, "the shell renders its banners through their components");
  assert.match(app, /<PairingBanner connecting=\{conn === "connecting"\} \/>/);
  assert.equal(remoteInstanceBanner.match(/<Notice pageBanner tone="warning" role="status"/g)?.length, 1,
    "the remote instance banner renders the Notice page banner");
  assert.equal(offlineBanner.match(/<Notice pageBanner tone="warning" role="status"/g)?.length, 1,
    "the offline banner renders the Notice page banner");
  // The banner is the live region, so its pairing error is not a second one.
  assert.match(pairingBanner, /<Notice\s+pageBanner\s+tone="warning"\s+role="status"/);
  assert.doesNotMatch(pairingBanner, /role="alert"/, "a pairing error inside the status banner would be announced twice");
  for (const retired of [
    ["Projects", "Sidebar"].join(""),
    ["Sidebar", "View", "Switcher"].join(""),
    ["Sidebar", "Create", "Actions"].join(""),
    ["toggle", "sidebar"].join("-"),
    ["mam", "sidebar", ""].join("."),
    ["mam", "projects", "collapsed"].join("."),
  ]) assert.equal(combined.includes(retired), false, retired);

  assert.match(app, /<Rail[\s\S]*blockedCount=\{blockedSessions\}[\s\S]*stalledCount=\{stalledSessions\}[\s\S]*machines=\{railMachines\}/);
  assert.match(app, /machineAttention\(runners\.values\(\), sessions\.values\(\)\)/,
    "Connections reads machines that need the user, never a count of online ones (#1967)");
  assert.doesNotMatch(app, /onlineRunners|onlineConnections/);
  // The rail still renders every destination from the one canonical list; on a phone the ones off
  // the tab bar move behind "More" rather than being dropped. Behavioural coverage lives in
  // Rail.dom.test.tsx.
  assert.match(rail, /const entries: RailEntry\[\] = \[...visibleItems\];[\s\S]*?entries\.map\(/);
  assert.match(rail, /const itemFor = [^\n]*GLOBAL_VIEW_ITEMS/);
  assert.match(rail, /const barNames = isMobile \? phoneBarViews\(preferences, flags\) : visibleNames;/);
  assert.match(rail, /overflowItems = isMobile \? visibleNames\.filter\(\(name\) => !barNames\.includes\(name\)\)/);
  // Creation is an Inbox action, never a navigation destination or breakpoint-specific shell action.
  assert.match(rail, /export const RAIL_ICON_SIZE = 20;[\s\S]*const TAB_ICON_SIZE = 24;[\s\S]*<Icon size=\{isMobile \? TAB_ICON_SIZE : RAIL_ICON_SIZE\}/);
  assert.doesNotMatch(rail, /onNewSession|rail-action|PlusIcon/);
  assert.doesNotMatch(app, /title="New Session"[\s\S]*aria-label="New Session"/);
  // The instance tile is desktop-app only and lives at the top of the rail (#1970). The desktop
  // app's 940px minimum width never reaches the phone layout, so no phone bar carries a switcher.
  // In the labelled rail (#1968) its row also shows the name and status (§4.1).
  assert.match(app, /instanceControl: desktopMultiInstance\s*\?\s*<InstanceSelector labelled=\{railPreferences\.labels\} \/>\s*:\s*undefined/);
  // The tile and the Instances card read one connection truth, the banner's (#2102).
  assert.match(app, /const instanceConnection = activeInstanceConnection\(\{ conn, authRequired, connectionLost \}\)/);
  assert.match(app, /return <ActiveInstanceConnectionProvider value=\{instanceConnection\}>\{shell\}<\/ActiveInstanceConnectionProvider>;/);
  assert.doesNotMatch(app, /appBarControl|PageChromeProvider|mobileInstanceControl/);
  assert.doesNotMatch(pageHeader, /appBarControl|PageChrome/);
  // Phone app bars carry the Search icon that opens the palette (#1978).
  assert.match(app, /<AppBarSearchProvider onSearch=\{isMobile \? openPalette : undefined\}>/);
  assert.doesNotMatch(app, /mobileSettingsControl/,
    "Settings left the phone topbar for the rail's More sheet");
  assert.match(css, /--rail-w: 64px;/);
  assert.match(css, /\.app-rail\s*\{\s*width:\s*var\(--rail-w\)/);
  assert.match(css, /\.rail-brand img\s*\{[^}]*width:\s*39px;[^}]*height:\s*39px/);
  assert.match(css, /\.rail-item\s*\{[^}]*width:\s*var\(--control-h-lg\);[^}]*height:\s*var\(--control-h-lg\)/);
  // A phone tab marks the current page on its pill, not with the desktop rail's selected fill.
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.rail-item\[aria-current="page"\] \{ background: transparent; \}/);
  assert.match(css, /\.rail-item\.active::before\s*\{[^}]*left:\s*calc\(\(var\(--rail-w\) - 1px - var\(--control-h-lg\)\) \/ -2\);[^}]*width:\s*3px;[^}]*background:\s*var\(--accent\)/);
  assert.doesNotMatch(css, /\.rail-number/, "the digit superscript is replaced by the tooltip");
  // One attention mark per destination, drawn by the shared CountBadge (§11.4, #1967): no rail-only
  // badge rule survives, and brand orange never marks a count.
  assert.doesNotMatch(css, /\.rail-badge|\.rail-more-count/);
  assert.doesNotMatch(rail, /rail-badge|rail-more-count|accent-2/);
  assert.match(rail, /<CountBadge count=\{attention\.count\} tone=\{attention\.tone\} onIcon=\{onIcon\} \/>/);
  assert.match(css, /\.rail-item\[aria-current="page"\] \{ --count-badge-ring: var\(--surface-selected\); \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.app-rail\s*\{[\s\S]*width:\s*100%[\s\S]*flex-direction: row/);
});

test("the desktop rail is grouped, searchable and has one current-page treatment (#1958)", () => {
  // Search: the first Work item, opening the same palette as Ctrl/Cmd+K, never a destination.
  assert.match(app, /const openPalette = useCallback\(\(query\?: string\) => setPalette\(typeof query === "string" \? query : ""\), \[\]\);/);
  assert.match(app, /onSearch: openPalette,/);
  assert.match(rail, /entries\.splice\(Math\.max\(0, entries\.findIndex\(\(entry\) => entryGroup\(entry\) === "work"\)\), 0, "search"\)/);
  assert.match(rail, /aria-label="Search"[\s\S]*?aria-keyshortcuts=\{shortcutAriaKeys\("search"\)\}[\s\S]*?data-rail-tip="Search"[\s\S]*?data-rail-keys=\{shortcutDisplay\("search"\)\}/);
  assert.match(rail, /event\.currentTarget\.focus\(\);\s*onSearch\?\.\(\);/,
    "a clicked Search holds focus, so the palette returns focus to it when it closes");
  assert.match(commandPalette, /document\.activeElement instanceof HTMLElement \? document\.activeElement : null/);

  // Tooltip naming: the name alone is the accessible name, the digit is aria-keyshortcuts, and the
  // tooltip shows both but is hidden from assistive technology.
  assert.match(rail, /aria-label=\{item\.name\}\s*aria-describedby=\{attention \? descriptionId : undefined\}/,
    "the name is the destination alone on the rail, the phone bar and the More sheet; the attention is its description (#1967)");
  assert.match(rail, /aria-keyshortcuts=\{shortcutDigit \?\? undefined\}/);
  assert.match(railTooltip, /className=\{tip\.note \? "rail-tooltip with-note" : "rail-tooltip"\}\s*aria-hidden="true"/);
  assert.match(railTooltip, /event\.pointerType !== "mouse"/, "touch never opens the tooltip");
  assert.match(railTooltip, /RAIL_TOOLTIP_DELAY_MS = 500;/);
  assert.match(railTooltip, /RAIL_TOOLTIP_WARM_MS = 1000;/);
  assert.match(railTooltip, /focusVisible\(anchor\)/, "keyboard focus opens it, a click does not");
  assert.match(css, /\.rail-tooltip\s*\{[^}]*position:\s*fixed;[^}]*background:\s*var\(--bg-elev-3\);[^}]*font:\s*var\(--type-small\);/);
  assert.doesNotMatch(css, /\.rail-tooltip kbd/, "the tooltip places the shared keycap and never restyles it (§11.5)");

  // Settings uses the destination recipe: a .rail-item with aria-current and the same tooltip.
  assert.match(settingsTrigger, /className=\{`rail-item\$\{active \? " active" : ""\}`\}/);
  assert.match(settingsTrigger, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(settingsTrigger, /data-rail-tip="Settings"\s*data-rail-keys=\{binding\}/);
  assert.match(settingsTrigger, /<SettingsIcon size=\{RAIL_ICON_SIZE\} \/>/);
  assert.doesNotMatch(css, /\.settings-trigger/, "no Settings-only sizing survives");
  assert.match(css, /\.rail-item\.active \{ color: var\(--accent\); \}/);
  assert.match(css, /\.rail-item\[aria-current="page"\] \{ background: var\(--surface-selected\); \}/);

  // Hover exists only where hover does, so a tap leaves no fill behind (§15.3).
  assert.match(css, /@media \(hover: hover\) \{\s*\.rail-item:hover \{ color: var\(--text\); background: var\(--bg-elev-2\); \}/);
  // The labelled rail's hover keycap is narrower still: fine pointers only (#1968).
  assert.doesNotMatch(css.replace(/@media \(hover: hover\)(?: and \(pointer: fine\))? \{[^}]*\}/g, ""), /\.rail-item:hover/);

  // Separators: a 24px hairline between contiguous groups only.
  assert.match(rail, /separatorsBefore\[index\] && <span className="rail-separator" aria-hidden="true" \/>/);
  assert.match(css, /\.rail-separator\s*\{[^}]*width:\s*24px;[^}]*height:\s*1px;[^}]*background:\s*var\(--border\)/);

  // The brand is decoration: not a link and not in the tab order.
  assert.match(rail, /<div className="rail-brand" aria-hidden="true">/);
  assert.doesNotMatch(rail, /<a\s+className="rail-brand"/);
  assert.doesNotMatch(rail, /FolderSolidIcon/, "no rail glyph is filled");
});

test("heartbeat activity feeds cards, preview, split counts, and independent rail badges", () => {
  // #2214: the counts live on the tabs and the rail; the Sessions footer that restated them is gone.
  assert.match(groupTabs, /<CountBadge count=\{split\.stalledCount\} tone="danger" \/>/);
  assert.doesNotMatch(inbox, /inbox-activity-footer/);
  assert.match(inboxList, /state\.activity\.get\(props\.session\.id\)/);
  // #2210: the Sessions preview shows one status and no activity strip; the rows carry it.
  assert.doesNotMatch(detail, /<ActivityStrip\b/, "the preview bar has no activity strip");
  assert.match(app, /sessionVisibleForReminderMode\(session, reminders\.get\(session\.id\), "ordinary"\)[\s\S]*activeSessions\.filter\(isInboxBlocked\)[\s\S]*activeSessions\.filter\(\(session\) => stalledSessionIds\.has\(session\.id\)\)/,
    "the rail's Blocked and Stalled badges must derive from the same Active membership as Sessions");
  assert.match(rail, /const attentionState = \{ blocked: blockedCount, stalled: stalledCount, machines \};/,
    "the Sessions badge derives from the same Blocked and Stalled counts");
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*activity-strip/);
});

test("the transcript's lower edge has one floating tail control, and context and cost live in the composer bar", () => {
  // #2153: no always-on chip and no reserved recovery band. A zero-height anchor below the reader
  // carries the floating control. #2166: the status strip under it is gone, so the reader extends
  // to the composer column, and context, cost and the Reply hint moved into the composer.
  // #2179: the reading column then ends with the request dock, the notice slot's lead, directly
  // above the composer.
  assert.match(detail, /<div className="detail-reader">[\s\S]*<TranscriptTailControl[\s\S]*role="status" data-transcript-recovery-status>\{recoveryAnnouncement\}<\/span>\s*<\/div>\s*\{\/\*[\s\S]*?\*\/\}\s*\{mode === "expanded" && requestDockLead && \(\s*<SessionNoticeSlot[\s\S]*?lead=\{requestDockLead\}[\s\S]*?\/>\s*\)\}\s*<\/div>\s*\{mode === "expanded" && \(\s*<div\s+className="composer"/,
    "the anchor and the one recovery live region end the reader, and the request dock alone sits between it and the composer");
  // #2210: a preview has no composer, so its dock heads the chat column instead.
  assert.match(detail, /<div className="detail-chat" ref=\{detailChatRef\}>\s*\{\/\*[\s\S]*?\*\/\}\s*\{mode === "preview" && requestDockLead && \(\s*<SessionNoticeSlot/,
    "the preview's request dock is the first thing in its chat column");
  assert.doesNotMatch(detail, /transcript-status-|<ShortcutHint/,
    "no element of the retired status strip, nor its Reply hint button, remains");
  assert.doesNotMatch(detail, /follow-tail-chip|follow-tail-control|transcript-recovery-slot|TranscriptRecoveryStripEcho|label="Page Up"|label="Page Down"/,
    "the chip, its pager hints and the recovery band are gone");
  assert.match(detail, /className="detail-main"[\s\S]*data-active-pane=\{activePane\}[\s\S]*onFocusCapture=\{\(\) => setActivePane\("reader"\)\}/);
  assert.match(detail, /className="composer"[\s\S]*onFocusCapture=\{\(\) => setActivePane\("composer"\)\}/);
  // The trailing cluster holds context, then cost, then the mic: only while the bar has room.
  assert.match(detail, /<div className="cbar-right">[\s\S]*\{usagePlacement === "bar" && <>[\s\S]*<ContextWindowMeter session=\{session\} resolution=\{contextWindow\} placement="bar" \/>\s*<SessionUsageControl session=\{session\} placement="bar" \/>\s*<\/>\}\s*\{dictation\.supported && \(/,
    "context and cost sit just before the mic in the composer bar's trailing cluster");
  assert.match(detail, /<ModelEffortControl[\s\S]*sessionUsage=\{usagePlacement === "model-settings"\s*\? <SessionUsageMenuGroup session=\{session\} resolution=\{contextWindow\} \/>\s*: null\}/,
    "otherwise Model Settings opens with the Session Usage group, and only then");
  assert.match(detail, /const composerUsageNarrow = isMobile \|\| composerColumnNarrow;/);
  assert.match(detail, /const usagePlacement = composerUsagePlacement\(\{\s*narrow: composerUsageNarrow,\s*modelSettingsOpenable: modelSettingsAvailable && composerControlsDisabledReason === null,\s*\}\);/);
  // A narrow column whose Model Settings cannot open gives the figures a row above the bar.
  assert.match(detail, /\{usagePlacement === "row" && \([\s\S]*<div className="composer-usage-row">\s*<ContextWindowMeter session=\{session\} resolution=\{contextWindow\} placement="bar" \/>\s*<SessionUsageControl session=\{session\} placement="bar" \/>\s*<\/div>\s*\)\}\s*<div className="composer-bar">/);
  assert.match(detail, /<div\s+ref=\{composerBoxRef\}\s+className=\{`composer-box/, "the column measured is the composer card's own");
  assert.match(detail, /const contextWindow = resolveContextWindowCapacity\(session, agentCaps\?\.models \?\? \[\]\);/,
    "every meter placement consumes the shared capacity result");
  assert.equal(detail.match(/<ContextWindowMeter session=\{session\} resolution=\{contextWindow\}/g)?.length, 3,
    "the composer bar, its own row and Answer Mode each place the meter once; the preview has none (#2210)");
  // Answer Mode replaces the bar, Model Settings included, so it carries the two triggers itself.
  assert.match(detail, /usage=\{composerAnswerActive \? <>\s*<ContextWindowMeter session=\{session\} resolution=\{contextWindow\} placement="bar" \/>\s*<SessionUsageControl session=\{session\} placement="bar" \/>\s*<\/> : null\}\s*usageOwnRow=\{composerUsageNarrow\}/);
  // The Reply shortcut's hint is a keycap in the idle, unfocused composer's placeholder row.
  assert.match(detail, /const composerReplyKeycap = sessionReadingKeys && canPrompt && activePane === "reader" && text === "" &&\s*!composerIdleCollapsed && !composerAnswerActive;/);
  assert.match(detail, /\{composerReplyKeycap && \([\s\S]*<div className="composer-reply-hint" aria-hidden="true">\s*<kbd>\{shortcutDisplay\("session-reading-reply"\)\}<\/kbd>\s*<\/div>\s*\)\}\s*<textarea/,
    "the keycap sits in a zero-height row directly above the textarea");
  // #781: the cost control remains distinct from the neighboring context meter.
  assert.doesNotMatch(detail, /of \$\{[a-zA-Z]+\} context|sessionPreviewUsage/,
    "no combined context-and-cost summary may return");
  assert.doesNotMatch(detail, /follow-live-shortcut/);
  assert.doesNotMatch(css, /transcript-status-|transcript-pane/,
    "the strip's rules, its container queries and the pane container they measured retire with it");
  assert.doesNotMatch(css, /follow-tail-|transcript-recovery-/,
    "the chip's and the recovery band's styles retire with them");
  assert.doesNotMatch(detail, /Preview Next|Preview Previous/);
  assert.doesNotMatch(sessionHeader, /ContextWindowMeter|formatTokens|formatCost/,
    "expanded usage belongs with the composer controls rather than the session header");
});

test("the global keyboard layer wires rail navigation, Inbox search, creation, and F6 zones", () => {
  // Bare digits derive from the visible rail order (#385): the handler must read the derived
  // list, not a static navigate-* table that a reorder or hide would silently contradict.
  assert.match(app, /const digit = bareDigitPressed\(event\)/,
    "digit handling shares the bare-key gating with every other binding");
  assert.match(app, /railViewForDigit\(visibleRailNamesRef\.current, digit\)/,
    "the digit resolves against the CURRENT visible order");
  assert.match(app, /const visibleRailNames = visibleRailViews\(railPreferences, experiments\.flags\)/,
    "visibility folds preferences and experiment flags together");
  assert.doesNotMatch(app, /matchesShortcut\(event, "navigate-/,
    "no static digit table may survive beside the derived mapping");
  for (const id of [
    "focus-inbox-search",
    "focus-next-zone",
    "focus-previous-zone",
  ]) assert.match(app, new RegExp(`matchesShortcut\\(event, "${id}"\\)`), id);
  assert.match(newSessionShortcut, /matchesShortcut\(event, "new-session"\)/);
  assert.match(app, /useNewSessionShortcut\(!isMobile, openContextualNewSession\)/);
  // The board-mode e2e harness mounts these same hooks (#527), but it cannot see whether the
  // SHIPPED shell still does — this is that contract. Board maps to board mode, not list.
  assert.match(app, /useSessionsViewToggleKey\(!isMobile, view, navigate\)/,
    "the shell must mount the shared b-toggle hook with the desktop gate");
  assert.match(app, /useSessionsViewModeMemory\(view, instanceScope\)/,
    "the shell must record the last-used Sessions mode");
  assert.match(app, /viewMode=\{view\.name === "board" \? "board" : "list"\}/,
    "the board route must render board mode");
  assert.match(app, /if \(isMobile\) return;/);
  assert.match(app, /xtermOwnsKey\(event\.target\)/);
  assert.match(app, /const zone = cycleFocusZone\(document, event\.shiftKey \? "previous" : "next"\);\s*if \(zone !== null\) indicateFocusZone\(document, zone\);/,
    "F6 and Shift+F6 cycle the zones and light the one they enter");
  assert.equal(app.match(/indicateFocusZone\(/g)?.length, 1, "only the F6 handler lights a zone (§16.1)");
  assert.match(app, /className=\{\`main-body[^\n]*\n\s*data-focus-zone="main"\n\s*tabIndex=\{-1\}/,
    "every route's page root is the main F6 zone");
  assert.match(app, /destination === "inbox"[\s\S]{0,500}focusZone\(document, "list"\)/,
    "the Sessions digit focuses its remembered list or board surface after navigation");

});

test("Inbox focus, unread state, and shortcuts use non-overlapping visual treatments", () => {
  // #2214: no second action surface. Keys are taught on controls, and each row's own trailing
  // actions (Snooze, Archive and ⋯) sit over the row's fill: on hover or focus-within for a fine
  // pointer, and only ⋯, always, for a coarse one.
  assert.doesNotMatch([inbox, inboxList, inboxRow, css].join("\n"), /inbox-shortcut-rail|inbox-activity-footer|InboxShortcutRail/,
    "the shortcut rail and the activity footer are gone");
  assert.match(inboxRow, /className="inbox-row-actions"/);
  assert.match(css, /@media \(pointer: fine\) \{\s*:is\(\.inbox-row-shell:hover, \.inbox-row-shell:focus-within\) \.inbox-row-actions \{ display: inline-flex; \}/,
    "a fine pointer sees the row's actions on hover or focus-within");
  assert.match(css, /@media \(pointer: coarse\) \{[^}]*\.inbox-row-actions \{[^}]*display: inline-flex;[^}]*\}\s*\.inbox-row-action:not\(\.inbox-row-more\) \{ display: none; \}/,
    "a coarse pointer sees only the row's ⋯, always");
  // The state in both panes' place (#2220) is a `.master-detail-state`, which brings min-height 0
  // and its own scroll; the list pane gives it the flexible area.
  assert.match(css, /\.master-detail-state\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/,
    "the page state scrolls on its own");
  assert.match(css, /\.inbox-state \{ flex: 1; \}/, "the page state consumes the flexible list area");
  assert.doesNotMatch(css, /\.inbox-(list|preview)-pane:has\([^{]*focus-visible/,
    "the panes are never framed on focus; F6 marks a zone with a brief top-edge line instead");
  assert.match(css, /\.inbox-list:focus-visible,[\s\S]*?\.detail-scroll:focus-visible \{ outline: none; \}/,
    "scrolling contents must not own the focus boundary");
  // #2076, #2209: unread is a dot and a heavier title, never a fill or the accent bar selection uses.
  assert.match(css, /\.inbox-row-shell\.unread \.inbox-row-title \{ font-weight: 600; \}/,
    "unread sessions read heavier");
  assert.doesNotMatch(css, /\.inbox-row-shell\.unread \.inbox-row\s*\{/,
    "unread never restyles the row's box, which selection owns");
});

test("Inbox project tabs stay balanced, hide overflow chrome, and reveal contextual actions", () => {
  // The focus handoff no longer lives INSIDE exitSearch, and that is the fix rather than a
  // regression: clearing the query re-renders urgently with the previous deferred value, so
  // focusing in the same tick landed on a zero state that the deferred commit then replaced.
  // What must still hold is that exiting clears the query and that focus is restored — now once
  // both the immediate and deferred values have converged.
  assert.match(inbox, /const exitSearch = useCallback\([\s\S]{0,200}setQuery\(""\)/,
    "exiting search clears the query");
  // The board, which has no grid, follows `.inbox-state` once Clear Search took focus with it (#2200).
  assert.match(inbox, /query !== "" \|\| deferredQuery !== ""[\s\S]{0,480}\.inbox-state[\s\S]{0,160}\.board-wrap[\s\S]{0,40}\.focus\(\)/,
    "focus returns to the Inbox once the list it should land on is the one that is mounted");
  assert.match(inbox, /onKeyDown=\{\(event\) => \{[\s\S]*event\.key !== "Escape"[\s\S]*exitSearch\(\)/,
    "Escape exits the search field even when the query is already empty");
  assert.match(groupTabs, /<div className="inbox-tab-group" role="presentation"[\s\S]{0,2400}\{menu\}\s*<\/div>/,
    "project actions are owned by their tab instead of a separate layout item");
  // The shared menu surface (#1803) is the portal: ProjectSplitMenu renders it.
  assert.match(projectSplitMenu, /<MenuSurface/,
    "project menus must render outside the overflow-clipped tab strip");
  assert.match(menuSurface, /createPortal\([\s\S]*document\.body,?\s*\)/,
    "the shared menu surface is portalled to <body>");
  assert.match(css, /\.menu,\s*\.popover\s*\{[^}]*overflow-y:\s*auto;/,
    "capped Project action menus scroll instead of painting outside their surface");
  // The group tabs are the page header's tab row (§4.2, #2180): one tab-row tall, on its hairline.
  assert.match(inbox, /<PageHeader[\s\S]*tabs=\{\(\s*<SessionGroupTabs/, "the group tabs sit in the page header's tab slot");
  assert.match(css, /\.tabs-bar\s*\{[^}]*flex:\s*1;[^}]*align-items:\s*center;[^}]*height:\s*100%;/);
  // The strip is the shared tab row (§10.1), which scrolls sideways without scrollbar chrome.
  assert.match(groupTabs, /<TabList label="Session Groups">/, "the group tabs are the shared tab row");
  assert.match(css, /\.tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*scrollbar-width:\s*none;/);
  assert.match(css, /\.tabs::-webkit-scrollbar\s*\{\s*display:\s*none;/);
  // ⋯ follows the selected Project tab in the row, never over it (#2199): no overlay, no fade over a
  // label, and no tab reserves room for it.
  assert.match(projectSplitMenu, /\{active && \(\s*<button[\s\S]{0,120}className="icon-btn sm inbox-project-actions"/,
    "only the selected Project tab draws ⋯, as a small icon button");
  assert.match(css, /\.inbox-tab-group > \.inbox-project-actions \{ margin-inline-start: var\(--space-1\); \}/,
    "⋯ sits in the row after its tab");
  assert.doesNotMatch(css, /\.inbox-project-menu/, "the overlay, its transform and its touch padding are gone");
  assert.doesNotMatch(css, /\.inbox-tab-group[^{]*> \.tab\s*\{\s*padding-right/,
    "no tab reserves room for the action target (#2180)");
  assert.match(css, /\.inbox-tab-group:has\(> \.inbox-project-actions\) > \.tab \{\s*scroll-margin-inline-end:/,
    "scrolling the selected tab into view brings its ⋯ with it");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.rail-item\.active::before\s*\{\s*content:\s*none;\s*\}[\s\S]*\.rail-item\.active \.rail-tab-pill\s*\{\s*background:\s*var\(--surface-selected\);/,
    "the current phone tab is a tinted pill behind its icon, with nothing drawn below it (§15.1)");
  assert.match(css, /--bottom-bar-h:\s*calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\);/,
    "the labelled tab bar is 56px plus the bottom safe area (§2.7)");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.app-rail\s*\{[^}]*height:\s*var\(--bottom-bar-h\);/);
  assert.match(css, /\.right-panel\s*\{[^}]*bottom:\s*var\(--bottom-bar-h\)/,
    "mobile overlays must stop above the bottom tab bar");
});

test("Inbox unifies Session and Project creation while the shell exposes no duplicate action", () => {
  assert.match(rail, /projects:\s*ProjectsIcon/);
  assert.match(rail, /if \(view\.name === "session" \|\| view\.name === "board"\) return "inbox"/,
    "session detail and board mode remain owned by Sessions");
  assert.doesNotMatch(rail, /view\.name === "projects"[\s\S]*return "inbox"/,
    "Projects owns its rail active state");
  assert.doesNotMatch(rail, /onNewSession|rail-action|PlusIcon/,
    "the desktop rail has no creation action");
  assert.doesNotMatch(app, /title="New Session"[\s\S]*aria-label="New Session"/,
    "the mobile top bar has no creation action");
  // #2159: New Session is the Sessions page header's labeled primary, and New Project… is in its ⋯.
  assert.match(inbox, /const newSession = \(\) => onNewSession\?\.\(activeNewSessionPreset\);/,
    "New Session opens with the active tab's preset");
  assert.match(inbox, /label: "New Project…",[\s\S]*disabled: !projectsSupported,[\s\S]*onClick: \(\) => setCreatingProject\(true\)/,
    "New Project… routes into its existing workflow, and says why when it is unavailable");
  // #2220: the header hides it while the page's state offers New Session itself (§12.1).
  assert.match(inbox, /primary=\{stateOffersNewSession \? undefined : \{ label: "New Session", shortcut: shortcutDisplay\("new-session"\), onClick: newSession \}\}/,
    "the primary is labeled New Session and shows its keycap");
  assert.match(inbox, /creatingProject && \([\s\S]*<CreateProjectDialog/,
    "New Project opens the existing Project creation workflow");
  assert.doesNotMatch(inbox, /inbox-manage-projects|Manage Projects/,
    "Project management lives in the rail instead of the Project bar");
  assert.doesNotMatch(commandPalette, /views\.splice\([^;]*Manage Projects/,
    "the command palette derives its single Projects destination from the global rail vocabulary");
  // #183's touch target now comes from the one coarse-pointer block (#1799): the header's controls
  // and its ⋯ menu items are sized by --control-h, which that block resizes to 44px.
  assert.match(css, /@media \(pointer: coarse\) \{\s*:root \{[^}]*--control-h:\s*44px;/,
    "the header's controls keep a touch-sized target");
  // The intro paragraph became the page header's one-line description (#1801, §4.2: 80 characters).
  // The registry holds it now, beside the destination name (#1945).
  assert.match(projectsView, /const PROJECTS = destination\("projects"\);/);
  assert.match(projectsView, /className="muted project-detail-meta">Project ID:/);
  assert.match(projectsView, /className="muted project-detail-meta">\{projectAudienceVisibilitySummary/);
  assert.match(css, /\.project-detail-meta\s*\{\s*display:\s*block;/,
    "Project identity and audience metadata render on distinct lines");
  assert.match(projectsView, /label="Sessions Visibility"/,
    "the Sessions show-or-hide filter does not reuse the Project audience label");
  for (const label of ["Create Project", "Add Location", "Make Default", "Archive Sessions", "Delete Project"]) {
    assert.equal(projectsView.includes(label), true, label);
  }
  assert.match(projectsView, /its sessions move to No Project[\s\S]*Sessions and files are not deleted/,
    "Project deletion states its non-destructive consequences");
  // #2220: a group whose authoritative count says sessions are coming shows skeleton rows, never a
  // state card in between (sessions-states.test.ts covers the count).
  assert.match(inbox, /const listSkeleton = [\s\S]{0,200}syncingCount !== null/,
    "authoritative Project counts must not momentarily render a false empty state");
  assert.match(inbox, /const situation = [\s\S]{0,80}!listSkeleton/,
    "the empty state waits for the skeleton");
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
  assert.match(projectsView, /onCreate=\{async \(location, generateSetup\)[\s\S]*api\.createProjectLocation/,
    "Project management uses the atomic Project-scoped Location creation API");
  assert.match(css, /\.project-location-create-section > \.disclosure-trigger\s*\{[^}]*width:\s*100%;/,
    "the collapsed creation disclosure remains a full-width readable target");
  // The phone Projects back control is the detail bar's (#1801): an `.icon-btn` named "Back to
  // Projects", one control height, which a touch screen makes 44px.
  assert.match(projectsView, /const phoneDetail = isMobile && selected;[\s\S]*?\{phoneDetail && \(\s*<DetailBar[\s\S]*?backLabel=\{backLabel\("projects"\)\}/,
    "the mobile Projects back target is the detail bar's");
  assert.doesNotMatch(projectsView, /project-manager-back|← Back to Projects/);
  assert.match(pageHeader, /className="icon-btn detail-bar-back"[^>]*aria-label=\{backLabel\}/);
});

test("Sessions Search is one fixed width whether idle, focused or holding a query (#2200)", () => {
  assert.match(inbox, /<SessionsSearchField\b/);
  assert.match(css, /\.inbox-search\s*\{[^}]*flex:\s*none;[^}]*width:\s*240px;/, "240px on a wide main column");
  assert.match(css, /@container app \(max-width: 1099px\)\s*\{\s*\.inbox-search\s*\{\s*width:\s*200px;/,
    "200px in the compact tier");
  assert.doesNotMatch(css, /\.inbox-search[^{]*:focus-within[^{]*\{/, "focus never restyles the field's box");
  assert.doesNotMatch(css, /\.inbox-search[^{]*\{[^}]*transition/, "the field never animates a width");
  assert.match(css, /\.sessions-app-bar-search > \.inbox-search\s*\{\s*flex:\s*1;\s*width:\s*auto;/,
    "a phone's Search mode gives the field the app bar's width beside Cancel (#2082, #2211)");
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
  // The merged suppression named .menu-pop and .instance-selector-pop, and the More sheet was
  // neither, so persistent toasts still covered and intercepted taps on its lower destinations.
  // The sheet is now the shared menu surface (#1803), whose open state hides the stack (#1990).
  assert.match(rail, /<MenuSurface/, "the More sheet is the shared menu surface");
  assert.match(feedbackProvider, /const menuOpen = useMenuOpen\(\);/, "the stack follows the menu primitive's open state");
  assert.match(feedbackProvider, /hiddenByMenu \? "toast-region under-menu"/, "and marks itself hidden from it");
  const rule = /\.toast-region\.under-menu\s*\{[^}]*visibility: hidden;/.test(css);
  assert.ok(rule, "the More sheet must suppress toasts like every other open menu");
});

test("More menu items activate with Space as well as Enter", () => {
  // An <a> activates on Enter natively but never on Space, while role="menuitem" promises both.
  // Every sheet row — destinations and Settings alike — draws these from one helper, so the guard
  // reads the helper rather than the first row that happens to appear in the markup.
  const menuItem = rail.slice(rail.indexOf("const sheetItemProps"));
  const handler = menuItem.slice(menuItem.indexOf("onKeyDown"), menuItem.indexOf("});"));
  assert.ok(handler.length > 0, "menu items must handle keys themselves");
  assert.match(handler, /event\.key !== " "/, "Space must be recognised");
  assert.match(handler, /preventDefault/, "and must not scroll the sheet instead");
  assert.match(handler, /onNavigate\(resolve\(\)\)/,
    "and must actually navigate — through resolve(), so an overflowed Sessions row opens its saved mode");
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
  // mounted, and there is no open state to preserve. Each layout still needs its own entry point —
  // the desktop gear at the foot of the rail, the phone row inside the More sheet — and neither may
  // open anything but the route.
  assert.equal([...app.matchAll(/<SettingsTrigger\s/g)].length, 1,
    "the shell mounts the gear once, for the desktop rail only");
  assert.match(app, /settingsControl: <SettingsTrigger /,
    "and passes it as the rail's desktop control");
  assert.match(rail, /<MenuSeparator \/>[\s\S]*?sheetItemProps\(\{ name: "settings" \}/,
    "the phone entry point is a routed row in the More sheet");
  // Gated on the breakpoint, not on overflowItems: hiding every optional destination by experiment
  // would otherwise unmount the trigger and leave Settings no entry point in the phone chrome.
  assert.match(rail, /const showMore = isMobile;[\s\S]*?\{showMore && \(/,
    "the sheet survives an empty overflow list");
  assert.doesNotMatch(app, /SettingsDialog/, "the dialog is replaced by the route, not kept beside it");
  assert.doesNotMatch(app, /settingsOpen/, "there is no open state to hoist once it is a route");
  assert.match(app, /onOpen=\{\(\) => navigate\(\{ name: "settings" \}\)\}/,
    "the trigger navigates to the route");
});

test("the phone topbar cannot push its controls off-screen", () => {
  // The instance switcher left every phone bar (#1970): the desktop app cannot reach this layout.
  assert.doesNotMatch(css, /instance-selector-(trigger|label|chevron)/,
    "no rule for the retired trigger survives, in the rail or in a phone bar");
  assert.match(css, /\.topbar-mobile-controls > \* \{ flex: none; \}/, "no control grows to push the others off");
  assert.match(css, /\.topbar:has\(\.topbar-mobile-controls\) h1 \{[^}]*text-overflow: ellipsis/,
    "the title must yield before any control does");
  assert.match(css, /\.topbar:has\(\.mobile-session-back\) \{[^}]*height: calc\(var\(--bar-h\)/,
    "the Session route's app bar is the shared 48px bar, which holds 44px hit areas (§4.4)");
  assert.match(css, /\.topbar:has\(\.mobile-session-back\) h1 \{[^}]*font: var\(--type-title\)/,
    "the semantic Session heading is the 16/600 title on phones (§15.1)");
  assert.match(css, /\.topbar:has\(\.mobile-session-back\) \.mobile-session-back,[\s\S]*?\.topbar:has\(\.mobile-session-back\) \.topbar-mobile-controls \.icon-btn \{[^}]*width: 36px;[^}]*height: 36px/,
    "Session navigation and pane controls must share compact phone geometry");
  assert.doesNotMatch(css, /\.topbar-mobile-controls \.settings-trigger/,
    "no phone topbar Settings geometry survives the move into the More sheet");
});

test("the phone Session topbar owns Back and the live Session title without Open", () => {
  assert.match(app, /view\.name === "session" \? \([\s\S]*?className="icon-btn sm mobile-session-back"[\s\S]*?aria-label=\{backLabel\("inbox"\)\}[\s\S]*?<h1 id="page-title"[^>]*>\{sessionTitle \?\? title\}<\/h1>/,
    "the mobile app bar must replace its generic Session heading with Back and the live title");
  // Only the phone Session route mounts the app-level bar now; destinations draw a page header (#1801).
  assert.match(app, /\{view\.name === "session" && isMobile && \(\s*<Header[\s\S]*?sessionTitle=\{activeSession\s*\? sessionDisplayTitle\(activeSession\.title\) \|\| "Session"\s*: routedSessionPlaceholder\(view\.id, routedSessionLookup, conn, snapshotLoaded\)\.title\}/,
    "the shell must pass the routed Session's one-line title, or its placeholder's title (#2202), into the app bar");
  assert.match(app, /\{!isMobile && \(\s*<>\s*<EditorSelect key=\{view\.id\} sessionId=\{view\.id\} \/>/,
    "Open destinations must not be mounted on the mobile Session route");
});

test("Session menu triggers clear popovers without rising to the modal backdrop layer", () => {
  assert.match(css, /\.session-bar:has\(:is\(\.session-status-button, \.session-header-action\)\[aria-expanded="true"\]\)\s+:is\(\.session-status-button, \.session-header-action\) \{[^}]*z-index: var\(--z-popovercontent\);/,
    "sibling triggers should clear the menu backdrop but stay below every modal");
});

test("the phone app bar holds only the Session's own actions", () => {
  // Settings used to be pinned to this cluster's trailing edge (#210, #304). It is a rail
  // destination now (#458), destination create actions moved to each page header (#1801), and the
  // instance switcher left for the desktop rail (#1970). What remains is the Session's actions.
  const start = app.indexOf('<div className="topbar-actions topbar-mobile-controls">');
  const end = app.indexOf("</div>", start);
  assert.ok(start >= 0 && end > start, "the phone controls must share one ordered cluster");
  const mobileCluster = app.slice(start, end);
  assert.match(mobileCluster, /\{sessionActions\}/);
  assert.doesNotMatch(mobileCluster, /Instance|SettingsTrigger|mobileSettingsControl|topbar-create/,
    "the phone topbar mounts no instance or Settings control and no destination action");
  assert.match(css, /\.topbar-mobile-controls \{[^}]*flex-wrap: nowrap/,
    "the unified control cluster must stay on one line");
});

test("the desktop app never reaches the phone layout, which is why no phone bar has a switcher", () => {
  // If this fails, the instance must become the first row of the More sheet instead (#1970).
  for (const config of ["tauri.conf.json", "tauri.e2e.conf.json"]) {
    const parsed = JSON.parse(readFileSync(new URL(`../../desktop/src-tauri/${config}`, import.meta.url), "utf8")) as {
      app: { windows: Array<{ minWidth?: number }> };
    };
    for (const window of parsed.app.windows) {
      assert.ok((window.minWidth ?? 0) > MOBILE_BREAKPOINT_PX, `${config}: minWidth ${window.minWidth}`);
    }
  }
});

test("the Multi-Agent Run and Pod create actions are page header primaries", () => {
  assert.match(runsView, /<PageHeader\s+title=\{runsDestination\.name\}\s+description=\{runsDestination\.description\}\s+primary=\{\{ label: "New Multi-Agent Run", onClick: onNewRun \}\}\s+\/>/);
  // One verb per action (§17.2): the primary and the dialog it opens are both "New Pod".
  assert.match(podsView, /<PageHeader\s+title=\{podsDestination\.name\}\s+description=\{podsDestination\.description\}\s+primary=\{\{ label: "New Pod", onClick: onNewPod \}\}\s+\/>/);
  assert.match(readFileSync(new URL("./components/NewPodDialog.tsx", import.meta.url), "utf8"),
    /<Modal\s+title="New Pod"/);
  assert.doesNotMatch(app, /topbar-create|NewPodHeaderButton/, "the top bar holds no create action");
  // One `.btn.primary` with a `+` icon; on a phone it is the 44px `+` alone, and its label stays
  // in the accessibility tree (clipped, never display: none) so the name still matches.
  assert.match(pageHeader, /className="btn primary page-primary"[\s\S]*?<PlusIcon \/>\s*<span className="page-primary-label">\{primary\.label\}<\/span>/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.page-primary-label \{[^}]*clip-path: inset\(50%\)/);
  assert.doesNotMatch(css, /\.page-primary-label \{[^}]*display: none/);
  assert.match(css, /\.page-primary \{[^}]*width: var\(--control-h\);/,
    "the phone primary is one square control height, 44px on touch");
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
  const block = /@media \(max-width: 760px\) \{[^@]*?\.toast-region\.under-menu[^{]*\{[^}]*\}/s.test(css);
  assert.ok(block, "suppression must apply through 760px, not just the phone breakpoint");
  // The class is set from the same 760px flag, so the hide and the timer pause cover one width.
  assert.match(feedbackProvider, /const hiddenByMenu = isPhone && menuOpen;/);
  assert.match(feedbackProvider, /const isPhone = useIsMobile\(\);/);
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
  // The More sheet is the shared menu surface (#1803); its phone sheet rule is the one that docks
  // it (top: auto) rather than the desktop placement.
  const sheet = /\.menu,\s*\.popover \{([^}]*top: auto;[^}]*)\}/.exec(css)?.[1];
  assert.ok(sheet, "the menu sheet rule must exist");
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

test("the Sessions view toggle is the shared segmented control, and Snoozed is a toggle", () => {
  // It used to opt into a joined-border treatment of its own. §10.2 has one segmented control: a
  // track with a 2px inset and a neutral selected knob. Snoozed filters rather than switches the
  // view, so it is a pressed toggle beside it, not a second segmented control (#2159).
  assert.doesNotMatch(inbox, /<SegmentedControl<ReminderInboxMode>|Reminder View/, "no reminder segmented control remains");
  assert.match(inbox, /label: "Snoozed",[\s\S]*menuLabel: "Show Snoozed Sessions",[\s\S]*pressed: reminderMode === "snoozed"/,
    "Snoozed is a pressed toggle that folds into ⋯ as Show Snoozed Sessions");
  assert.match(inbox, /<SegmentedControl<SessionsViewMode>/, "the Sessions List/Board toggle is a segmented control");
  assert.doesNotMatch(inbox, /inbox-reminder-view|sessions-view-toggle/, "neither opts out of the shared recipe");
  assert.doesNotMatch(css, /inbox-reminder-view|sessions-view-toggle/, "no joined-border override remains");
  assert.match(css, /\.seg \{[^}]*gap: var\(--space-0-5\);[^}]*padding: var\(--space-0-5\);[^}]*border: 1px solid var\(--border\)/,
    "the shared track has the §10.2 inset and a decorative edge");
});
