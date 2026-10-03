import assert from "node:assert/strict";
import { act } from "react";

/** A message or turn action as a test reads it from its open menu. */
export interface TranscriptMenuItem {
  element: HTMLButtonElement;
  disabled: boolean;
  /** The visible second line the item's aria-describedby names: why it cannot be used now. */
  reason: string | null;
}

function menuTrigger(root: ParentNode, menu: string, index: number): HTMLButtonElement {
  const triggers = [...root.querySelectorAll<HTMLButtonElement>(`button[aria-label="${menu}"]`)];
  const trigger = triggers.at(index);
  assert.ok(trigger, `${menu} #${index} is rendered (found ${triggers.length})`);
  return trigger;
}

/** Opens the `index`th menu named `menu` (More Turn Actions or More Message Actions; negative counts
 * from the end) and reads the item named `label`, or null when the menu does not list it. The menu
 * is closed again before this returns. */
export async function readTranscriptAction(
  root: ParentNode,
  menu: string,
  label: string,
  index = 0,
): Promise<TranscriptMenuItem | null> {
  const trigger = menuTrigger(root, menu, index);
  await act(async () => { trigger.click(); });
  const surface = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  assert.ok(surface, `${menu} opens its menu`);
  const element = [...surface.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.dataset.menuLabel === label) ?? null;
  const result = element && {
    element,
    disabled: element.disabled,
    reason: (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "").join(" ") || null,
  };
  await act(async () => { trigger.click(); });
  return result;
}

/** Opens the menu and chooses the item named `label`, which must be available. */
export async function chooseTranscriptAction(root: ParentNode, menu: string, label: string, index = 0): Promise<void> {
  const trigger = menuTrigger(root, menu, index);
  await act(async () => { trigger.click(); });
  const surface = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  assert.ok(surface, `${menu} opens its menu`);
  const item = [...surface.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.dataset.menuLabel === label);
  assert.ok(item, `${menu} lists ${label}`);
  assert.equal(item.disabled, false, `${label} is available`);
  await act(async () => { item.click(); });
}
