import { expect, test, type Page } from "@playwright/test";

const CURRENT_DB = "wollipog-composer-drafts";
const LEGACY_DB = "mam-composer-drafts";
const STORE = "drafts";

type Draft = { text: string; images: []; updatedAt: number; revision: string };

function resourceKey(prefix: string, sessionId: string, instanceScope: string): string {
  const tuple = [instanceScope, sessionId].map((part) => `${part.length}:${part}`).join("");
  return `${prefix}:${tuple}`;
}

const currentKey = (sessionId: string, scope = "local") =>
  resourceKey("wollipog.resource.v1", sessionId, scope);
const legacyKey = (sessionId: string, scope = "local") =>
  resourceKey("mam.resource.v1", sessionId, scope);
const fallbackMarkerKey = (sessionId: string, scope = "local") =>
  resourceKey("wollipog.instance.v1", `wollipog.composer.draft-tombstone.${sessionId}`, scope);

async function deleteDatabase(page: Page, name: string): Promise<void> {
  await page.evaluate((dbName) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`database ${dbName} deletion was blocked`));
  }), name);
}

async function putRecord(page: Page, dbName: string, key: string, value: Draft): Promise<void> {
  await page.evaluate(({ dbName, storeName, key, value }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
  }), { dbName, storeName: STORE, key, value });
}

async function getRecord(page: Page, dbName: string, key: string): Promise<Draft | null> {
  return page.evaluate(({ dbName, storeName, key }) => new Promise<Draft | null>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, "readonly");
      const read = tx.objectStore(storeName).get(key);
      read.onsuccess = () => resolve((read.result as Draft | undefined) ?? null);
      read.onerror = () => reject(read.error);
      tx.oncomplete = () => db.close();
    };
  }), { dbName, storeName: STORE, key });
}

async function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await indexedDB.databases())
    .map((database) => database.name)
    .filter((name): name is string => Boolean(name)));
}

async function load(page: Page, sessionId: string, instanceScope = "local") {
  return page.evaluate(
    ({ sessionId, instanceScope }) =>
      window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.load(sessionId, instanceScope),
    { sessionId, instanceScope },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/composer-drafts-storage-e2e.html");
  await deleteDatabase(page, CURRENT_DB);
  await deleteDatabase(page, LEGACY_DB);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
});

test("does not create the legacy database for a fresh profile", async ({ page }) => {
  expect(await load(page, "missing")).toBeNull();
  expect(await databaseNames(page)).toContain(CURRENT_DB);
  expect(await databaseNames(page)).not.toContain(LEGACY_DB);

  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save("fresh", "new database only", "remote-a"));
  expect((await getRecord(page, CURRENT_DB, currentKey("fresh", "remote-a")))?.text)
    .toBe("new database only");
  expect(await databaseNames(page)).not.toContain(LEGACY_DB);
});

test("aborts a missing legacy database creation when database enumeration is unavailable", async ({ page }) => {
  expect(await page.evaluate(async () => {
    Object.defineProperty(indexedDB, "databases", { configurable: true, value: undefined });
    try {
      return await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.load("missing-without-enumeration");
    } finally {
      delete (indexedDB as IDBFactory & { databases?: unknown }).databases;
    }
  })).toBeNull();
  expect(await databaseNames(page)).not.toContain(LEGACY_DB);
});

test("copies legacy local, remote, and raw-session records into translated new keys", async ({ page }) => {
  const local: Draft = { text: "local legacy", images: [], updatedAt: 1, revision: "local-old" };
  const remoteA: Draft = { text: "remote A legacy", images: [], updatedAt: 2, revision: "a-old" };
  const remoteB: Draft = { text: "remote B legacy", images: [], updatedAt: 3, revision: "b-old" };
  const raw: Draft = { text: "raw local legacy", images: [], updatedAt: 4, revision: "raw-old" };

  await putRecord(page, LEGACY_DB, legacyKey("same-id"), local);
  await putRecord(page, LEGACY_DB, legacyKey("same-id", "remote-a"), remoteA);
  await putRecord(page, LEGACY_DB, legacyKey("same-id", "remote-b"), remoteB);
  await putRecord(page, LEGACY_DB, "raw-session", raw);

  expect((await load(page, "same-id"))?.text).toBe(local.text);
  expect((await load(page, "same-id", "remote-a"))?.text).toBe(remoteA.text);
  expect((await load(page, "same-id", "remote-b"))?.text).toBe(remoteB.text);
  expect((await load(page, "raw-session"))?.text).toBe(raw.text);

  expect(await getRecord(page, CURRENT_DB, currentKey("same-id"))).toEqual(local);
  expect(await getRecord(page, CURRENT_DB, currentKey("same-id", "remote-a"))).toEqual(remoteA);
  expect(await getRecord(page, CURRENT_DB, currentKey("same-id", "remote-b"))).toEqual(remoteB);
  expect(await getRecord(page, CURRENT_DB, currentKey("raw-session"))).toEqual(raw);

  // Copy-forward is deliberately non-destructive: an app rollback can still read every old key.
  expect(await getRecord(page, LEGACY_DB, legacyKey("same-id"))).toEqual(local);
  expect(await getRecord(page, LEGACY_DB, legacyKey("same-id", "remote-a"))).toEqual(remoteA);
  expect(await getRecord(page, LEGACY_DB, "raw-session")).toEqual(raw);
});

test("closes the legacy database connection when deletion requests a version change", async ({ page }) => {
  const retained: Draft = { text: "legacy", images: [], updatedAt: 1, revision: "legacy-revision" };
  await putRecord(page, LEGACY_DB, legacyKey("versionchange"), retained);

  expect(await load(page, "versionchange")).toEqual(retained);
  await deleteDatabase(page, LEGACY_DB);
  expect(await databaseNames(page)).not.toContain(LEGACY_DB);
});

test("prefers an existing Wollipog record and does not overwrite it from the legacy database", async ({ page }) => {
  const current: Draft = { text: "new wins", images: [], updatedAt: 10, revision: "new" };
  const legacy: Draft = { text: "old loses", images: [], updatedAt: 20, revision: "old" };
  await putRecord(page, CURRENT_DB, currentKey("conflict", "remote-a"), current);
  await putRecord(page, LEGACY_DB, legacyKey("conflict", "remote-a"), legacy);

  expect(await load(page, "conflict", "remote-a")).toEqual(current);
  expect(await getRecord(page, CURRENT_DB, currentKey("conflict", "remote-a"))).toEqual(current);
  expect(await getRecord(page, LEGACY_DB, legacyKey("conflict", "remote-a"))).toEqual(legacy);
});

test("writes only the new database and tombstones deletions without mutating legacy records", async ({ page }) => {
  const retained: Draft = { text: "retained old copy", images: [], updatedAt: 1, revision: "old" };
  await putRecord(page, LEGACY_DB, legacyKey("deleted", "remote-a"), retained);
  expect(await load(page, "deleted", "remote-a")).toEqual(retained);

  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save("saved", "new-only", "remote-a"));

  const current = await getRecord(page, CURRENT_DB, currentKey("saved", "remote-a"));
  expect(current?.text).toBe("new-only");
  expect(await getRecord(page, LEGACY_DB, legacyKey("saved", "remote-a"))).toBeNull();

  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.delete("deleted", "remote-a"));
  expect(await getRecord(page, CURRENT_DB, currentKey("deleted", "remote-a"))).toBeNull();
  expect(await getRecord(page, LEGACY_DB, legacyKey("deleted", "remote-a"))).toEqual(retained);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "deleted", "remote-a")).toBeNull();
  expect(await getRecord(page, LEGACY_DB, legacyKey("deleted", "remote-a"))).toEqual(retained);

  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save("deleted", "new after delete", "remote-a"));
  expect((await load(page, "deleted", "remote-a"))?.text).toBe("new after delete");
  expect(await getRecord(page, LEGACY_DB, legacyKey("deleted", "remote-a"))).toEqual(retained);
});

test("conditionally deleting a legacy-only draft leaves its source and blocks re-import", async ({ page }) => {
  const retained: Draft = { text: "submitted", images: [], updatedAt: 1, revision: "submitted-old" };
  await putRecord(page, LEGACY_DB, legacyKey("conditional", "remote-a"), retained);

  expect(await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
      .deleteIfMatches("conditional", "submitted", "submitted-old", "remote-a"))).toBe(true);
  expect(await getRecord(page, LEGACY_DB, legacyKey("conditional", "remote-a"))).toEqual(retained);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "conditional", "remote-a")).toBeNull();
});

test("a failed legacy open without a matching snapshot does not hide the legacy draft", async ({ page }) => {
  const retained: Draft = { text: "newer legacy edit", images: [], updatedAt: 1, revision: "newer-old" };
  await putRecord(page, LEGACY_DB, legacyKey("fault", "remote-a"), retained);
  // Open and cache the new database before faulting only the legacy open path.
  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save("warmup", "warm", "remote-a"));

  const deleted = await page.evaluate(async () => {
    const prototype = Object.getPrototypeOf(indexedDB) as IDBFactory;
    const original = prototype.open;
    Object.defineProperty(prototype, "open", {
      configurable: true,
      value(this: IDBFactory, name: string, version?: number) {
        if (name === "mam-composer-drafts") throw new Error("legacy open fault");
        return version === undefined ? original.call(this, name) : original.call(this, name, version);
      },
    });
    try {
      return await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .deleteIfMatches("fault", "newer legacy edit", "submitted-old", "remote-a");
    } finally {
      Object.defineProperty(prototype, "open", { configurable: true, value: original });
    }
  });
  expect(deleted).toBe(false);
  expect(await load(page, "fault", "remote-a")).toEqual(retained);
  expect(await getRecord(page, LEGACY_DB, legacyKey("fault", "remote-a"))).toEqual(retained);
});

test("an unconditional delete suppresses a retained current record after transaction failure", async ({ page }) => {
  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save("delete-fault", "must stay deleted", "remote-a"));
  const retained = await getRecord(page, CURRENT_DB, currentKey("delete-fault", "remote-a"));
  expect(retained?.text).toBe("must stay deleted");

  await page.evaluate(async () => {
    const prototype = IDBDatabase.prototype;
    const original = prototype.transaction;
    Object.defineProperty(prototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (this.name === "wollipog-composer-drafts" && mode === "readwrite") {
          throw new Error("current transaction fault");
        }
        return original.call(this, storeNames, mode, options);
      },
    });
    try {
      await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.delete("delete-fault", "remote-a");
    } finally {
      Object.defineProperty(prototype, "transaction", { configurable: true, value: original });
    }
  });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "delete-fault", "remote-a")).toBeNull();
  expect(await getRecord(page, CURRENT_DB, currentKey("delete-fault", "remote-a"))).toEqual(retained);

  const newer: Draft = {
    text: "written after deletion",
    images: [],
    updatedAt: Date.now() + 1_000,
    revision: "after-delete",
  };
  await putRecord(page, CURRENT_DB, currentKey("delete-fault", "remote-a"), newer);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "delete-fault", "remote-a")).toEqual(newer);
});

test("a fallback save keeps deletion intent while persistent IDB writes fail", async ({ page }) => {
  const sessionId = "persistent-write-fault";
  const scope = "remote-a";
  await page.evaluate(({ sessionId, scope }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "old IDB draft", scope),
  { sessionId, scope });
  const retained = await getRecord(page, CURRENT_DB, currentKey(sessionId, scope));
  expect(retained?.text).toBe("old IDB draft");

  const frozenNow = retained!.updatedAt + 100;
  await page.evaluate(async ({ sessionId, scope, frozenNow }) => {
    const prototype = IDBDatabase.prototype;
    const original = prototype.transaction;
    const originalNow = Date.now;
    Date.now = () => frozenNow;
    Object.defineProperty(prototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (this.name === "wollipog-composer-drafts" && mode === "readwrite") {
          throw new Error("persistent current write fault");
        }
        return original.call(this, storeNames, mode, options);
      },
    });
    try {
      await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.delete(sessionId, scope);
      await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "new fallback draft", scope);
    } finally {
      Date.now = originalNow;
      Object.defineProperty(prototype, "transaction", { configurable: true, value: original });
    }
  }, { sessionId, scope, frozenNow });

  expect(await getRecord(page, CURRENT_DB, currentKey(sessionId, scope))).toEqual(retained);
  expect(await load(page, sessionId, scope)).toMatchObject({
    text: "new fallback draft",
    updatedAt: frozenNow + 1,
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, sessionId, scope)).toMatchObject({
    text: "new fallback draft",
    updatedAt: frozenNow + 1,
  });
  expect(await getRecord(page, CURRENT_DB, currentKey(sessionId, scope))).toEqual(retained);
});

test("a fingerprint-only deletion marker preserves an identical later fallback save", async ({ page }) => {
  const sessionId = "fingerprint-only-later-save";
  const scope = "remote-a";
  await page.evaluate(({ sessionId, scope }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "identical", scope),
  { sessionId, scope });
  const retained = await getRecord(page, CURRENT_DB, currentKey(sessionId, scope));
  expect(retained?.text).toBe("identical");

  const frozenNow = retained!.updatedAt + 100;
  expect(await page.evaluate(async ({ sessionId, scope, frozenNow }) => {
    const prototype = IDBDatabase.prototype;
    const original = prototype.transaction;
    const originalNow = Date.now;
    Date.now = () => frozenNow;
    Object.defineProperty(prototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (this.name === "wollipog-composer-drafts" && mode === "readwrite") {
          throw new Error("persistent current write fault");
        }
        return original.call(this, storeNames, mode, options);
      },
    });
    try {
      const deleted = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .deleteIfMatches(sessionId, "identical", undefined, scope);
      await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "identical", scope);
      return deleted;
    } finally {
      Date.now = originalNow;
      Object.defineProperty(prototype, "transaction", { configurable: true, value: original });
    }
  }, { sessionId, scope, frozenNow })).toBe(false);

  expect(await getRecord(page, CURRENT_DB, currentKey(sessionId, scope))).toEqual(retained);
  expect(await load(page, sessionId, scope)).toMatchObject({ text: "identical", updatedAt: frozenNow + 1 });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, sessionId, scope)).toMatchObject({ text: "identical", updatedAt: frozenNow + 1 });
  expect(await getRecord(page, CURRENT_DB, currentKey(sessionId, scope))).toEqual(retained);
});

test("a failed conditional transaction hides only the exact reserved revision", async ({ page }) => {
  await page.evaluate(() =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save("conditional-fault", "submitted", "remote-a"));
  const retained = await load(page, "conditional-fault", "remote-a");
  expect(retained?.revision).toBeTruthy();

  expect(await page.evaluate(async ({ revision }) => {
    const prototype = IDBDatabase.prototype;
    const original = prototype.transaction;
    Object.defineProperty(prototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (this.name === "wollipog-composer-drafts" && mode === "readwrite") {
          throw new Error("current transaction fault");
        }
        return original.call(this, storeNames, mode, options);
      },
    });
    try {
      return await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .deleteIfMatches("conditional-fault", "submitted", revision, "remote-a");
    } finally {
      Object.defineProperty(prototype, "transaction", { configurable: true, value: original });
    }
  }, { revision: retained!.revision! })).toBe(false);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "conditional-fault", "remote-a")).toBeNull();

  const newer: Draft = {
    text: "newer edit",
    images: [],
    updatedAt: Date.now() + 1_000,
    revision: "newer-revision",
  };
  await putRecord(page, CURRENT_DB, currentKey("conditional-fault", "remote-a"), newer);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "conditional-fault", "remote-a")).toEqual(newer);
});

test("healthy exact IDB conditional deletion does not compute a fallback fingerprint", async ({ page }) => {
  const sessionId = "healthy-conditional-delete";
  const scope = "remote-a";
  await page.evaluate(({ sessionId, scope }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "submitted", scope),
  { sessionId, scope });
  const submitted = await load(page, sessionId, scope);
  expect(submitted?.revision).toBeTruthy();

  const result = await page.evaluate(async ({ sessionId, scope, revision }) => {
    const prototype = SubtleCrypto.prototype;
    const original = prototype.digest;
    let digestCalls = 0;
    Object.defineProperty(prototype, "digest", {
      configurable: true,
      value(this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource) {
        digestCalls += 1;
        return original.call(this, algorithm, data);
      },
    });
    try {
      const deleted = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .deleteIfMatches(sessionId, "submitted", revision, scope);
      return { deleted, digestCalls };
    } finally {
      Object.defineProperty(prototype, "digest", { configurable: true, value: original });
    }
  }, { sessionId, scope, revision: submitted!.revision! });

  expect(result).toEqual({ deleted: true, digestCalls: 0 });
  expect(await load(page, sessionId, scope)).toBeNull();
});

test("an accepted marker suppresses only the exact IndexedDB revision across reload", async ({ page }) => {
  const sessionId = "accepted-idb-revision";
  const scope = "remote-a";
  const key = currentKey(sessionId, scope);
  await page.evaluate(({ sessionId, scope }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "submitted", scope),
  { sessionId, scope });
  const submitted = await load(page, sessionId, scope);
  expect(submitted?.revision).toBeTruthy();

  expect(await page.evaluate(({ sessionId, scope, revision }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
      .markAccepted(sessionId, "submitted", revision, scope),
  { sessionId, scope, revision: submitted!.revision! })).toBe(true);
  expect(await getRecord(page, CURRENT_DB, key)).toEqual(submitted);
  expect(await load(page, sessionId, scope)).toBeNull();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, sessionId, scope)).toBeNull();

  const newer: Draft = {
    text: "submitted",
    images: [],
    updatedAt: submitted!.updatedAt + 1,
    revision: "newer-identical-revision",
  };
  await putRecord(page, CURRENT_DB, key, newer);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, sessionId, scope)).toEqual(newer);
});

test("accepted fallback reservation suppresses the exact superseded IndexedDB revision", async ({ page }) => {
  const sessionId = "accepted-fallback-superseded";
  const scope = "remote-a";
  const key = currentKey(sessionId, scope);
  await page.evaluate(({ sessionId, scope }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.save(sessionId, "submitted", scope),
  { sessionId, scope });
  const prior = await getRecord(page, CURRENT_DB, key);
  expect(prior?.revision).toBeTruthy();

  const result = await page.evaluate(async ({ sessionId, scope }) => {
    const dbPrototype = IDBDatabase.prototype;
    const subtlePrototype = SubtleCrypto.prototype;
    const originalTransaction = dbPrototype.transaction;
    const originalDigest = subtlePrototype.digest;
    let rejectReservationWrite = true;
    Object.defineProperty(dbPrototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (this.name === "wollipog-composer-drafts" && mode === "readwrite" && rejectReservationWrite) {
          rejectReservationWrite = false;
          throw new Error("reservation write fault");
        }
        return originalTransaction.call(this, storeNames, mode, options);
      },
    });
    Object.defineProperty(subtlePrototype, "digest", {
      configurable: true,
      value: () => { throw new Error("SubtleCrypto unavailable"); },
    });
    try {
      const reserved = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .reserve(sessionId, "submitted", scope);
      const marked = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .markAccepted(sessionId, reserved.text, reserved.revision, scope, reserved.supersededRevision);
      const deleted = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .deleteIfMatches(sessionId, reserved.text, reserved.revision, scope, reserved.supersededRevision);
      return { reserved, marked, deleted };
    } finally {
      Object.defineProperty(dbPrototype, "transaction", { configurable: true, value: originalTransaction });
      Object.defineProperty(subtlePrototype, "digest", { configurable: true, value: originalDigest });
    }
  }, { sessionId, scope });

  expect(result.reserved.revision).not.toBe(prior!.revision);
  expect(result.reserved.supersededRevision).toBe(prior!.revision);
  expect(result.marked).toBe(true);
  expect(result.deleted).toBe(true);
  expect(await getRecord(page, CURRENT_DB, key)).toEqual(prior);
  expect(await load(page, sessionId, scope)).toBeNull();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, sessionId, scope)).toBeNull();

  const newer: Draft = {
    text: "submitted",
    images: [],
    updatedAt: Date.now() + 1_000,
    revision: "newer-identical-after-acceptance",
  };
  await putRecord(page, CURRENT_DB, key, newer);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, sessionId, scope)).toEqual(newer);
});

test("healthy accepted cleanup removes its redundant localStorage marker", async ({ page }) => {
  const sessionId = "accepted-marker-cleanup";
  const scope = "remote-a";
  const reserved = await page.evaluate(({ sessionId, scope }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.reserve(sessionId, "submitted", scope),
  { sessionId, scope });

  expect(await page.evaluate(({ sessionId, scope, revision }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.markAccepted(sessionId, "submitted", revision, scope),
  { sessionId, scope, revision: reserved.revision })).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), fallbackMarkerKey(sessionId, scope)))
    .not.toBeNull();

  expect(await page.evaluate(({ sessionId, scope, revision }) =>
    window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.deleteIfMatches(sessionId, "submitted", revision, scope),
  { sessionId, scope, revision: reserved.revision })).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), fallbackMarkerKey(sessionId, scope)))
    .toBeNull();
  expect(await load(page, sessionId, scope)).toBeNull();
});

test("stale save cleanup cannot erase a later identical-content revision", async ({ page }) => {
  const sessionId = "stale-save-race";
  const scope = "remote-a";
  const key = currentKey(sessionId, scope);
  const result = await page.evaluate(async ({ sessionId, scope, key, currentDb }) => {
    const dbPrototype = IDBDatabase.prototype;
    const storePrototype = IDBObjectStore.prototype;
    const originalTransaction = dbPrototype.transaction;
    const originalPut = storePrototype.put;
    const writtenRevisions: string[] = [];
    let releaseFirstTransaction = false;
    let writeTransactionCount = 0;
    let resolveFirstTransaction!: () => void;
    let resolveQueuedTransactions!: () => void;
    const firstTransaction = new Promise<void>((resolve) => { resolveFirstTransaction = resolve; });
    const queuedTransactions = new Promise<void>((resolve) => { resolveQueuedTransactions = resolve; });

    Object.defineProperty(storePrototype, "put", {
      configurable: true,
      value(this: IDBObjectStore, value: unknown, recordKey?: IDBValidKey) {
        if (this.transaction.db.name === currentDb && recordKey === key &&
            value && typeof value === "object" && "revision" in value &&
            typeof (value as { revision?: unknown }).revision === "string") {
          writtenRevisions.push((value as { revision: string }).revision);
        }
        return recordKey === undefined
          ? originalPut.call(this, value)
          : originalPut.call(this, value, recordKey);
      },
    });
    Object.defineProperty(dbPrototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        const tx = originalTransaction.call(this, storeNames, mode, options);
        if (this.name !== currentDb || mode !== "readwrite") return tx;
        writeTransactionCount += 1;
        if (writeTransactionCount === 1) {
          const store = tx.objectStore("drafts");
          const keepAlive = () => {
            const request = store.get("__stale-save-gate__");
            request.onsuccess = () => {
              if (!releaseFirstTransaction) keepAlive();
            };
          };
          keepAlive();
          resolveFirstTransaction();
        }
        if (writeTransactionCount === 3) resolveQueuedTransactions();
        return tx;
      },
    });

    try {
      const staleSave = window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .save(sessionId, "identical content", scope);
      await firstTransaction;
      const deletion = window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.delete(sessionId, scope);
      const newerSave = window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .save(sessionId, "identical content", scope);
      await queuedTransactions;
      releaseFirstTransaction = true;
      await Promise.all([staleSave, deletion, newerSave]);
      const loaded = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.load(sessionId, scope);
      return { loadedRevision: loaded?.revision ?? null, writtenRevisions };
    } finally {
      releaseFirstTransaction = true;
      Object.defineProperty(dbPrototype, "transaction", {
        configurable: true,
        value: originalTransaction,
      });
      Object.defineProperty(storePrototype, "put", { configurable: true, value: originalPut });
    }
  }, { sessionId, scope, key, currentDb: CURRENT_DB });

  expect(result.writtenRevisions).toHaveLength(2);
  expect(result.writtenRevisions[0]).not.toBe(result.writtenRevisions[1]);
  expect(result.loadedRevision).toBe(result.writtenRevisions[1]);
});

test("a newer save started during conditional deletion survives its completion", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { reserveComposerDraftSnapshot } = await import("/src/composer-drafts.ts");
    const sessionId = "conditional-delete-newer-save";
    const scope = "remote-a";
    const submitted = await reserveComposerDraftSnapshot(
      sessionId,
      "identical content",
      [],
      scope,
    );
    const prototype = IDBDatabase.prototype;
    const originalTransaction = prototype.transaction;
    let releaseConditionalDelete = false;
    let writeTransactionCount = 0;
    let resolveConditionalDeleteStarted!: () => void;
    let resolveNewerSaveQueued!: () => void;
    const conditionalDeleteStarted = new Promise<void>((resolve) => {
      resolveConditionalDeleteStarted = resolve;
    });
    const newerSaveQueued = new Promise<void>((resolve) => { resolveNewerSaveQueued = resolve; });

    Object.defineProperty(prototype, "transaction", {
      configurable: true,
      value(
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        const tx = originalTransaction.call(this, storeNames, mode, options);
        if (this.name !== "wollipog-composer-drafts" || mode !== "readwrite") return tx;
        writeTransactionCount += 1;
        if (writeTransactionCount === 1) {
          const store = tx.objectStore("drafts");
          const keepAlive = () => {
            const request = store.get("__conditional-delete-gate__");
            request.onsuccess = () => {
              if (!releaseConditionalDelete) keepAlive();
            };
          };
          keepAlive();
          resolveConditionalDeleteStarted();
        }
        if (writeTransactionCount === 2) resolveNewerSaveQueued();
        return tx;
      },
    });

    try {
      const conditionalDelete = window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.deleteIfMatches(
        sessionId,
        submitted.text,
        submitted.revision!,
        scope,
      );
      await conditionalDeleteStarted;
      const newerSave = window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .save(sessionId, "identical content", scope);
      await newerSaveQueued;
      releaseConditionalDelete = true;
      const [deleted] = await Promise.all([conditionalDelete, newerSave]);
      const loaded = await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__.load(sessionId, scope);
      return {
        deleted,
        submittedRevision: submitted.revision ?? null,
        loadedRevision: loaded?.revision ?? null,
        loadedText: loaded?.text ?? null,
      };
    } finally {
      releaseConditionalDelete = true;
      Object.defineProperty(prototype, "transaction", {
        configurable: true,
        value: originalTransaction,
      });
    }
  });

  expect(result.deleted).toBe(true);
  expect(result.loadedText).toBe("identical content");
  expect(result.loadedRevision).not.toBeNull();
  expect(result.loadedRevision).not.toBe(result.submittedRevision);
});

test("a fallback match survives current IndexedDB failure and blocks a later legacy import", async ({ page }) => {
  const retained: Draft = { text: "fallback submitted", images: [], updatedAt: 1, revision: "fallback-old" };
  await page.evaluate((draft) => {
    localStorage.setItem("mam.composer.draft.fallback-only", JSON.stringify(draft));
  }, retained);

  expect(await page.evaluate(async () => {
    const prototype = Object.getPrototypeOf(indexedDB) as IDBFactory;
    const original = prototype.open;
    Object.defineProperty(prototype, "open", {
      configurable: true,
      value(this: IDBFactory, name: string, version?: number) {
        if (name === "wollipog-composer-drafts") throw new Error("current open fault");
        return version === undefined ? original.call(this, name) : original.call(this, name, version);
      },
    });
    try {
      return await window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__
        .deleteIfMatches("fallback-only", "fallback submitted", "fallback-old");
    } finally {
      Object.defineProperty(prototype, "open", { configurable: true, value: original });
    }
  })).toBe(true);

  await putRecord(page, LEGACY_DB, legacyKey("fallback-only"), retained);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
  expect(await load(page, "fallback-only")).toBeNull();
  expect(await getRecord(page, LEGACY_DB, legacyKey("fallback-only"))).toEqual(retained);
});
