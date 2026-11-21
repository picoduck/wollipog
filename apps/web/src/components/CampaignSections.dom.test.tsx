import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { CampaignSection, CampaignSections, forgetCampaignSections } from "./CampaignSections.js";
const dom = new Window();
const prior = new Map<string, PropertyDescriptor | undefined>();
before(() => {
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
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
      <CampaignSection title="Summary" defaultOpen>Progress</CampaignSection>
      <CampaignSection title="Work Items" defaultOpen count={40}>Work</CampaignSection>
      <CampaignSection title="Decisions" count={30} attention={attention}>History</CampaignSection>
    </CampaignSections>));
  const disclosure = (title: string) => container.querySelector<HTMLButtonElement>(`[data-campaign-section="${title}"] h3 button`)!;
  await render();
  assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "true");
  assert.equal(disclosure("Summary").textContent, "Summary", "a section that is always one thing shows no count");
  assert.equal(disclosure("Work Items").getAttribute("aria-expanded"), "true");
  assert.equal(disclosure("Work Items").textContent, "Work Items · 40");
  assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "false");
  const click = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  await click("Expand All"); assert.equal(disclosure("Decisions").getAttribute("aria-expanded"), "true");
  await click("Collapse All"); assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "false");
  await act(async () => root.unmount()); root = createRoot(container); await render();
  assert.equal(disclosure("Summary").getAttribute("aria-expanded"), "false");
  const heading = container.querySelector<HTMLElement>('[data-campaign-section="Decisions"] h3')!;
  let scrolled = false; container.scrollTo = () => { scrolled = true; };
  await act(async () => { container.querySelector<HTMLButtonElement>(".campaign-section-trigger")!.click(); });
  await act(async () => { document.querySelector<HTMLButtonElement>('[role="menu"] [aria-label="Decisions, 30"]')!.click(); });
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

test("distinct requests can reach the same heading without replaying a handled request", async () => {
  const container = document.createElement("div"); container.className = "campaign-status"; document.body.append(container);
  container.scrollTo = () => {};
  const root = createRoot(container);
  let reached = 0;
  const render = async (targetKey: string, count: number) => act(async () => root.render(
    <CampaignSections campaignId="request-targets" targetTitle="Waiting for You" targetKey={targetKey} onTargetReached={() => { reached++; }}>
      <button type="button">Elsewhere</button>
      <CampaignSection title="Waiting for You" count={count}>Requests</CampaignSection>
    </CampaignSections>));
  await render("request-one", 1);
  assert.equal(reached, 1);
  assert.equal(document.activeElement, container.querySelector("h3"));
  const elsewhere = [...container.querySelectorAll("button")].find(button => button.textContent === "Elsewhere")!;
  elsewhere.focus();
  await render("request-one", 2);
  assert.equal(reached, 1);
  assert.equal(document.activeElement, elsewhere);
  await render("request-two", 2);
  assert.equal(reached, 2);
  assert.equal(document.activeElement, container.querySelector("h3"));
  await act(async () => root.unmount()); container.remove();
});

test("the one-row jump menu: contents, current section, attention chip and keyboard (#4781)", async () => {
  forgetCampaignSections();
  const container = document.createElement("div"); container.className = "campaign-status"; document.body.append(container);
  container.scrollTo = () => {};
  const root = createRoot(container);
  const render = async (decisions = "request-one", pause = "") => act(async () => root.render(
    <CampaignSections campaignId="jump-menu">
      <CampaignSection title="Summary" defaultOpen>Progress</CampaignSection>
      <CampaignSection title="Campaign Pause" attention={pause}>Pause</CampaignSection>
      <CampaignSection title="Work Items" defaultOpen count={40}>Work</CampaignSection>
      <CampaignSection title="Follow-Ups" count={0}>None</CampaignSection>
      <CampaignSection title="Decisions" count={30} attention={decisions}>History</CampaignSection>
    </CampaignSections>));
  await render();
  const trigger = container.querySelector<HTMLButtonElement>(".campaign-section-trigger")!;
  const nav = container.querySelector("nav")!;
  assert.equal(nav.getAttribute("aria-label"), "Campaign Sections");
  assert.equal(trigger.getAttribute("aria-label"), "Go to Section, Current Section: Summary");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.deepEqual([...nav.querySelectorAll(".campaign-section-tools button")].map(button =>
    [button.getAttribute("aria-label"), button.getAttribute("title")]), [["Collapse All", "Collapse All"], ["Expand All", "Expand All"]]);

  const chip = () => container.querySelector<HTMLButtonElement>(".campaign-section-attention");
  assert.equal(chip()!.textContent, "1 Needs Attention");
  await render("request-one", "paused-at");
  assert.equal(chip()!.textContent, "2 Need Attention");
  await render("", "");
  assertNoDomNode(chip(), "no chip when nothing needs the person");
  await render("request-two", "paused-again");

  // Opening lands on the current section; items are in panel order with counts and attention.
  await act(async () => trigger.click());
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-controls"), menu.id);
  assert.equal(menu.getAttribute("aria-label"), "Go to Section");
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  assert.deepEqual(items().map(item => item.getAttribute("aria-label")),
    ["Summary", "Campaign Pause, Needs Attention", "Work Items, 40", "Follow-Ups, 0", "Decisions, 30, Needs Attention"]);
  assert.deepEqual(items().map(item => item.querySelector(".menu-trail")?.textContent ?? ""), ["", "", "40", "0", "30"]);
  assert.deepEqual(items().map(item => Boolean(item.querySelector(".campaign-section-dot"))), [false, true, false, false, true]);
  assert.deepEqual(items().map(item => item.classList.contains("campaign-section-empty")), [false, false, false, true, false]);
  assert.equal(items()[0]!.getAttribute("aria-current"), "location");
  assert.equal(document.activeElement, items()[0]);

  // Arrow keys, End and Home move focus; Escape closes and returns focus to the button.
  const key = async (target: Element, value: string) => act(async () => {
    target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }) as unknown as Event);
  });
  await key(document.activeElement!, "ArrowDown"); assert.equal(document.activeElement, items()[1]);
  await key(document.activeElement!, "End"); assert.equal(document.activeElement, items()[4]);
  await key(document.activeElement!, "Home"); assert.equal(document.activeElement, items()[0]);
  await key(document.activeElement!, "Escape");
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  assertNoDomNode(document.querySelector('[role="menu"]'));
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  // Choosing an item closes the menu, opens the section, focuses its heading and names it.
  await key(trigger, "ArrowDown");
  assert.ok(document.querySelector('[role="menu"]'), "ArrowDown on the button opens the menu");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] [aria-label="Follow-Ups, 0"]')!.click());
  assertNoDomNode(document.querySelector('[role="menu"]'));
  assert.equal(container.querySelector('[data-campaign-section="Follow-Ups"] h3 button')!.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, container.querySelector('[data-campaign-section="Follow-Ups"] h3'));
  assert.equal(trigger.getAttribute("aria-label"), "Go to Section, Current Section: Follow-Ups");

  // The chip goes to the first section needing attention, in panel order.
  await act(async () => chip()!.click());
  assert.equal(document.activeElement, container.querySelector('[data-campaign-section="Campaign Pause"] h3'));
  assert.equal(trigger.getAttribute("aria-label"), "Go to Section, Current Section: Campaign Pause");

  // Scrolling away from where the jump left the panel hands the label to the heading under the index.
  const place = (element: Element, top: number) => {
    (element as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  };
  place(nav, 0); // the index's bottom edge is at 20px
  const tops: Record<string, number> = { "Summary": -400, "Campaign Pause": -200, "Work Items": 30, "Follow-Ups": 400, "Decisions": 600 };
  for (const [title, top] of Object.entries(tops)) place(container.querySelector(`[data-campaign-section="${title}"] h3`)!, top);
  const scrollTo = async (top: number) => act(async () => {
    Object.defineProperty(container, "scrollTop", { value: top, configurable: true, writable: true });
    container.dispatchEvent(new dom.Event("scroll") as unknown as Event);
  });
  await scrollTo(250);
  assert.equal(trigger.getAttribute("aria-label"), "Go to Section, Current Section: Work Items", "within 16px of the index counts as current");
  tops["Work Items"] = 80;
  place(container.querySelector('[data-campaign-section="Work Items"] h3')!, 80);
  await scrollTo(200);
  assert.equal(trigger.getAttribute("aria-label"), "Go to Section, Current Section: Campaign Pause");
  await act(async () => trigger.click());
  assert.equal(document.querySelector('[role="menu"] [aria-current="location"]')!.getAttribute("aria-label"), "Campaign Pause, Needs Attention");
  assert.equal(document.activeElement, document.querySelector('[role="menu"] [aria-current="location"]'));
  await key(document.activeElement!, "Escape");
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  await act(async () => root.unmount()); container.remove();
});
