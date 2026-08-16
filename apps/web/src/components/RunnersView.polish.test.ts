import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const view = readFileSync(new URL("./RunnersView.tsx", import.meta.url), "utf8");
const discovery = readFileSync(new URL("./AgentSessionDiscoveryDialog.tsx", import.meta.url), "utf8");
const access = readFileSync(new URL("./PeopleDevicesPanel.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("./Icons.tsx", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("./OnboardRunnerDialog.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("Connections separates machines from people and exposes durable machine recovery", () => {
  assert.match(view, /role="tablist"[\s\S]*aria-label="Connection Settings"/);
  assert.match(view, /aria-controls=\{`connections-\$\{item\.id\}-panel`\}/);
  assert.match(view, /handleRovingChoiceKeyDown\(event, "tab"\)/);
  assert.match(view, /id: "instances" as const/);
  assert.match(view, /<InstancesPanel \/>/);
  assert.match(view, /id: "machines", label: <>Machines/);
  assert.match(view, /id: "people", label: <>People &amp; Devices/);
  assert.match(view, /instances\.desktopMultiInstance/);
  assert.match(view, /<PeopleDevicesPanel identity=\{identity\}/);
  assert.match(view, /Repair Credential…/);
  assert.match(view, /canRepair=\{canManage\}/);
  assert.match(view, /<NativeRunnerCard[\s\S]*canManage=\{canManageMachines\}/);
  assert.match(view, /Ask an organization owner or admin to repair this connection/);
  assert.match(view, /initialRunnerId=\{repairRunnerId\}/);
  assert.match(view, /isManagedLocalRunnerRepair\(runnerId, localRunnerStatus, bundledLocalRunner, localInstanceActive\)/);
  assert.match(view, /isManagedLocalRunnerRepair[\s\S]*setOnboarding\("local"\)[\s\S]*setRepairRunnerId\(runnerId\)/);
  assert.match(view, /onRepair=\{repairRunner\}/);
  assert.match(view, /const needsUpdate = !!runner && runnerOutdated\(runner\.protocolVersion\)/);
  assert.match(view, /\{canManage && needsUpdate && !inProgress && \(/);
  assert.doesNotMatch(view, /\{needsUpdate && !updating && \(/);
  assert.doesNotMatch(view, /runner\.protocolVersion == null \|\| runnerOutdated/);
  assert.match(view, /role="alert"/);
});

test("People and device tasks use progressive disclosure and only Agents collapse", () => {
  assert.match(access, /const canPair = admin && identity\.context\.localBootstrap/);
  assert.match(access, /Pairing and revocation must be started from this instance’s trusted local dashboard\./);
  assert.match(access, /kind: "add-person"/);
  assert.match(access, /kind: "pair-device"/);
  assert.match(access, /kind: "create-team"/);
  assert.match(access, /Forms open only when/);
  assert.match(access, /<Modal/);
  assert.match(access, /nextAdmin \? await api\.listDevices\(\) : \{ devices: \[\] \}/);
  assert.match(access, /api\.createIdentityTeam\(\{ name: name\.trim\(\), memberUserIds: memberIds \}\)/);
  assert.match(access, /api\.updateIdentityMember\(member\.userId, \{\s*displayName:/s);
  assert.doesNotMatch(access, /device-pair-row/);
  assert.match(view, /<dl className="runner-meta runner-system-meta" aria-label="System Details">/);
  assert.match(view, /<details className="runner-agents">/);
  assert.doesNotMatch(view, /<details className="runner-details">/);
  assert.match(view, /export function BoxCard\(/);
  assert.match(view, /export function NativeRunnerCard\(/);
  assert.match(view, /<article className=\{`runner-card status-\$\{runner\.status\}`\}>[\s\S]*<div className="runner-head">[\s\S]*<div className="runner-id">[\s\S]*<h2>\{runnerDisplay\(runner, undefined, runner\.runnerId\)\.name\}<\/h2>/);
  assert.doesNotMatch(css, /\.runner-card\.status-offline\s*\{[^}]*opacity:/s);
  // auto-FILL, not auto-fit: auto-fit collapses the empty tracks so a single machine — the default
  // for a new install — stretched to a full-bleed card holding two fields.
  // Asserted per grid: an unscoped match would be satisfied by .instance-grid alone, letting
  // .runner-grid regress to a single full-width column without failing.
  for (const selector of [".runner-grid", ".instance-grid"]) {
    const rule = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`, "s").exec(css)?.[0];
    assert.ok(rule, `${selector} rule must exist`);
    assert.match(rule!, /repeat\(auto-fill, minmax\(min\(100%, 360px\), 1fr\)\)/,
      `${selector} must use auto-fill so one card does not span the row`);
    assert.doesNotMatch(rule!, /auto-fit/, `${selector} must not reintroduce auto-fit`);
  }
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.runner-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
});

test("Connections controls use one centered SVG icon system instead of font glyphs", () => {
  assert.match(icons, /strokeLinecap="round"/);
  assert.match(icons, /className=\{`app-icon/);
  assert.match(view, /<UpdateIcon \/>/);
  assert.match(view, /<RefreshIcon \/>/);
  assert.match(view, /<SettingsIcon \/>/);
  assert.doesNotMatch(view.slice(view.indexOf("function BoxCard")), /⬆|↻|✕|🔍/);
  assert.match(css, /\.btn-rediscover\s*\{[^}]*display: inline-flex;[^}]*align-items: center;/s);
});

test("machine cards use consistent action rows and progressively disclose deployment diagnostics", () => {
  assert.match(view, /className="runner-head-right runner-card-actions"/);
  assert.match(view, /title="Connection Details"/);
  assert.match(view, /<BoxConnectionDetailsDialog box=\{box\}/);
  assert.match(view, /<dt>Last Deployed Build<\/dt>/);
  assert.match(view, /<dt>Runner Platform<\/dt>/);
  assert.doesNotMatch(view, /<dt>Deployed Binary<\/dt>/);
  assert.match(css, /\.runner-card-actions\s*\{[^}]*margin-bottom: 14px;/s);
  assert.match(css, /\.runner-connection-meta\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(view, /<MachineSettingsDialog/);
  assert.match(view, /<span>Machine Name<\/span>/);
  assert.match(view, /<span>Add Workspace<\/span>/);
  assert.match(view, /"Delete Machine"/);
  assert.match(view, /api\.registerMachineWorkspace/);
  assert.match(view, /machineSettingsMutationError\(cause\)/);
  assert.match(view, /disabled=\{deleting \|\| onlineNativeRunner\}/);
  assert.match(view, /box\?\.runnerDataLayout === "legacy"/);
  assert.match(view, /box\.legacyDataAccountStatus === "adopted"/);
  assert.match(view, /Legacy Runner Data Adopted/);
  assert.match(view, /Legacy Data Adoption in Progress/);
  assert.match(view, /Confirm that every legacy runner process using this SSH account is stopped\./);
  assert.match(view, /confirmLabel: "Adopt Legacy Data"/);
  assert.match(view, /confirmLabel: "Interrupt Sessions and Adopt Legacy Data"/);
  assert.match(view, /api\.adoptLegacyBoxData\(box\.boxId, false\)/);
  assert.match(view, /api\.adoptLegacyBoxData\(box\.boxId, true\)/);
});

test("runner repair preserves identity, rotates when needed, and exposes selection semantics", () => {
  assert.match(onboarding, /initialRunnerId\?: string/);
  assert.match(onboarding, /api\.rotateRunnerCredential\(id, "Connection repair"\)/);
  assert.match(onboarding, /readOnly=\{repairingExisting\}/);
  assert.match(onboarding, /mode !== "local" && \(!showLocalSetup \|\| advancedOpen\)/);
  assert.match(onboarding, /Wollipog could not access its managed local runner\. Close this dialog and try again\./);
  assert.match(onboarding, /role="radiogroup"/);
  assert.match(onboarding, /role="radio"/);
  assert.match(onboarding, /aria-checked=\{host === h\}/);
});

test("agent session discovery is a progressive modal instead of an inline runner-card list", () => {
  assert.match(view, /<AgentSessionDiscoveryDialog runner=\{runner\}/);
  assert.match(view, /setFindingSessions\(true\)/);
  assert.doesNotMatch(view, /function ExternalSessions/);
  assert.doesNotMatch(view, /<ul className="ext-session-list">/);
  assert.match(discovery, /title="Find Agent Sessions"/);
  assert.match(discovery, /<legend>Select an Agent<\/legend>/);
  assert.match(discovery, /api\.listExternalSessions\(runner\.runnerId, selectedAgent\.id\)/);
  assert.match(discovery, /response\.sessions\.filter\(\(session\) => sessionMatchesAgent/);
  assert.match(discovery, /driver === "codex-app-server"/);
});

test("agent cards progressively disclose launch diagnostics with icon-only copy controls", () => {
  assert.match(view, /<AgentDetailsDialog a=\{a\}/);
  assert.match(view, /title=\{`\$\{displayName\} Details`\}/);
  assert.match(view, /<h3>Launch Command<\/h3>/);
  assert.match(view, /iconOnly/);
  assert.match(view, /<InfoIcon \/>/);
  assert.doesNotMatch(view, /\{contextLabel\(a\.context\)\} launch:/);
  assert.match(css, /\.agent-details-command/);
  assert.match(css, /\.copy-btn\.icon-only-copy/);
  assert.match(css, /\.agent-session-results-step:focus\s*\{\s*outline: none;/);
});
