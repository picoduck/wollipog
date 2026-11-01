import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const view = readFileSync(new URL("./RunnersView.tsx", import.meta.url), "utf8");
const machine = readFileSync(new URL("./MachineDetail.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./MachineSettingsDialog.tsx", import.meta.url), "utf8");
const discovery = readFileSync(new URL("./AgentSessionDiscoveryDialog.tsx", import.meta.url), "utf8");
const access = readFileSync(new URL("./PeopleDevicesPanel.tsx", import.meta.url), "utf8");
const teamDialog = readFileSync(new URL("./TeamDialog.tsx", import.meta.url), "utf8");
const personAccess = readFileSync(new URL("./PersonAccessDialogs.tsx", import.meta.url), "utf8");
const pairDevice = readFileSync(new URL("./PairDeviceDialog.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("./Icons.tsx", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("./SetUpThisMachineDialog.tsx", import.meta.url), "utf8");
const install = readFileSync(new URL("./InstallManuallyDialog.tsx", import.meta.url), "utf8");
const repair = readFileSync(new URL("./RepairConnectionDialog.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const agents = readFileSync(new URL("./MachineAgentsSection.tsx", import.meta.url), "utf8");
const agentHelpers = readFileSync(new URL("../machine-agents.ts", import.meta.url), "utf8");

test("Connections separates machines from people and exposes durable machine recovery", () => {
  // The shared tab row (§10.1) owns role="tablist"; it sits in the page header's tab slot.
  assert.match(view, /tabs=\{\(\s*<TabList label="Connections"/);
  assert.match(view, /aria-controls=\{`connections-\$\{item\.id\}-panel`\}/);
  assert.match(view, /handleRovingChoiceKeyDown\(event, "tab"\)/);
  assert.match(view, /id: "instances" as const/);
  assert.match(view, /<InstancesPanel \/>/);
  assert.match(view, /id: "machines", label: <>Machines/);
  assert.match(view, /id: "people", label: <>People and Devices/);
  assert.match(view, /const instancesTab = instances\.desktopMultiInstance && !isMobile/);
  assert.match(view, /<PeopleDevicesPanel identity=\{identity\}/);
  assert.match(machine, />Repair Connection…<\/button>/);
  assert.match(machine, /actions=\{access\.canManage && \(/);
  assert.match(view, /useMachineActions\(selectedMachine, \{\s*canManage: canManageMachines,/);
  assert.match(machine, /Ask an organization owner or admin to repair this connection/);
  assert.match(view, /runnerId=\{repairRunnerId\}/);
  assert.match(view, /isManagedLocalRunnerRepair\(runnerId, localRunnerStatus, bundledLocalRunner, localInstanceActive\)/);
  assert.match(view, /isManagedLocalRunnerRepair[\s\S]*setOnboarding\("local"\)[\s\S]*setRepairRunnerId\(runnerId\)/);
  assert.match(view, /onRepair: repairRunner/);
  // Only a known older protocol proves an SSH runner is out of date (#2988's Update Required notice).
  assert.match(machine, /if \(runnerOutdated\(runner\.protocolVersion\)\) return "update_required";/);
  assert.doesNotMatch(machine, /runner\.protocolVersion == null \|\| runnerOutdated/);
  assert.match(view, /role="alert"/);
});

test("People and device tasks use progressive disclosure and only Agents collapse", () => {
  assert.match(access, /const canPair = admin && identity\.context\.localBootstrap/);
  assert.match(access, /Pairing and revocation must be started from this instance’s trusted local dashboard\./);
  assert.match(access, /kind: "add-person"/);
  assert.match(access, /kind: "pair-device"/);
  assert.match(access, /kind: "create-team"/);
  assert.match(access, /Forms open only when/);
  // The forms are dialogs of their own files; Pair Device is one (#2999).
  assert.match(pairDevice, /<Modal/);
  assert.match(access, /nextAdmin \? await api\.listDevices\(\) : \{ devices: \[\] \}/);
  assert.match(teamDialog, /api\.createIdentityTeam\(\{ name: trimmed, memberUserIds: memberIds \}\)/);
  assert.match(personAccess, /api\.updateIdentityMember\(member\.userId, \{\s*displayName:/s);
  assert.doesNotMatch(access, /device-pair-row/);
  // One detail for every machine (#2988): the spec sheet moved into Connection Details.
  assert.doesNotMatch(view, /runner-meta|runner-system-meta/);
  // Agents are a section of rows, not a disclosure of cards (#2990).
  assert.match(view, /<MachineAgentsSection runner=\{runner\}/);
  assert.doesNotMatch(view, /runner-agents disclosure|runner-agents-summary/);
  assert.doesNotMatch(view, /<details className="runner-details">/);
  assert.match(machine, /export function MachineDetail\(/);
  assert.doesNotMatch(view, /export function (BoxCard|NativeRunnerCard)\(/);
  assert.match(machine, /<h2 className="machine-detail-title" title=\{name\}>\{name\}<\/h2>/);
  assert.doesNotMatch(css, /\.runner-card\.status-offline/);
  // auto-FILL, not auto-fit: auto-fit collapses the empty tracks so a single instance stretched to
  // a full-bleed card holding two fields.
  const rule = /\.instance-grid\s*\{[^}]*\}/s.exec(css)?.[0];
  assert.ok(rule, ".instance-grid rule must exist");
  assert.match(rule!, /repeat\(auto-fill, minmax\(min\(100%, 360px\), 1fr\)\)/,
    ".instance-grid must use auto-fill so one card does not span the row");
  assert.doesNotMatch(rule!, /auto-fit/, ".instance-grid must not reintroduce auto-fit");
  // Machines are rows beside their detail now (#2985): the card grid is gone.
  assert.doesNotMatch(css, /\.runner-grid\b/);
  assert.doesNotMatch(view, /runner-grid/);
});

test("Connections controls use one centered SVG icon system instead of font glyphs", () => {
  assert.match(icons, /strokeLinecap="round"/);
  assert.match(icons, /className=\{`app-icon/);
  assert.match(machine, /<RefreshIcon \/>/);
  assert.match(machine, /<SettingsIcon \/>/);
  assert.match(machine, /<WifiOffIcon \/>/);
  assert.doesNotMatch(machine, /⬆|↻|✕|🔍/);
  // Rediscover and Reconnect are ⋯ items now, not pill buttons (#2988).
  assert.doesNotMatch(css + view + machine, /btn-rediscover/);
});

test("a machine's actions live in Settings… and ⋯, and Connection Details lists its facts", () => {
  assert.match(machine, /<ActionsMenu label="Machine Actions" items=\{actions\.menu\} \/>/);
  assert.match(machine, /<ConnectionDetailsDialog runner=\{runner\} box=\{box\}/);
  assert.match(machine, /label: "Deployed Build"/);
  assert.match(machine, /label: "Platform"/);
  assert.doesNotMatch(view + machine, /<dt>Deployed Binary<\/dt>|connection-details-trigger|runner-head|os-badge/);
  assert.doesNotMatch(css, /\.runner-card-actions|\.runner-connection-meta|\.connection-details-list|\.os-badge/);
  assert.match(view, /<MachineSettingsDialog/);
  // Machine Settings is its own one-form dialog (#2991).
  assert.doesNotMatch(view, /function MachineSettingsDialog|ProviderAccountDefaultsSettings|api\.updateMachine/);
  assert.match(settings, /<label htmlFor=\{nameIds\.input\}>Machine Name<\/label>/);
  assert.match(machine, /title: "Delete Machine"/);
  assert.match(settings, /confirmDeleteMachine\(confirm, \{ name: display\.name/);
  assert.match(settings, /api\.updateMachineCapacity/);
  // Workspaces and the capacity readouts live in the machine's detail now (#2989).
  assert.doesNotMatch(view + settings, /registerMachineWorkspace|DirectoryPicker|Add Workspace|<h3>Workspaces<\/h3>/);
  assert.doesNotMatch(view + settings, /Runner Capacity Usage|Capacity Dimensions|Current Capacity Bottlenecks|Units Used/);
  assert.doesNotMatch(css, /\.group-head|\.workspace-list|\.ws-(?:name|path)|machine-capacity-blockers|\.machine-workspace-(?:create|form)/);
  assert.match(machine, /label: "Idle Processes"/);
  assert.match(settings, /machineSettingsMutationError\(cause\)/);
  assert.match(settings, /disabled=\{deleteBlocked \|\| saving\}/);
  // Older runner data is the machine's notice now, not Machine Settings' Danger Zone (#2988).
  assert.doesNotMatch(view + settings, /runnerDataLayout|adoptLegacyBoxData|Danger Zone/);
  assert.match(machine, /if \(box\.runnerDataLayout === "legacy"\) return "legacy_data";/);
  assert.match(machine, /box\.legacyDataAccountStatus === "adopted"/);
  assert.match(machine, /title="Older Runner Data Found"/);
  assert.match(machine, /Confirm that every legacy runner process using this SSH account on \$\{name\} is stopped\./);
  assert.match(machine, /confirmLabel: "Adopt Legacy Data",\n\s*\}\);/, "a non-destructive confirmation");
  assert.match(machine, /adopt: "Interrupt Sessions and Adopt"/);
  assert.match(machine, /api\.adoptLegacyBoxData\(box\.boxId, force\)/);
});

test("runner repair preserves identity and rotates when needed; adding and repairing are separate dialogs (#2992)", () => {
  assert.match(repair, /api\.rotateRunnerCredential\(runnerId, "Connection repair"\)/);
  assert.match(view, /<RepairConnectionDialog runnerId=\{repairRunnerId\}/);
  assert.match(view, /onboarding === "manual" && <InstallManuallyDialog/);
  assert.match(view, /onboarding === "local" && \(\s*<SetUpThisMachineDialog/);
  assert.match(onboarding, /Wollipog couldn't reach its bundled runner\. Close this dialog and try again\./);
  // The host choice is a Select whose options read in words (§8.4), not a segmented control.
  assert.match(install, /<Select label="Connects To" value=\{host\} options=\{hostOptions\}/);
  assert.doesNotMatch(install + repair + onboarding, /SegmentedControl|runner-hosts|step-head/);
  assert.doesNotMatch(css, /\.onboard-health|\.onboard-advanced-toggle|\.step-head|\.runner-hosts/);
  // Set Up This Machine (#2993) replaced the local mode's bordered card and its agent chips.
  assert.doesNotMatch(css, /\.onboard \{|\.onboard-local/);
});

test("agent session discovery is a progressive modal instead of an inline runner-card list", () => {
  assert.match(machine, /<AgentSessionDiscoveryDialog runner=\{runner\}/);
  assert.match(machine, /setFindingSessionsFor\(runnerId\)/);
  // Find Agent Sessions… is a ⋯ item (#2988); the Agent Sessions promo group is gone.
  assert.doesNotMatch(view + machine, /runner-agent-sessions/);
  assert.doesNotMatch(view, /function ExternalSessions/);
  assert.doesNotMatch(view, /<ul className="ext-session-list">/);
  assert.match(discovery, /title="Find Agent Sessions"/);
  assert.match(discovery, /<ChoiceRows\s+label="Agent"/);
  assert.match(discovery, /api\.listExternalSessions\(runner\.runnerId, selectedAgent\.id\)/);
  assert.match(discovery, /response\.sessions\.filter\(\(session\) => sessionMatchesAgent/);
  assert.match(discovery, /driver === "codex-app-server"/);
});

test("Find Agent Sessions sizes to its content and sets no uppercase text (#2994)", () => {
  const rules = [...css.matchAll(/([^{}]*\.agent-session-[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const [, selector, body] of rules) {
    for (const [, px] of body!.matchAll(/min-height:\s*(\d+(?:\.\d+)?)px/g)) {
      assert.ok(Number(px) <= 44, `${selector!.trim()} holds a ${px}px minimum height`);
    }
    assert.doesNotMatch(body!, /text-transform:\s*uppercase/, selector!.trim());
  }
  assert.doesNotMatch(discovery, /className="(?:[^"]*\s)?(?:ext-|atag)/, "results are §5.2 rows, not chips");
});

test("a Codex exec agent reads as no longer supported, never as a fallback (#3224, #3259)", () => {
  // Its one status is Unavailable, and Agent Details says how to fix the configuration (#2990).
  assert.match(agentHelpers, /if \(isRetiredCodexExec\(agent\)\) return notice\(CODEX_EXEC_RETIRED_CONFIG_REASON\)/);
  for (const source of [view, agents, agentHelpers]) {
    assert.doesNotMatch(source, /Fallback Ready|Non-Interactive Fallback|Existing Sessions Only/);
  }
});

test("agent rows open Agent Details, which keeps launch diagnostics and their icon-only copy controls (#2990)", () => {
  assert.match(agents, /<button type="button" className="row row-2" aria-haspopup="dialog"/);
  assert.match(agents, /title=\{name\}\s*description=\{`On \$\{machineName\}`\}/);
  assert.match(agents, />Launch Command<\/h3>/);
  assert.match(agents, /<CodeWell value=\{launch\.command\} name=\{`\$\{name\} Launch Command`\} \/>/);
  // No chips, dots, info buttons or inline guidance in the rows, and no retired classes left behind.
  assert.doesNotMatch(agents, /atag|auth-dot|install-cmd|install-hints|agent-details-|<InfoIcon/);
  assert.doesNotMatch(view, /AgentDetailsDialog|AgentRow|install-hints|auth-dot|Probing for agent CLIs/);
  assert.doesNotMatch(css, /\.agent-details-|\.auth-dot|\.install-hints|\.atag\.driver-/);
  assert.match(css, /\.copy-btn\.icon-only-copy/);
  assert.match(css, /\.agent-session-results-step:focus\s*\{\s*outline: none;/);
});
