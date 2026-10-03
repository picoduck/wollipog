import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb, TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import {
  MAX_ACTIVE_TRANSCRIPT_SHARES_PER_SESSION,
  MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_SESSION,
  MAX_TRANSCRIPT_SHARE_READS_PER_TOKEN_PER_MINUTE,
  TranscriptShareReadLimiter,
  createAuthorizedTranscriptShare,
  extractTranscriptShareToken,
  listAuthorizedTranscriptShares,
  lookupPublicTranscriptShareCapability,
  resolvePublicTranscriptShare,
  revokeAuthorizedTranscriptShare,
} from "./transcript-shares.js";

const runner: RunnerMetadata = {
  runnerId: "runner-share",
  hostname: "host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [{ id: "workspace-share", name: "Workspace", path: "/private/repo" }],
};

function fixture(location = ":memory:"): { db: ControlPlaneDb; principal: HumanPrincipal } {
  const db = ControlPlaneDb.open(location);
  db.registerRunner(runner, 1, 53);
  db.createSession({
    id: "session-share",
    runnerId: runner.runnerId,
    agentId: null,
    workspaceId: "workspace-share",
    title: "Private title",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 1,
  });
  const identity = db.localIdentityContext();
  return { db, principal: { kind: "human", actorId: identity.userId, ...identity } };
}

function rawDb(db: ControlPlaneDb): DatabaseSync {
  return (db as unknown as { db: DatabaseSync }).db;
}

test("share creation stores only a token hash and freezes one least-data projection", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "before /private/repo secret" }, 2);
  const created = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 10_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.match(created.value.token, /^[A-Za-z0-9_-]{43}$/);

  const row = rawDb(db).prepare(
    "SELECT token_hash, projection_json, snapshot_through_seq FROM transcript_shares WHERE share_id=?",
  ).get(created.value.share.shareId) as { token_hash: string; projection_json: string; snapshot_through_seq: number };
  assert.equal(row.token_hash, hashToken(created.value.token));
  assert.notEqual(row.token_hash, created.value.token);
  assert.ok(!row.projection_json.includes(created.value.token));
  assert.equal(row.snapshot_through_seq, 1);

  const authorization = `MAM-Share ${created.value.token}`;
  const first = resolvePublicTranscriptShare(db, authorization, 10_001);
  assert.ok(first);
  assert.equal(first?.transcript.messages.length, 1);
  assert.equal(first?.transcript.messages[0]?.role, "user");
  assert.equal(first?.transcript.messages[0]?.text.includes("/private/repo"), false);
  assert.equal(JSON.stringify(first).includes("session-share"), false);
  assert.equal(JSON.stringify(first).includes("Private title"), false);

  db.appendEvent("session-share", { kind: "agent_message", text: "later answer", final: true }, 3);
  db.appendEvent("session-share", { kind: "user_message", text: "after" }, 4);
  assert.deepEqual(resolvePublicTranscriptShare(db, authorization, 10_002), first, "later events cannot mutate the share");
});

test("public shares freeze distinct provider messages from the bounded projection", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "agent_message", text: "first ", messageId: "m1" }, 2);
  db.appendEvent("session-share", { kind: "agent_message", text: "message", messageId: "m1" }, 3);
  db.appendEvent("session-share", { kind: "agent_message", text: "second", messageId: "m2" }, 4);
  const created = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 10_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const shared = resolvePublicTranscriptShare(db, `MAM-Share ${created.value.token}`, 10_001);
  assert.deepEqual(shared?.transcript.messages, [
    { role: "assistant", text: "first message" },
    { role: "assistant", text: "second" },
  ]);
});

test("expiry, revocation, deletion, malformed credentials, and corrupt snapshots fail closed", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "shared" }, 2);
  const expiring = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 300 }, 1_000);
  assert.equal(expiring.ok, true);
  if (!expiring.ok) return;
  const auth = `MAM-Share ${expiring.value.token}`;
  assert.ok(resolvePublicTranscriptShare(db, auth, 300_999));
  assert.equal(resolvePublicTranscriptShare(db, auth, 301_000), null, "expiry equality is inactive");
  assert.equal(rawDb(db).prepare("SELECT projection_json FROM transcript_shares WHERE share_id=?")
    .get(expiring.value.share.shareId)?.projection_json, null, "expired sensitive bytes are erased");

  const live = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 400_000);
  assert.equal(live.ok, true);
  if (!live.ok) return;
  assert.ok(resolvePublicTranscriptShare(db, `MAM-Share ${live.value.token}`, 400_001));
  const revoked = revokeAuthorizedTranscriptShare(db, principal, "session-share", live.value.share.shareId, 400_002);
  assert.equal(revoked.ok, true);
  assert.equal(resolvePublicTranscriptShare(db, `MAM-Share ${live.value.token}`, 400_003), null);
  assert.equal(revokeAuthorizedTranscriptShare(db, principal, "session-share", live.value.share.shareId, 400_004).ok, true,
    "revocation is idempotent");

  assert.equal(resolvePublicTranscriptShare(db, undefined, 1), null);
  assert.equal(resolvePublicTranscriptShare(db, "Bearer nope", 1), null);
  assert.equal(resolvePublicTranscriptShare(db, "MAM-Share short", 1), null);
  assert.equal(resolvePublicTranscriptShare(db, `MAM-Share ${"x".repeat(43)}`, 1), null);

  const corrupt = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 500_000);
  assert.equal(corrupt.ok, true);
  if (!corrupt.ok) return;
  const corruptJson = '{"messages":[{"role":"admin","text":"leak"}]}';
  rawDb(db).prepare("UPDATE transcript_shares SET projection_json=?, projection_bytes=? WHERE share_id=?")
    .run(corruptJson, Buffer.byteLength(corruptJson), corrupt.value.share.shareId);
  assert.equal(resolvePublicTranscriptShare(db, `MAM-Share ${corrupt.value.token}`, 500_001), null);

  const deleted = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 600_000);
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  db.deleteSession("session-share");
  assert.equal(resolvePublicTranscriptShare(db, `MAM-Share ${deleted.value.token}`, 600_001), null);
});

test("authorization, expiry bounds, active ceiling, and terminal retention are bounded", () => {
  const { db, principal } = fixture();
  for (const value of [undefined, 299, 2_592_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: value }, 1_000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_expiry");
  }

  const outsider = { ...principal, organizationId: "org-other" };
  let reads = 0;
  const original = db.listTranscriptEventsThrough.bind(db);
  db.listTranscriptEventsThrough = (...args) => { reads += 1; return original(...args); };
  assert.equal(createAuthorizedTranscriptShare(db, outsider, "session-share", { expiresInSeconds: 300 }, 1_000).ok, false);
  assert.equal(reads, 0, "denied creation cannot touch transcript events");

  const active: Array<{ shareId: string; token: string }> = [];
  for (let index = 0; index < MAX_ACTIVE_TRANSCRIPT_SHARES_PER_SESSION; index += 1) {
    const result = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 10_000 + index);
    assert.equal(result.ok, true);
    if (result.ok) active.push({ shareId: result.value.share.shareId, token: result.value.token });
  }
  const limited = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 20_000);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.code, "share_limit");

  // Keep the oldest active share while cycling more terminal rows than the retention ceiling.
  for (const item of active.slice(1)) revokeAuthorizedTranscriptShare(db, principal, "session-share", item.shareId, 21_000);
  for (let index = 0; index < TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION + 10; index += 1) {
    const result = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 300 }, 30_000 + index);
    assert.equal(result.ok, true);
    if (result.ok) revokeAuthorizedTranscriptShare(db, principal, "session-share", result.value.share.shareId, 31_000 + index);
  }
  const physical = rawDb(db).prepare("SELECT COUNT(*) AS count FROM transcript_shares WHERE session_id=?")
    .get("session-share") as { count: number };
  assert.equal(Number(physical.count), 1 + TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION);
  const listed = listAuthorizedTranscriptShares(db, principal, "session-share", 40_000);
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.ok(listed.value.some((share) => share.shareId === active[0]!.shareId && share.status === "active"));
  }
});

test("share listing and revocation reject cross-organization principals before reading rows", () => {
  const { db, principal } = fixture();
  const outsider = { ...principal, organizationId: "org-other" };
  let listReads = 0;
  let revokeWrites = 0;
  const originalList = db.listTranscriptShares.bind(db);
  const originalRevoke = db.revokeTranscriptShare.bind(db);
  db.listTranscriptShares = (...args) => {
    listReads += 1;
    return originalList(...args);
  };
  db.revokeTranscriptShare = (...args) => {
    revokeWrites += 1;
    return originalRevoke(...args);
  };

  assert.deepEqual(listAuthorizedTranscriptShares(db, outsider, "session-share", 1_000), {
    ok: false,
    status: 404,
    error: "session not found",
    code: "not_found",
  });
  assert.deepEqual(revokeAuthorizedTranscriptShare(db, outsider, "session-share", "shr_other", 1_000), {
    ok: false,
    status: 404,
    error: "share not found",
    code: "not_found",
  });
  assert.equal(listReads, 0, "denied listing cannot read share rows");
  assert.equal(revokeWrites, 0, "denied revocation cannot mutate share rows");
});

test("share authorization accepts only the exact independent scheme and token shape", () => {
  const token = "a".repeat(43);
  assert.equal(extractTranscriptShareToken(`MAM-Share ${token}`), token);
  assert.equal(extractTranscriptShareToken(`Wollipog-Share ${token}`), token);
  assert.equal(extractTranscriptShareToken(`mam-share ${token}`), null);
  assert.equal(extractTranscriptShareToken(`wollipog-share ${token}`), null);
  assert.equal(extractTranscriptShareToken(`Bearer ${token}`), null);
  assert.equal(extractTranscriptShareToken(`MAM-Share ${token} trailing`), null);
  assert.equal(extractTranscriptShareToken(`Wollipog-Share ${token} trailing`), null);
  assert.equal(extractTranscriptShareToken(`MAM-Share ${"a".repeat(44)}`), null);
});

test("active capabilities and immutable bytes survive a control-plane restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-transcript-share-"));
  let reopened: ControlPlaneDb | null = null;
  t.after(() => {
    reopened?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, "control-plane.db");
  const now = Date.now();
  const initial = fixture(path);
  initial.db.appendEvent("session-share", { kind: "user_message", text: "restart-safe" }, now);
  const created = createAuthorizedTranscriptShare(
    initial.db,
    initial.principal,
    "session-share",
    { expiresInSeconds: 3600 },
    now,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  initial.db.close();

  reopened = ControlPlaneDb.open(path);
  const shared = resolvePublicTranscriptShare(reopened, `MAM-Share ${created.value.token}`, now + 1_000);
  assert.deepEqual(shared?.transcript.messages, [{ role: "user", text: "restart-safe" }]);
});

test("public read abuse is bounded per hashed capability without blocking another capability", () => {
  const limiter = new TranscriptShareReadLimiter();
  const first = hashToken("a".repeat(43));
  const second = hashToken("b".repeat(43));
  for (let index = 0; index < MAX_TRANSCRIPT_SHARE_READS_PER_TOKEN_PER_MINUTE; index += 1) {
    assert.equal(limiter.allowTokenHash(first, 1_000), true);
  }
  assert.equal(limiter.allowTokenHash(first, 1_000), false);
  assert.equal(limiter.allowTokenHash(second, 1_000), true, "another capability keeps its independent budget");
  for (let index = 0; index < 500; index += 1) assert.equal(limiter.allowTokenHash(first, 1_000), false);
  assert.equal(limiter.allowTokenHash(second, 1_000), true,
    "per-token rejections cannot spend the global admitted-body budget");
  assert.equal(limiter.allowTokenHash(first, 61_000), true, "the bounded window resets");
});

test("well-shaped unknown tokens do not consume the valid projection budget", () => {
  const { db, principal } = fixture();
  const created = createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600 }, 1_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const limiter = new TranscriptShareReadLimiter();
  for (let index = 0; index < 600; index += 1) {
    const unknown = Buffer.alloc(32, index & 0xff).toString("base64url");
    const found = lookupPublicTranscriptShareCapability(db, `MAM-Share ${unknown}`, 1_001);
    if (found) limiter.allowTokenHash(found.tokenHash, 1_001);
  }
  const valid = lookupPublicTranscriptShareCapability(db, `MAM-Share ${created.value.token}`, 1_001);
  assert.ok(valid);
  assert.equal(limiter.allowTokenHash(valid!.tokenHash, 1_001), true);
});

test("active snapshot-byte quotas are atomic and revocation releases retained bytes", () => {
  const { db, principal } = fixture();
  const projectionJson = "x".repeat(60);
  const input = (ordinal: number) => ({
    shareId: `quota-${ordinal}`,
    tokenHash: hashToken(`quota-token-${ordinal}`),
    sessionId: "session-share",
    organizationId: principal.organizationId,
    createdByUserId: principal.userId,
    projectionJson,
    projectionBytes: Buffer.byteLength(projectionJson),
    snapshotThroughSeq: 0,
    schemaVersion: 1,
    createdAt: 1_000 + ordinal,
    expiresAt: 100_000,
  });
  const first = db.createTranscriptShare(input(1), 20, 100, 1_000);
  assert.notEqual(first, "byte_limit");
  const second = db.createTranscriptShare(input(2), 20, 100, 1_000);
  assert.equal(second, "byte_limit");
  assert.ok(db.revokeTranscriptShare("session-share", "quota-1", 2_000));
  const afterRevoke = db.createTranscriptShare(input(3), 20, 100, 1_000);
  assert.notEqual(afterRevoke, "byte_limit");
  assert.equal(db.createTranscriptShare(input(5), 20, 1_000, 100), "byte_limit", "organization quota is independent");
  assert.throws(
    () => db.createTranscriptShare({ ...input(4), projectionBytes: 1 }, 20, 100, 1_000),
    /must equal the positive UTF-8 projection size/,
  );
});

test("share creation translates the retained snapshot byte quota rejection", () => {
  const { db, principal } = fixture();
  const retainedProjection = "x".repeat(MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_SESSION / 4);
  for (let index = 0; index < 4; index += 1) {
    const seeded = db.createTranscriptShare({
      shareId: `quota-seed-${index}`,
      tokenHash: hashToken(`quota-seed-token-${index}`),
      sessionId: "session-share",
      organizationId: principal.organizationId,
      createdByUserId: principal.userId,
      projectionJson: retainedProjection,
      projectionBytes: Buffer.byteLength(retainedProjection),
      snapshotThroughSeq: 0,
      schemaVersion: 1,
      createdAt: 1_000 + index,
      expiresAt: 100_000,
    }, MAX_ACTIVE_TRANSCRIPT_SHARES_PER_SESSION, MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_SESSION,
    MAX_ACTIVE_TRANSCRIPT_SHARE_BYTES_PER_SESSION * 2);
    assert.notEqual(seeded, "byte_limit");
  }

  const result = createAuthorizedTranscriptShare(
    db,
    principal,
    "session-share",
    { expiresInSeconds: 300 },
    2_000,
  );
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: "active transcript shares exceed the retained snapshot byte quota",
    code: "share_storage_limit",
  });
});

const FAKE_TITLE_TOKEN = ["gh", "p_", "b".repeat(30)].join("");

test("a link created without the title opt-in has no title field in its public response (#2189)", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "shared" }, 2);
  for (const request of [{ expiresInSeconds: 3600 }, { expiresInSeconds: 3600, includeTitle: false }]) {
    const created = createAuthorizedTranscriptShare(db, principal, "session-share", request, 10_000);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal("includesTitle" in created.value.share, false);
    const shared = resolvePublicTranscriptShare(db, `Wollipog-Share ${created.value.token}`, 10_001);
    assert.ok(shared);
    assert.equal(Object.hasOwn(shared, "title"), false, "the field is omitted, not empty");
    assert.equal(JSON.stringify(shared).includes("Private title"), false);
    assert.equal(rawDb(db).prepare("SELECT title FROM transcript_shares WHERE share_id=?")
      .get(created.value.share.shareId)?.title, null);
  }
  const listed = listAuthorizedTranscriptShares(db, principal, "session-share", 10_002);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.ok(listed.value.every((share) => !("includesTitle" in share)));
});

test("an opted-in link freezes the redacted display title at creation; a rename does not change it", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "shared" }, 2);
  db.setSessionTitle("session-share", "Fix the  login bug.\nSecond line is not the name", 3, "user");
  const created = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 10_000,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.share.includesTitle, true);
  const authorization = `Wollipog-Share ${created.value.token}`;
  assert.equal(resolvePublicTranscriptShare(db, authorization, 10_001)?.title, "Fix the login bug");

  db.setSessionTitle("session-share", "Renamed afterwards", 10_002, "user");
  assert.equal(resolvePublicTranscriptShare(db, authorization, 10_003)?.title, "Fix the login bug");
  const listed = listAuthorizedTranscriptShares(db, principal, "session-share", 10_004);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.find((share) => share.shareId === created.value.share.shareId)?.includesTitle, true);
});

test("an opted-in title is redacted like message text and bounded to 200 characters", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "shared" }, 2);
  db.setSessionTitle("session-share", `Rotate ${FAKE_TITLE_TOKEN} in /private/repo/config.ts`, 3, "user");
  const secret = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 10_000,
  );
  assert.equal(secret.ok, true);
  if (!secret.ok) return;
  const title = resolvePublicTranscriptShare(db, `Wollipog-Share ${secret.value.token}`, 10_001)?.title;
  assert.equal(title, "Rotate <redacted-secret> in <redacted-path>");

  db.setSessionTitle("session-share", "é".repeat(300), 4, "user");
  const long = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 10_000,
  );
  assert.equal(long.ok, true);
  if (!long.ok) return;
  const bounded = resolvePublicTranscriptShare(db, `Wollipog-Share ${long.value.token}`, 10_001)?.title;
  assert.equal(Array.from(bounded ?? "").length, 200);
  assert.ok(bounded?.endsWith("…"));

  // SQLite's LENGTH() stops at NUL, so control characters are dropped before the title is stored;
  // a title the rename path accepts can never fail the column's CHECK and turn creation into a 500.
  db.setSessionTitle("session-share", "\u0000Fix\u0007 the\u0000 bug\u007f", 4, "user");
  const control = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 10_000,
  );
  assert.equal(control.ok, true);
  if (!control.ok) return;
  assert.equal(resolvePublicTranscriptShare(db, `Wollipog-Share ${control.value.token}`, 10_001)?.title, "Fix the bug");

  // A title that trimming leaves empty is not stored, so the page keeps its own heading.
  db.setSessionTitle("session-share", "  \n ", 5, "user");
  const blank = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 10_000,
  );
  assert.equal(blank.ok, true);
  if (!blank.ok) return;
  assert.equal("includesTitle" in blank.value.share, false);
  const blankShared = resolvePublicTranscriptShare(db, `Wollipog-Share ${blank.value.token}`, 10_001);
  assert.ok(blankShared);
  assert.equal(Object.hasOwn(blankShared, "title"), false);
});

test("a non-boolean includeTitle is refused before anything is stored", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "shared" }, 2);
  for (const includeTitle of ["true", 1, null, {}]) {
    assert.deepEqual(
      createAuthorizedTranscriptShare(db, principal, "session-share", { expiresInSeconds: 3600, includeTitle }, 10_000),
      { ok: false, status: 400, error: "includeTitle must be a boolean", code: "invalid_include_title" },
    );
  }
  assert.equal(rawDb(db).prepare("SELECT COUNT(*) AS count FROM transcript_shares").get()?.count, 0);
});

test("revoking or expiring an opted-in link erases its stored title with the projection", () => {
  const { db, principal } = fixture();
  db.appendEvent("session-share", { kind: "user_message", text: "shared" }, 2);
  const stored = (shareId: string) => ({
    ...rawDb(db).prepare(
      "SELECT title, projection_json IS NULL AS erased FROM transcript_shares WHERE share_id=?",
    ).get(shareId),
  });

  const revoked = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 10_000,
  );
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;
  assert.deepEqual(stored(revoked.value.share.shareId), { title: "Private title", erased: 0 });
  const revocation = revokeAuthorizedTranscriptShare(db, principal, "session-share", revoked.value.share.shareId, 10_001);
  assert.equal(revocation.ok, true);
  if (!revocation.ok) return;
  assert.equal("includesTitle" in revocation.value, false);
  assert.deepEqual(stored(revoked.value.share.shareId), { title: null, erased: 1 });

  const expiring = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 300, includeTitle: true }, 20_000,
  );
  assert.equal(expiring.ok, true);
  if (!expiring.ok) return;
  assert.equal(resolvePublicTranscriptShare(db, `Wollipog-Share ${expiring.value.token}`, 320_000), null);
  assert.deepEqual(stored(expiring.value.share.shareId), { title: null, erased: 1 });

  // Listing erases an expired link's title too, so its row stops saying it includes one.
  const listedExpiry = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 300, includeTitle: true }, 400_000,
  );
  assert.equal(listedExpiry.ok, true);
  if (!listedExpiry.ok) return;
  const listed = listAuthorizedTranscriptShares(db, principal, "session-share", 700_000);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const expiredRow = listed.value.find((share) => share.shareId === listedExpiry.value.share.shareId);
  assert.ok(expiredRow);
  assert.equal("includesTitle" in expiredRow, false);
  assert.deepEqual(stored(listedExpiry.value.share.shareId), { title: null, erased: 1 });

  // The schema refuses a title without its projection, so a future erase path cannot forget it.
  const live = createAuthorizedTranscriptShare(
    db, principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, 800_000,
  );
  assert.equal(live.ok, true);
  if (!live.ok) return;
  assert.throws(
    () => rawDb(db).prepare("UPDATE transcript_shares SET projection_json=NULL WHERE share_id=?")
      .run(live.value.share.shareId),
    /CHECK constraint failed/,
  );
});

/** transcript_shares as it was before #2189 added the title column. */
const LEGACY_TRANSCRIPT_SHARES_SCHEMA = `CREATE TABLE legacy_transcript_shares (
  share_id           TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,
  session_id         TEXT NOT NULL,
  organization_id    TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  projection_json    TEXT,
  projection_bytes   INTEGER NOT NULL CHECK (projection_bytes >= 0 AND projection_bytes <= 8388608),
  snapshot_through_seq INTEGER NOT NULL,
  schema_version     INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  revoked_at         INTEGER,
  CHECK (LENGTH(token_hash) = 64),
  CHECK (schema_version >= 1),
  CHECK (expires_at > created_at),
  CHECK (projection_json IS NULL OR LENGTH(CAST(projection_json AS BLOB)) = projection_bytes),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES identity_users(user_id)
)`;

test("links that existed before the title column gain no title after the migration", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-transcript-share-legacy-"));
  let reopened: ControlPlaneDb | null = null;
  t.after(() => {
    reopened?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, "control-plane.db");
  const now = Date.now();
  const initial = fixture(path);
  initial.db.appendEvent("session-share", { kind: "user_message", text: "legacy message" }, now);
  const legacy = createAuthorizedTranscriptShare(
    initial.db, initial.principal, "session-share", { expiresInSeconds: 3600 }, now,
  );
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  initial.db.close();

  // Rebuild the table in its pre-#2189 shape, keeping the existing link's row.
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.exec(LEGACY_TRANSCRIPT_SHARES_SCHEMA);
  raw.exec(`INSERT INTO legacy_transcript_shares SELECT share_id, token_hash, session_id, organization_id,
    created_by_user_id, projection_json, projection_bytes, snapshot_through_seq, schema_version, created_at,
    expires_at, revoked_at FROM transcript_shares`);
  raw.exec("DROP TABLE transcript_shares");
  raw.exec("ALTER TABLE legacy_transcript_shares RENAME TO transcript_shares");
  const legacyColumns = raw.prepare("PRAGMA table_info(transcript_shares)").all() as Array<{ name: string }>;
  assert.equal(legacyColumns.some((column) => column.name === "title"), false);
  raw.close();

  reopened = ControlPlaneDb.open(path);
  const migrated = reopened;
  const columns = rawDb(migrated).prepare("PRAGMA table_info(transcript_shares)").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "title"), "the migration adds the column");
  const shared = resolvePublicTranscriptShare(migrated, `Wollipog-Share ${legacy.value.token}`, now + 1_000);
  assert.ok(shared);
  assert.deepEqual(shared.transcript.messages, [{ role: "user", text: "legacy message" }]);
  assert.equal(Object.hasOwn(shared, "title"), false);
  assert.equal(JSON.stringify(shared).includes("Private title"), false);
  const listed = listAuthorizedTranscriptShares(migrated, initial.principal, "session-share", now + 1_000);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.ok(listed.value.every((share) => !("includesTitle" in share)));

  // The migrated table enforces the same invariant and accepts a new opted-in link.
  const optedIn = createAuthorizedTranscriptShare(
    migrated, initial.principal, "session-share", { expiresInSeconds: 3600, includeTitle: true }, now + 2_000,
  );
  assert.equal(optedIn.ok, true);
  if (!optedIn.ok) return;
  assert.equal(resolvePublicTranscriptShare(migrated, `Wollipog-Share ${optedIn.value.token}`, now + 3_000)?.title,
    "Private title");
  assert.throws(
    () => rawDb(migrated).prepare("UPDATE transcript_shares SET projection_json=NULL WHERE share_id=?")
      .run(optedIn.value.share.shareId),
    /CHECK constraint failed/,
  );
  assert.equal(revokeAuthorizedTranscriptShare(migrated, initial.principal, "session-share", optedIn.value.share.shareId,
    now + 4_000).ok, true);
  assert.equal(rawDb(migrated).prepare("SELECT title FROM transcript_shares WHERE share_id=?")
    .get(optedIn.value.share.shareId)?.title, null);
});
