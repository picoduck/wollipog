import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID } from "./identity.js";

/**
 * The bootstrap owner's name (#3001): a fixed "Owner" on every install, one rename of the old
 * "Local owner" placeholder, and the default-name marker the People tab asks about.
 */

const ACCOUNT_VARIABLES = ["USER", "LOGNAME", "USERNAME", "HOSTNAME", "COMPUTERNAME", "HOME", "USERPROFILE"] as const;

/** Open a fresh database as if a different account on a different computer started it. */
function openAs(account: string): ControlPlaneDb {
  const saved = new Map(ACCOUNT_VARIABLES.map((name) => [name, process.env[name]]));
  try {
    for (const name of ACCOUNT_VARIABLES) {
      process.env[name] = name.startsWith("HOME") || name === "USERPROFILE" ? `/home/${account}` : account;
    }
    return ControlPlaneDb.open(":memory:");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Every identity record a fresh database holds, without the timestamps that differ per run. */
function identityRecords(db: ControlPlaneDb) {
  const context = db.localIdentityContext();
  const view = db.identityAdministration(context);
  return {
    context: view.context,
    memberships: view.memberships.map(({ createdAt: _createdAt, ...membership }) => membership),
    organizations: view.organizations.map(({ createdAt: _createdAt, ...organization }) => organization),
    teams: view.teams,
  };
}

function rename(db: ControlPlaneDb, displayName: string, nameSaved: boolean) {
  const membership = db.identityAdministration(db.localIdentityContext()).memberships
    .find((item) => item.userId === LOCAL_OWNER_USER_ID)!;
  db.updateIdentityMember({
    organizationId: membership.organizationId,
    userId: LOCAL_OWNER_USER_ID,
    displayName,
    role: membership.role,
    status: membership.userStatus,
    nameSaved,
    now: Date.now(),
  });
}

test("a fresh database names the bootstrap owner Owner and marks it the default, whatever account starts it", () => {
  const ada = openAs("ada.lovelace");
  const grace = openAs("grace-hopper");
  try {
    const first = identityRecords(ada);
    assert.equal(first.context.userName, "Owner");
    assert.equal(first.context.defaultName, true);
    assert.deepEqual(first.memberships.map((member) => [member.userName, member.role]), [["Owner", "owner"]]);
    assert.equal(first.organizations[0]!.name, "Personal organization", "the organization's name is unchanged");
    assert.deepEqual(identityRecords(grace), first, "another account and computer get exactly the same records");
    const stored = JSON.stringify(first);
    for (const personal of ["ada", "lovelace", "grace", "hopper", userInfo().username, hostname()]) {
      if (personal && !"Owner".toLowerCase().includes(personal.toLowerCase())) {
        assert.ok(!stored.toLowerCase().includes(personal.toLowerCase()), `nothing of "${personal}" is stored`);
      }
    }
    assert.ok(!stored.includes("Local owner"));
  } finally {
    ada.close();
    grace.close();
  }
});

test("saving the bootstrap owner's name clears the marker, even when the name stays Owner", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    rename(db, "Owner", false);
    assert.equal(db.identityAdministration(db.localIdentityContext()).context.defaultName, true,
      "an update that did not save the name keeps the marker");
    rename(db, "Owner", true);
    const after = db.identityAdministration(db.localIdentityContext());
    assert.equal(after.context.userName, "Owner");
    assert.equal("defaultName" in after.context, false, "a name saved once is never asked about again");
    rename(db, "Owner", false);
    assert.equal("defaultName" in db.identityAdministration(db.localIdentityContext()).context, false,
      "and a later update never puts the marker back");
  } finally {
    db.close();
  }
});

test("the marker is reported to the bootstrap owner only, never in another member's context", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const owner = db.localIdentityContext();
    db.createIdentityMember({ userId: "usr_ada", displayName: "Owner", organizationId: owner.organizationId, role: "admin", now: 1 });
    const ada = db.identityAdministration({ ...owner, userId: "usr_ada", userName: "Owner", role: "admin", localBootstrap: false });
    assert.equal("defaultName" in ada.context, false, "a member who chose the name Owner is not asked");
    assert.equal(db.identityAdministration(owner).context.defaultName, true);
    // A stale marker in the caller's context never survives the read.
    assert.equal("defaultName" in db.identityAdministration({ ...ada.context, defaultName: true }).context, false);
  } finally {
    db.close();
  }
});

/** A database as an install before #3001 left it: no marker column, and the given owner name. */
function legacyDatabase(ownerName: string): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-bootstrap-owner-name-"));
  const path = join(root, "control-plane.db");
  const db = ControlPlaneDb.open(path);
  db.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE identity_users DROP COLUMN default_name");
  legacy.prepare("UPDATE identity_users SET display_name=? WHERE user_id=?").run(ownerName, LOCAL_OWNER_USER_ID);
  legacy.close();
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("an install whose owner is still Local owner is renamed Owner once, at startup, and marked the default", () => {
  const { path, cleanup } = legacyDatabase("Local owner");
  try {
    let db = ControlPlaneDb.open(path);
    const migrated = db.identityAdministration(db.localIdentityContext());
    assert.equal(migrated.context.userName, "Owner");
    assert.equal(migrated.context.defaultName, true);
    assert.deepEqual(migrated.memberships.map((member) => [member.userId, member.userName, member.role]),
      [[LOCAL_OWNER_USER_ID, "Owner", "owner"]], "the id and role are unchanged");
    // Choosing the old placeholder deliberately afterwards is a name like any other.
    rename(db, "Local owner", true);
    db.close();
    db = ControlPlaneDb.open(path);
    const reopened = db.identityAdministration(db.localIdentityContext());
    assert.equal(reopened.context.userName, "Local owner", "the rename ran once and never again");
    assert.equal("defaultName" in reopened.context, false);
    db.close();
  } finally {
    cleanup();
  }
});

test("an install whose owner has any other name keeps it and is not marked", () => {
  for (const name of ["Misko", "Owner", "local owner", "Local owner "]) {
    const { path, cleanup } = legacyDatabase(name);
    try {
      const db = ControlPlaneDb.open(path);
      const kept = db.identityAdministration(db.localIdentityContext());
      assert.equal(kept.context.userName, name, `"${name}" is kept`);
      assert.equal("defaultName" in kept.context, false, `"${name}" is not marked`);
      db.close();
    } finally {
      cleanup();
    }
  }
});
