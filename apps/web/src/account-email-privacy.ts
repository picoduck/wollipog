import { useSyncExternalStore } from "react";

/** Device-wide account display preference. An absent or invalid saved choice means visible. */
export const HIDE_ACCOUNT_EMAILS_STORAGE_KEY = "wollipog.hide-account-emails";

export interface AccountEmailPrivacy {
  readonly hide: boolean;
  /** Mode transitions invalidate temporary reveals, including batched off/on changes. */
  readonly revision: number;
  readonly persistent: boolean;
}

const DEFAULT: AccountEmailPrivacy = { hide: false, revision: 0, persistent: true };
interface Store {
  snapshot: AccountEmailPrivacy;
  fallback: boolean | undefined;
  listeners: Set<() => void>;
  onStorage: ((event: StorageEvent) => void) | undefined;
}
const stores = new WeakMap<Window, Store>();

function update(store: Store, hide: boolean, persistent: boolean, reset = false): void {
  const previous = store.snapshot;
  const revision = previous.revision + (previous.hide !== hide || reset ? 1 : 0);
  if (previous.hide !== hide || previous.persistent !== persistent || previous.revision !== revision) {
    store.snapshot = { hide, revision, persistent };
  }
}

function refresh(win: Window, store: Store): AccountEmailPrivacy {
  if (store.fallback !== undefined) return store.snapshot;
  try {
    update(store, win.localStorage.getItem(HIDE_ACCOUNT_EMAILS_STORAGE_KEY) === "true", true);
  } catch {
    // Retain the last known mode if storage becomes unreadable; do not drop an active mask.
  }
  return store.snapshot;
}

function storeFor(win: Window): Store {
  let store = stores.get(win);
  if (!store) {
    store = { snapshot: DEFAULT, fallback: undefined, listeners: new Set(), onStorage: undefined };
    stores.set(win, store);
  }
  return store;
}

export function accountEmailPrivacy(win: Window = window): AccountEmailPrivacy {
  const store = storeFor(win);
  // Mounted readers share the announced snapshot instead of synchronously reading storage on
  // every streamed render. With no subscribers, re-read when a surface opens again.
  return store.listeners.size > 0 ? store.snapshot : refresh(win, store);
}

export function setHideAccountEmails(hide: boolean, win: Window = window): void {
  const store = storeFor(win);
  refresh(win, store);
  let persistent = true;
  try {
    win.localStorage.setItem(HIDE_ACCOUNT_EMAILS_STORAGE_KEY, String(hide));
    store.fallback = undefined;
  } catch {
    persistent = false;
    store.fallback = hide;
  }
  update(store, hide, persistent);
  for (const listener of store.listeners) listener();
}

export function subscribeAccountEmailPrivacy(listener: () => void, win: Window = window): () => void {
  const store = storeFor(win);
  if (store.listeners.size === 0) refresh(win, store);
  store.listeners.add(listener);
  if (!store.onStorage) {
    store.onStorage = (event) => {
      if (event.key !== null && event.key !== HIDE_ACCOUNT_EMAILS_STORAGE_KEY) return;
      try {
        if (event.storageArea && event.storageArea !== win.localStorage) return;
      } catch {
        return;
      }
      store.fallback = undefined;
      // Process each transition even if the final write already happened when events arrive.
      // Reading only the final boolean would let a reveal survive another tab's off/on cycle.
      update(store, event.key !== null && event.newValue === "true", true, event.oldValue !== event.newValue);
      refresh(win, store);
      for (const notify of store.listeners) notify();
    };
    win.addEventListener("storage", store.onStorage);
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0 && store.onStorage) {
      win.removeEventListener("storage", store.onStorage);
      store.onStorage = undefined;
    }
  };
}

export function useAccountEmailPrivacy(): AccountEmailPrivacy {
  return useSyncExternalStore(subscribeAccountEmailPrivacy, accountEmailPrivacy, () => DEFAULT);
}
