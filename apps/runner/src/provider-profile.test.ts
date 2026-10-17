import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  adoptProviderProfileMarker,
  decideProviderProfileAccess,
  ProviderProfileChangeError,
  PROVIDER_PROFILE_LIMITS,
  readProviderProfileMarker,
  revokeProviderProfileMarkerGrant,
  validProviderProfileMarker,
  writeProviderProfileMarker,
  type ProviderProfileMarker,
} from "./provider-profile.js";

const posixOnly = { skip: process.platform === "win32" };
const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const OTHER_PROFILE = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const INSTANCE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_INSTANCE = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

function marker(overrides: Partial<ProviderProfileMarker> = {}): ProviderProfileMarker {
  return {
    version: 1, kind: "wollipog-provider-profile", profileId: PROFILE, provider: "claude",
    createdAt: "2026-10-16T00:00:00.000Z",
    grants: [{ controlPlaneInstanceId: INSTANCE, grantId: GRANT, grantedAt: "2026-10-16T00:00:01.000Z" }],
    ...overrides,
  };
}

function home(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function markerPath(root: string): string { return join(root, ".agent-manager", "profile-v1.json"); }

function writeRaw(root: string, value: unknown, mode = 0o600): string {
  mkdirSync(join(root, ".agent-manager"), { recursive: true, mode: 0o700 });
  const path = markerPath(root);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

test("a written marker reads back exactly and leaves no staging file", posixOnly, (t) => {
  const root = home(t);
  writeProviderProfileMarker(root, marker());
  assert.deepEqual(readProviderProfileMarker(root), { state: "present", marker: marker() });
  assert.deepEqual(readdirSync(join(root, ".agent-manager")), ["profile-v1.json"]);
  const replacement = marker({ grants: [] });
  writeProviderProfileMarker(root, replacement);
  assert.deepEqual(readProviderProfileMarker(root), { state: "present", marker: replacement });
  assert.deepEqual(readdirSync(join(root, ".agent-manager")), ["profile-v1.json"]);
  assert.match(readFileSync(markerPath(root), "utf8"), /^\{"version":1,"kind":"wollipog-provider-profile",/u);
});

test("an absent marker or metadata directory is absent, not unverifiable", (t) => {
  const root = home(t);
  assert.deepEqual(readProviderProfileMarker(root), { state: "absent" });
  mkdirSync(join(root, ".agent-manager"));
  assert.deepEqual(readProviderProfileMarker(root), { state: "absent" });
});

test("the writer refuses invalid markers without touching the HOME", posixOnly, (t) => {
  const root = home(t);
  assert.throws(() => writeProviderProfileMarker(root, marker({ profileId: "not-a-uuid" })), /invalid/u);
  assert.throws(() => writeProviderProfileMarker(root, { ...marker(), extra: true } as never), /invalid/u);
  assert.equal(existsSync(join(root, ".agent-manager")), false);
  assert.throws(() => writeProviderProfileMarker(root, marker(), { platform: "win32" }), /not supported/u);
});

test("a symlinked, hard-linked, oversized, or writable marker is unverifiable", posixOnly, (t) => {
  const unverifiable = { state: "unverifiable", cause: "marker" };
  {
    const root = home(t);
    const target = join(root, "elsewhere.json");
    writeFileSync(target, `${JSON.stringify(marker())}\n`, { mode: 0o600 });
    mkdirSync(join(root, ".agent-manager"));
    symlinkSync(target, markerPath(root));
    assert.deepEqual(readProviderProfileMarker(root), unverifiable, "symlinked marker");
  }
  {
    const root = home(t);
    const path = writeRaw(root, marker());
    linkSync(path, join(root, "alias.json"));
    assert.deepEqual(readProviderProfileMarker(root), unverifiable, "hard-linked marker");
  }
  {
    const root = home(t);
    const padded = `${JSON.stringify(marker())}${" ".repeat(PROVIDER_PROFILE_LIMITS.markerBytes)}`;
    writeRaw(root, padded);
    assert.deepEqual(readProviderProfileMarker(root), unverifiable, "oversized marker");
  }
  for (const mode of [0o620, 0o602]) {
    const root = home(t);
    writeRaw(root, marker(), mode);
    assert.deepEqual(readProviderProfileMarker(root), unverifiable, `mode ${mode.toString(8)}`);
  }
  {
    const root = home(t);
    mkdirSync(markerPath(root), { recursive: true });
    assert.deepEqual(readProviderProfileMarker(root), unverifiable, "directory in place of the marker");
  }
});

test("a symlinked or non-directory metadata directory is unsafe ancestry", posixOnly, (t) => {
  const root = home(t);
  const real = join(root, "real");
  writeRaw(real, marker());
  symlinkSync(join(real, ".agent-manager"), join(root, ".agent-manager"));
  assert.deepEqual(readProviderProfileMarker(root), { state: "unverifiable", cause: "ancestry" });
  const file = home(t);
  writeFileSync(join(file, ".agent-manager"), "");
  assert.deepEqual(readProviderProfileMarker(file), { state: "unverifiable", cause: "ancestry" });
});

test("a present marker is never trusted where it cannot be verified", (t) => {
  const root = home(t);
  writeRaw(root, marker());
  assert.deepEqual(readProviderProfileMarker(root, { platform: "win32" }), { state: "unverifiable", cause: "marker" });
});

test("unknown formats, extra keys, duplicate or excessive grants are unverifiable", posixOnly, (t) => {
  const grant = (index: number) => ({
    controlPlaneInstanceId: `${index.toString(16).padStart(8, "0")}-4e5f-4a6b-8c7d-8e9fa0b1c2d3`, grantId: GRANT,
    grantedAt: "2026-10-16T00:00:01.000Z",
  });
  const cases: Array<[string, unknown]> = [
    ["newer version", { ...marker(), version: 2 }],
    ["unknown kind", { ...marker(), kind: "something-else" }],
    ["extra top-level key", { ...marker(), note: "x" }],
    ["missing key", (({ createdAt: _omitted, ...rest }) => rest)(marker())],
    ["extra grant key", marker({ grants: [{ ...grant(1), scope: "all" } as never] })],
    ["duplicate grants", marker({ grants: [grant(1), { ...grant(1), grantId: OTHER_PROFILE }] })],
    ["too many grants", marker({ grants: Array.from({ length: PROVIDER_PROFILE_LIMITS.grants + 1 }, (_, index) => grant(index)) })],
    ["non-v4 profile id", marker({ profileId: "6f1c2d3e-4a5b-1c6d-8e7f-001122334455" })],
    ["uppercase profile id", marker({ profileId: PROFILE.toUpperCase() })],
    ["unknown provider", { ...marker(), provider: "pi" }],
    ["non-ISO timestamp", marker({ createdAt: "yesterday" })],
    ["array", [marker()]],
    ["invalid JSON", "{"],
  ];
  for (const [name, value] of cases) {
    const root = home(t);
    writeRaw(root, value);
    assert.deepEqual(readProviderProfileMarker(root), { state: "unverifiable", cause: "marker" }, name);
  }
  const root = home(t);
  writeRaw(root, marker({ grants: Array.from({ length: PROVIDER_PROFILE_LIMITS.grants }, (_, index) => grant(index)) }));
  assert.equal(readProviderProfileMarker(root).state, "present", "exactly the grant limit is accepted");
});

test("a provider mismatch is unverifiable when the caller names its provider", posixOnly, (t) => {
  const root = home(t);
  writeRaw(root, marker({ provider: "codex" }));
  assert.equal(readProviderProfileMarker(root, { provider: "codex" }).state, "present");
  assert.deepEqual(readProviderProfileMarker(root, { provider: "claude" }), { state: "unverifiable", cause: "marker" });
});

test("the access decision covers all six cases in order", () => {
  const present = { state: "present", marker: marker() } as const;
  const granted = { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE] };
  // 1. No marker and no recorded profile: today's behaviour, including older callers.
  assert.deepEqual(decideProviderProfileAccess({ state: "absent" }, undefined, INSTANCE), { allowed: true });
  assert.deepEqual(decideProviderProfileAccess({ state: "absent" }, granted, undefined), { allowed: true });
  // 2. No marker but a recorded profile id: the directory was replaced.
  assert.deepEqual(decideProviderProfileAccess({ state: "absent" }, { ...granted, expectedId: PROFILE }, INSTANCE),
    { allowed: false, reason: "profile_changed" });
  // 3. Unverifiable marker, whatever the context.
  for (const cause of ["marker", "ancestry"] as const) {
    assert.deepEqual(decideProviderProfileAccess({ state: "unverifiable", cause }, { ...granted, expectedId: PROFILE }, INSTANCE),
      { allowed: false, reason: "profile_unverifiable" });
  }
  // 4. A different marker than the one recorded, checked before capability so a substitution is named.
  assert.deepEqual(decideProviderProfileAccess(present, { controlPlaneSupportsProfiles: false, activeProfileIds: [], expectedId: OTHER_PROFILE }, INSTANCE),
    { allowed: false, reason: "profile_changed" });
  // 5. A marker the control plane cannot negotiate, including older callers that send no context.
  assert.deepEqual(decideProviderProfileAccess(present, undefined, INSTANCE), { allowed: false, reason: "profile_unsupported_control_plane" });
  assert.deepEqual(decideProviderProfileAccess(present, { controlPlaneSupportsProfiles: false, activeProfileIds: [PROFILE] }, INSTANCE),
    { allowed: false, reason: "profile_unsupported_control_plane" });
  // 6. Not granted: missing host-local grant, missing control-plane grant, or no attested instance.
  assert.deepEqual(decideProviderProfileAccess(present, granted, OTHER_INSTANCE), { allowed: false, reason: "profile_not_granted" });
  assert.deepEqual(decideProviderProfileAccess(present, { controlPlaneSupportsProfiles: true, activeProfileIds: [OTHER_PROFILE] }, INSTANCE),
    { allowed: false, reason: "profile_not_granted" });
  assert.deepEqual(decideProviderProfileAccess(present, granted, undefined), { allowed: false, reason: "profile_not_granted" });
  // Granted on both sides.
  assert.deepEqual(decideProviderProfileAccess(present, granted, INSTANCE), { allowed: true, profileId: PROFILE });
  assert.deepEqual(decideProviderProfileAccess(present, { ...granted, expectedId: PROFILE }, INSTANCE.toUpperCase()), { allowed: true, profileId: PROFILE });
});

const NEW_GRANT = "3a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const changeRefusal = (code: string) => (error: unknown) => error instanceof ProviderProfileChangeError && error.code === code;

test("adoption creates an identity for a marker-less HOME and only adds a grant to an existing one", () => {
  const grant = { controlPlaneInstanceId: INSTANCE.toUpperCase(), grantId: GRANT, grantedAt: "2026-10-16T00:00:02.000Z" };
  const created = adoptProviderProfileMarker({ state: "absent" }, { provider: "codex", grant, newProfileId: PROFILE, now: "2026-10-16T00:00:00.000Z" });
  assert.equal(created.changed, true);
  assert.deepEqual(created.marker, { version: 1, kind: "wollipog-provider-profile", profileId: PROFILE, provider: "codex",
    createdAt: "2026-10-16T00:00:00.000Z", grants: [{ ...grant, controlPlaneInstanceId: INSTANCE }] });
  const fresh = adoptProviderProfileMarker({ state: "absent" }, { provider: "claude", grant });
  assert.equal(validProviderProfileMarker(fresh.marker), true, "a generated identity is a valid UUID v4 marker");

  // Another control plane adopting the same HOME keeps the identity and the first grant.
  const existing = marker();
  const other = { controlPlaneInstanceId: OTHER_INSTANCE, grantId: NEW_GRANT, grantedAt: "2026-10-16T00:00:03.000Z" };
  const shared = adoptProviderProfileMarker({ state: "present", marker: existing }, { provider: "claude", grant: other, newProfileId: OTHER_PROFILE });
  assert.equal(shared.marker.profileId, PROFILE);
  assert.deepEqual(shared.marker.grants, [...existing.grants, other]);
  // The same grant again is a no-op; a newer grant of the same instance replaces the older one.
  assert.deepEqual(adoptProviderProfileMarker({ state: "present", marker: existing }, { provider: "claude", grant: existing.grants[0]! }),
    { marker: existing, changed: false });
  const replaced = adoptProviderProfileMarker({ state: "present", marker: existing }, { provider: "claude",
    grant: { controlPlaneInstanceId: INSTANCE, grantId: NEW_GRANT, grantedAt: "2026-10-16T00:00:04.000Z" } });
  assert.deepEqual(replaced.marker.grants.map((candidate) => candidate.grantId), [NEW_GRANT]);
});

test("adoption refuses a marker it cannot extend", () => {
  const grant = { controlPlaneInstanceId: OTHER_INSTANCE, grantId: NEW_GRANT, grantedAt: "2026-10-16T00:00:02.000Z" };
  assert.throws(() => adoptProviderProfileMarker({ state: "unverifiable", cause: "marker" }, { provider: "claude", grant }), changeRefusal("profile_unverifiable"));
  assert.throws(() => adoptProviderProfileMarker({ state: "present", marker: marker() }, { provider: "codex", grant }), changeRefusal("profile_unverifiable"));
  const full = marker({ grants: Array.from({ length: PROVIDER_PROFILE_LIMITS.grants }, (_, index) => ({
    controlPlaneInstanceId: `${index.toString(16).padStart(8, "0")}-4e5f-4a6b-8c7d-8e9fa0b1c2d3`, grantId: GRANT, grantedAt: "2026-10-16T00:00:01.000Z" })) });
  assert.throws(() => adoptProviderProfileMarker({ state: "present", marker: full }, { provider: "claude", grant }), changeRefusal("profile_grant_limit"));
  const mine = { ...grant, controlPlaneInstanceId: full.grants[0]!.controlPlaneInstanceId };
  assert.equal(adoptProviderProfileMarker({ state: "present", marker: full }, { provider: "claude", grant: mine }).changed, true,
    "replacing this instance's own grant needs no free slot");
});

test("revocation drops only one exact grant of one instance", () => {
  const both = marker({ grants: [
    { controlPlaneInstanceId: INSTANCE, grantId: GRANT, grantedAt: "2026-10-16T00:00:01.000Z" },
    { controlPlaneInstanceId: OTHER_INSTANCE, grantId: GRANT, grantedAt: "2026-10-16T00:00:01.000Z" },
  ] });
  const revoked = revokeProviderProfileMarkerGrant({ state: "present", marker: both }, { profileId: PROFILE, controlPlaneInstanceId: INSTANCE, grantId: GRANT });
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.marker?.grants.map((grant) => grant.controlPlaneInstanceId), [OTHER_INSTANCE], "another control plane's grant survives");
  assert.equal(revokeProviderProfileMarkerGrant({ state: "present", marker: both }, { profileId: PROFILE, controlPlaneInstanceId: INSTANCE, grantId: NEW_GRANT }).changed,
    false, "a newer grant of the same instance is not revoked by an older id");
  assert.deepEqual(revokeProviderProfileMarkerGrant({ state: "absent" }, { profileId: PROFILE, controlPlaneInstanceId: INSTANCE, grantId: GRANT }), { changed: false });
  assert.throws(() => revokeProviderProfileMarkerGrant({ state: "present", marker: both }, { profileId: OTHER_PROFILE, controlPlaneInstanceId: INSTANCE, grantId: GRANT }),
    changeRefusal("profile_changed"));
  assert.throws(() => revokeProviderProfileMarkerGrant({ state: "unverifiable", cause: "marker" }, { profileId: PROFILE, controlPlaneInstanceId: INSTANCE, grantId: GRANT }),
    changeRefusal("profile_unverifiable"));
});
