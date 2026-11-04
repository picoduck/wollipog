import { LOCAL_INSTANCE_SCOPE, loadInstanceStorageValue, saveInstanceStorageValue } from "./instance-storage.js";

/**
 * People's Set Your Name notice (#3001). It shows while the control plane says your name is still the
 * default it gave you; Not Now hides it on this device only, for this person on this instance, so the
 * prompt still reaches you on your other devices until you save a name.
 */
const NOT_NOW_KEY = "wollipog.people.setYourName.notNow";

function notNowKey(userId: string): string {
  return `${NOT_NOW_KEY}:${userId}`;
}

export function setYourNameDismissed(userId: string, instanceScope = LOCAL_INSTANCE_SCOPE): boolean {
  return loadInstanceStorageValue(notNowKey(userId), instanceScope) === "1";
}

export function dismissSetYourName(userId: string, instanceScope = LOCAL_INSTANCE_SCOPE): void {
  saveInstanceStorageValue(notNowKey(userId), "1", instanceScope);
}
