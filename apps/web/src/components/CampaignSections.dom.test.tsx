import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { CampaignSection, CampaignSections, forgetCampaignSections } from "./CampaignSections.js";
const dom = new Window();
const prior = new Map<string, PropertyDescriptor | undefined>();
before(() => {
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: () => void) => { callback(); return 1; } })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});
after(() => { dom.close(); for (const [key, descriptor] of prior) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
} });

test("defaults, per-campaign memory, all controls, index focus and new attention", async () => {
  forgetCampaignSections();
  const container = document.createElement("div"); container.className = "campaign-status"; document.body.append(container);
  let root = createRoot(container);
  const render = async (attention = "", campaignId = "campaign-a") => act(async () => root.render(
    <CampaignSections campaignId={campaignId}>
      <CampaignSection title="Summary" defaultOpen count={1}>Progress</CampaignSection>
      <CampaignSection title="Work Items" defaultOpen count={40}>Work</CampaignSection>
      <CampaignSection title="Decisions" count={30} attention={attention}>History</CampaignSection>
    </CampaignSections>));
  const disclosure = (title: string) => container.querySelector<HTMLButtonElement>(`[data-campaign-section="${title}"] h3 button`)!;
  await render();
  assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "true");
  assert.equal(disclosure("Work Items").getAttribute("aria-expanded"), "true");
  assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "false");
  const click = async (label: string) => act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  await click("Expand All"); assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "true");
  await click("Collapse All"); assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "false");
  await act(async () => root.unmount()); root = createRoot(container); await render();
  assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "false");
  const heading = container.querySelector<HTMLElement>('[data-campaign-section="Decisions"] h3')!;
  let scrolled = false; container.scrollTo = () => { scrolled = true; };
  await act(async () => { container.querySelector<HTMLButtonElement>(".campaign-section-links button:last-child")!.click(); });
  assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "true");
  assert.equal(scrolled, true); assert.equal(dom.document.activeElement, heading);
  await act(async () => disclosure("Decisions").click());
  await render("request-one");
  assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "true");
  assert.match(disclosure("Decisions").textContent!, /Attention.*New/);
  await act(async () => disclosure("Decisions").click());
  await render(""); assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "false");
  await act(async () => root.unmount()); root = createRoot(container); await render("", "campaign-b");
  assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "true", "another campaign keeps its own defaults");
  await act(async () => root.unmount()); root = createRoot(container); await render("request-two");
  assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "false");
  assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "true", "attention gained while away also expands");
  assert.match(disclosure("Decisions").textContent!, /New/);
  await act(async () => root.unmount()); container.remove();
});
