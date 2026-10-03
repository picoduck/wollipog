import assert from "node:assert/strict";
import test from "node:test";
import { Window as HappyWindow } from "happy-dom";
import { accountEmailPrivacy, setHideAccountEmails, subscribeAccountEmailPrivacy, HIDE_ACCOUNT_EMAILS_STORAGE_KEY as KEY } from "./account-email-privacy.js";

function browser() { return new HappyWindow({ url: "http://localhost/" }) as unknown as Window; }

test("an absent or invalid choice defaults off without writing; explicit choices persist", () => {
  for (const saved of [null, "", "yes", "false", "corrupt"]) {
    const win = browser();
    if (saved !== null) win.localStorage.setItem(KEY, saved);
    assert.equal(accountEmailPrivacy(win).hide, false);
    assert.equal(win.localStorage.getItem(KEY), saved);
    setHideAccountEmails(true, win);
    assert.equal(win.localStorage.getItem(KEY), "true");
    const reload = browser();
    reload.localStorage.setItem(KEY, win.localStorage.getItem(KEY)!);
    assert.equal(accountEmailPrivacy(reload).hide, true);
    setHideAccountEmails(false, win);
    assert.equal(win.localStorage.getItem(KEY), "false");
  }
});

test("mounted readers share a stable snapshot, receive transitions, and detach the shared listener", () => {
  const win = browser();
  let calls = 0;
  const unsubscribe = subscribeAccountEmailPrivacy(() => calls++, win);
  const initial = accountEmailPrivacy(win);
  assert.equal(accountEmailPrivacy(win), initial);
  setHideAccountEmails(true, win);
  const enabled = accountEmailPrivacy(win);
  setHideAccountEmails(false, win);
  setHideAccountEmails(true, win);
  assert.equal(accountEmailPrivacy(win).hide, true);
  assert.ok(accountEmailPrivacy(win).revision > enabled.revision);
  assert.equal(calls, 3);
  unsubscribe();
  win.localStorage.setItem(KEY, "false");
  assert.equal(accountEmailPrivacy(win).hide, false, "a reopened surface reads the persisted mode");
});

test("cross-tab off/on events invalidate reveals even after the final write; other storage is ignored", () => {
  const win = browser();
  const unsubscribe = subscribeAccountEmailPrivacy(() => {}, win);
  setHideAccountEmails(true, win);
  const before = accountEmailPrivacy(win);
  const dispatch = (key: string | null, oldValue: string | null, newValue: string | null, storageArea = win.localStorage) => {
    win.dispatchEvent(new (win as Window & typeof globalThis).StorageEvent("storage", { key, oldValue, newValue, storageArea }));
  };
  dispatch("other.preference", "true", "false");
  dispatch(KEY, "true", "false", win.sessionStorage);
  assert.equal(accountEmailPrivacy(win), before);
  dispatch(KEY, "true", "false");
  dispatch(KEY, "false", "true");
  assert.equal(accountEmailPrivacy(win).hide, true);
  assert.ok(accountEmailPrivacy(win).revision >= before.revision + 2);
  win.localStorage.clear();
  dispatch(null, null, null);
  assert.equal(accountEmailPrivacy(win).hide, false);
  unsubscribe();
});

test("blocked persistence keeps the current choice and reports it, without exposing a previously hidden value", () => {
  const win = browser();
  const storage = win.localStorage;
  setHideAccountEmails(true, win);
  Object.defineProperty(win, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  assert.equal(accountEmailPrivacy(win).hide, true);
  setHideAccountEmails(false, win);
  assert.deepEqual([accountEmailPrivacy(win).hide, accountEmailPrivacy(win).persistent], [false, false]);
  setHideAccountEmails(true, win);
  assert.equal(accountEmailPrivacy(win).hide, true);
  Object.defineProperty(win, "localStorage", { configurable: true, value: storage });
  setHideAccountEmails(false, win);
  assert.equal(accountEmailPrivacy(win).persistent, true);
  assert.equal(storage.getItem(KEY), "false");
});
