import { devices, expect, test, type Locator, type Page } from "@playwright/test";

const FIXTURE = "/people-devices-e2e.html";
const OWNER = "owner@example.com";
const NEXT_OWNER = "next.owner@example.net";
const MEMBER = "pat@example.org";
const RENAMED_MEMBER = "pat.renamed@example.org";
const EMAILS = [OWNER, NEXT_OWNER, MEMBER, RENAMED_MEMBER] as const;

type LeakWatchWindow = typeof window & { takeIdentifierLeaks?: () => string[] };

function occurrences(markup: string, value: string): number {
  return markup.split(value).length - 1;
}

/** Every identifier absent from the whole document — head, text and attributes — except `revealed`, once each. */
async function expectOnlyRevealed(page: Page, ...revealed: string[]): Promise<void> {
  const markup = await page.evaluate(() => document.documentElement.outerHTML);
  for (const email of EMAILS) {
    expect(occurrences(markup, email), email).toBe(revealed.includes(email) ? 1 : 0);
  }
}

async function expectNoEmailLeak(page: Page): Promise<void> {
  await expectOnlyRevealed(page);
}

/**
 * Record every point at which an identifier reaches the DOM that the person did not reveal.
 *
 * Identifiers already on the page when the watch starts are the deliberate reveals; they may stay
 * or go, but may not be added again or multiply. Everything else is a leak the moment it appears:
 * in an added subtree's text or any of its attributes (accessible names, tooltips, data
 * attributes, synced input values), in changed text, or in a changed attribute. Old values are recorded
 * too, so a value written and then overwritten before the observer runs is still caught, and so are
 * removed subtrees, which is where a value inserted and then detached in the same task survives.
 * Together those cover every value the DOM held: the observer keeps recording changes to a detached
 * subtree until its callback runs, so anything no longer in an added node was either overwritten
 * (an old value) or removed (a removed node). Only the exact text node or attribute that held a
 * reveal when the watch started may report it: removed with its original value, or as an old
 * value once. A revealed identifier written anywhere else, even briefly, is a leak.
 */
async function watchIdentifierLeaks(page: Page): Promise<void> {
  await page.evaluate((identifiers) => {
    const count = (markup: string, value: string) => markup.split(value).length - 1;
    const baseline = new Map(identifiers.map((id) => [id, count(document.documentElement.outerHTML, id)]));
    const holds = (value: string | null | undefined) => identifiers.some((id) => value?.includes(id));
    const TEXT = "#text";
    const origins = new Map<Node, Map<string, string>>();
    const eachNode = (root: Node, visit: (node: Node) => void) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) visit(node);
    };
    /** Each text value (`#text`) or attribute value on `node`. */
    const valuesOf = (node: Node): Array<[string, string]> => node instanceof Element
      ? [...node.attributes].map((attribute) => [attribute.name, attribute.value])
      : node.nodeType === Node.TEXT_NODE ? [[TEXT, node.textContent ?? ""]] : [];
    eachNode(document.documentElement, (node) => {
      for (const [slot, value] of valuesOf(node)) {
        if (holds(value)) origins.set(node, (origins.get(node) ?? new Map<string, string>()).set(slot, value));
      }
    });
    const spentGrants = new Map<Node, Set<string>>();
    const leaks: string[] = [];
    const check = (where: string, value: string | null | undefined, granted = "") => {
      for (const id of identifiers) {
        if (value?.includes(id) && !granted.includes(id)) leaks.push(`${where}: ${id}`);
      }
    };
    /** The value a reveal granted this exact origin at the start, handed out once. */
    const takeGrant = (node: Node, slot: string): string => {
      const spent = spentGrants.get(node) ?? new Set<string>();
      if (spent.has(slot)) return "";
      spentGrants.set(node, spent.add(slot));
      return origins.get(node)?.get(slot) ?? "";
    };
    const checkRemoved = (root: Node) => eachNode(root, (node) => {
      for (const [slot, value] of valuesOf(node)) {
        if (origins.get(node)?.get(slot) !== value) check(`removed ${node.nodeName} ${slot}`, value);
      }
    });
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const node of record.addedNodes) {
            check(`added ${node.nodeName}`, node instanceof Element ? node.outerHTML : node.textContent);
          }
          for (const node of record.removedNodes) checkRemoved(node);
        } else if (record.type === "characterData") {
          check("changed text", record.target.textContent);
          check("replaced text", record.oldValue, takeGrant(record.target, TEXT));
        } else if (record.type === "attributes" && record.target instanceof Element && record.attributeName) {
          check(`changed ${record.attributeName}`, record.target.getAttribute(record.attributeName));
          check(`replaced ${record.attributeName}`, record.oldValue, takeGrant(record.target, record.attributeName));
        }
      }
      const markup = document.documentElement.outerHTML;
      for (const id of identifiers) {
        if (count(markup, id) > baseline.get(id)!) leaks.push(`rendered: ${id}`);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
    });
    (window as LeakWatchWindow).takeIdentifierLeaks = () => {
      observer.disconnect();
      return leaks;
    };
  }, [...EMAILS]);
}

async function takeIdentifierLeaks(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => (window as LeakWatchWindow).takeIdentifierLeaks?.());
}

async function renameEveryone(page: Page): Promise<void> {
  await page.evaluate(() => window.__WOLLIPOG_PEOPLE_DEVICES_E2E__.renameEveryone());
}

async function identityRequests(page: Page): Promise<number> {
  return page.evaluate(() => window.__WOLLIPOG_PEOPLE_DEVICES_E2E__.identityRequests());
}

/** Open the fixture on the People and Devices tab and wait for the panel's own refresh to settle. */
async function openPeopleDevices(page: Page): Promise<void> {
  await page.goto(FIXTURE);
  await expect(page.getByRole("tab", { name: "People and Devices" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Paired Devices" }).getByText("Pat's Phone")).toBeVisible();
}

/** Leave People and Devices for Machines through the production tabs, then come back. */
async function leaveAndReturn(page: Page, via: "pointer" | "keyboard", whileAway?: () => Promise<void>) {
  const machinesTab = page.getByRole("tab", { name: "Machines" });
  const peopleTab = page.getByRole("tab", { name: "People and Devices" });
  if (via === "keyboard") {
    await peopleTab.focus();
    await page.keyboard.press("ArrowLeft");
  } else {
    await machinesTab.click();
  }
  await expect(machinesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: /Machines/ })).toBeVisible();
  await expectNoEmailLeak(page);
  await whileAway?.();
  if (via === "keyboard") {
    await machinesTab.focus();
    await page.keyboard.press("ArrowRight");
  } else {
    await peopleTab.click();
  }
  await expect(peopleTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#people-heading")).toBeVisible();
  await expect(page.getByRole("region", { name: "Paired Devices" }).getByText("Pat's Phone")).toBeVisible();
}

/** Your own row: it says "You" (#2997), and its name is masked like everyone else's. */
const ownRow = (page: Page) => page.getByRole("region", { name: "People" }).locator(".access-row").filter({ hasText: "You" });

/** Open a row through its one open target, which every row that opens something has on desktop and phone. */
async function openRow(row: Locator): Promise<void> {
  await row.locator(".access-row-open").click();
}

test("the identifier observer records transient disclosures that leave no trace in the final markup (#1816)", async ({ page }) => {
  await openPeopleDevices(page);
  const own = ownRow(page);
  await own.getByRole("button", { name: "Show Person Name" }).click();
  await expect(own).toContainText(OWNER);

  await watchIdentifierLeaks(page);
  await page.evaluate(([owner, member]) => {
    // Written and cleared in one task, so the observer only ever sees the final, clean values.
    const tab = document.getElementById("connections-people-tab")!;
    tab.setAttribute("aria-label", owner!);
    tab.removeAttribute("aria-label");
    const heading = document.getElementById("people-heading")!.firstChild!;
    const original = heading.textContent!;
    heading.textContent = member!;
    heading.textContent = original;
    // Inserted, detached, then emptied: the value survives only in the later record's removed nodes.
    const inserted = document.createElement("span");
    inserted.textContent = member!;
    document.getElementById("people-heading")!.append(inserted);
    inserted.remove();
    inserted.textContent = "";
  }, [OWNER, MEMBER]);
  await expectOnlyRevealed(page, OWNER);
  expect(await takeIdentifierLeaks(page)).toEqual([
    `replaced aria-label: ${OWNER}`,
    `replaced text: ${MEMBER}`,
    `removed #text #text: ${MEMBER}`,
  ]);

  // The node granted the reveal may drop it once; writing it back and away again is a new disclosure.
  await watchIdentifierLeaks(page);
  await page.evaluate((owner) => {
    const revealed = [...document.querySelectorAll(".access-row")]
      .find((row) => row.textContent?.includes("You"))!.querySelector(".pid-value")!.firstChild!;
    revealed.textContent = "Hidden";
    revealed.textContent = owner;
    revealed.textContent = "Hidden";
  }, OWNER);
  expect(await takeIdentifierLeaks(page)).toEqual([`replaced text: ${OWNER}`]);

  // The document head is watched too: a window title is as visible as the page.
  await watchIdentifierLeaks(page);
  await page.evaluate((identifier) => {
    const original = document.title;
    document.title = identifier;
    document.title = original;
  }, NEXT_OWNER);
  expect(await takeIdentifierLeaks(page)).toEqual([`added #text: ${NEXT_OWNER}`, `removed #text #text: ${NEXT_OWNER}`]);
});

for (const formFactor of ["desktop", "phone"] as const) {
  test.describe(formFactor, () => {
    const phone = devices["Pixel 7"];
    test.use(formFactor === "phone" ? {
      viewport: phone.viewport,
      hasTouch: phone.hasTouch,
      isMobile: phone.isMobile,
      userAgent: phone.userAgent,
      deviceScaleFactor: phone.deviceScaleFactor,
      screen: phone.screen,
    } : { viewport: { width: 1280, height: 900 } });

  test(`People and Devices masks names across rendered ${formFactor} surfaces until reveal (#1667)`, async ({ page }) => {
    await page.goto(FIXTURE);
    await expect(page.getByRole("heading", { name: /^People/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Paired Devices/ })).toBeVisible();
    await expectNoEmailLeak(page);

    const own = ownRow(page);
    const people = page.getByRole("region", { name: "People" });
    const devices = page.getByRole("region", { name: "Paired Devices" });
    const teams = page.getByRole("region", { name: "Teams" });
    const ownReveal = own.getByRole("button", { name: "Show Person Name" });
    await expect(ownReveal).toHaveAttribute("title", "Show Person Name");
    await ownReveal.click();
    await expect(own).toContainText(OWNER);
    await expectOnlyRevealed(page, OWNER);
    await own.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);

    const memberRow = people.locator(".access-row").last();
    const personReveal = memberRow.getByRole("button", { name: "Show Person Name" });
    await expect(personReveal).toHaveAttribute("title", "Show Person Name");
    await personReveal.click();
    await expect(memberRow).toContainText(MEMBER);
    await expect(devices).not.toContainText(MEMBER);
    await expect(teams).not.toContainText(MEMBER);
    await memberRow.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);

    const deviceReveal = devices.getByRole("button", { name: "Show Person Name" });
    await expect(deviceReveal).toHaveAttribute("title", "Show Person Name");
    await deviceReveal.click();
    await expect(devices).toContainText(MEMBER);
    await devices.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);

    // A team row's line 2 masks its members as the People rows do (#2997).
    const teamRow = teams.locator(".access-row").first();
    await expect(teamRow).toContainText("1 member: Email Hidden");
    await teamRow.getByRole("button", { name: "Show Member Name" }).click();
    await expect(teamRow).toContainText(MEMBER);
    await expectOnlyRevealed(page, MEMBER);
    await teamRow.getByRole("button", { name: "Hide Member Name" }).click();
    await expectNoEmailLeak(page);

    // Device Details and its Revoke Device confirmation keep the person masked until revealed.
    await openRow(devices.locator(".access-row").first());
    let dialog = page.getByRole("dialog", { name: "Pat's Phone" });
    await expect(dialog.getByText("Access Level")).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Name" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Hide Person Name" }).click();
    await dialog.getByRole("button", { name: "Revoke Device…" }).click();
    const confirmation = page.getByRole("dialog", { name: "Revoke Device" });
    await expect(confirmation).toContainText("“Pat's Phone” stops working for");
    await expectNoEmailLeak(page);
    await confirmation.getByRole("button", { name: "Show Person Name" }).click();
    await expect(confirmation).toContainText(MEMBER);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expectNoEmailLeak(page);

    await openRow(memberRow);
    dialog = page.getByRole("dialog", { name: "Manage Person" });
    await expect(dialog).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Name", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(MEMBER);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await openRow(memberRow);
    dialog = page.getByRole("dialog", { name: "Manage Person" });
    await expect(dialog.getByRole("button", { name: "Show Name", exact: true })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Pair Device…" }).click();
    dialog = page.getByRole("dialog", { name: "Pair Device" });
    await expect(dialog).toContainText("Step 1 of 2: Choose who it's for.");
    await expect(dialog.getByRole("radiogroup", { name: "Person" }).getByRole("radio")).toHaveCount(2);
    await expect(dialog.getByRole("radio", { name: /Hidden Name 1/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Hidden Name 2/ })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Names" }).click();
    await expect(dialog).toContainText(OWNER);
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("radio", { name: /pat@example\.org/ }).check();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog).toContainText("Step 2 of 2: Name the device.");
    await expect(dialog.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Name" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);
    await dialog.getByRole("textbox", { name: "Device Name" }).fill("Pat's Tablet");
    await dialog.getByRole("button", { name: "Create Pairing Link" }).click();
    await expect(dialog).toContainText("Pat's Tablet is ready to pair for");
    await expect(dialog.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Name" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Pair Device…" }).click();
    dialog = page.getByRole("dialog", { name: "Pair Device" });
    await expect(dialog.getByRole("button", { name: "Show Names" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await openRow(teamRow);
    dialog = page.getByRole("dialog", { name: "Manage Team" });
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 1/ })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 2/ })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Names" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Create Team…" }).click();
    dialog = page.getByRole("dialog", { name: "Create Team" });
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 1/ })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 2/ })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Names" }).click();
    await expect(dialog).toContainText(OWNER);
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Create Team…" }).click();
    dialog = page.getByRole("dialog", { name: "Create Team" });
    await expect(dialog.getByRole("button", { name: "Show Names" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test(`returning to People and Devices through the Connections tabs starts masked on ${formFactor} (#1816)`, async ({ page }) => {
    await openPeopleDevices(page);
    await expectNoEmailLeak(page);
    const own = ownRow(page);
    const memberRow = page.getByRole("region", { name: "People" }).locator(".access-row").last();
    const deviceRow = page.getByRole("region", { name: "Paired Devices" }).locator(".access-row").first();
    const surfaces = [
      { name: "your own row", scope: own, value: OWNER },
      { name: "person row", scope: memberRow, value: MEMBER },
      { name: "device row", scope: deviceRow, value: MEMBER },
    ];
    for (const [index, surface] of surfaces.entries()) {
      await test.step(`${surface.name} is masked again after a tab round trip`, async () => {
        await surface.scope.getByRole("button", { name: "Show Person Name" }).click();
        await expect(surface.scope).toContainText(surface.value);
        await expectOnlyRevealed(page, surface.value);
        await watchIdentifierLeaks(page);
        // Phones switch tabs by tapping; desktop also covers the roving arrow keys of the tablist.
        await leaveAndReturn(page, formFactor === "desktop" && index === 1 ? "keyboard" : "pointer");
        await expect(surface.scope.getByRole("button", { name: "Show Person Name" })).toBeVisible();
        await expectNoEmailLeak(page);
        expect(await takeIdentifierLeaks(page)).toEqual([]);
      });
    }

    await test.step("an identity renamed while away arrives masked", async () => {
      await own.getByRole("button", { name: "Show Person Name" }).click();
      await memberRow.getByRole("button", { name: "Show Person Name" }).click();
      await expectOnlyRevealed(page, OWNER, MEMBER);
      await watchIdentifierLeaks(page);
      const requestsBefore = await identityRequests(page);
      // RunnersView still holds the old identity when the panel remounts, then the panel's refresh
      // replaces it: both states must render masked.
      await leaveAndReturn(page, "pointer", () => renameEveryone(page));
      expect(await identityRequests(page)).toBeGreaterThan(requestsBefore);
      await expect(own.getByRole("button", { name: "Show Person Name" })).toBeVisible();
      await expect(memberRow.getByRole("button", { name: "Show Person Name" })).toBeVisible();
      await expect(deviceRow.getByRole("button", { name: "Show Person Name" })).toBeVisible();
      await expectNoEmailLeak(page);
      expect(await takeIdentifierLeaks(page)).toEqual([]);
    });

    await test.step("a deliberate reveal shows only the chosen identifier", async () => {
      await own.getByRole("button", { name: "Show Person Name" }).click();
      await expect(own).toContainText(NEXT_OWNER);
      await expectOnlyRevealed(page, NEXT_OWNER);
      await own.getByRole("button", { name: "Hide Person Name" }).click();
      await deviceRow.getByRole("button", { name: "Show Person Name" }).click();
      await expect(deviceRow).toContainText(RENAMED_MEMBER);
      await expectOnlyRevealed(page, RENAMED_MEMBER);
    });
  });

  test(`an identity change remasks revealed names without transient disclosure on ${formFactor} (#1816)`, async ({ page }) => {
    await openPeopleDevices(page);
    const own = ownRow(page);
    const people = page.getByRole("region", { name: "People" });
    const memberRow = people.locator(".access-row").last();
    const deviceRow = page.getByRole("region", { name: "Paired Devices" }).locator(".access-row").first();
    await own.getByRole("button", { name: "Show Person Name" }).click();
    await memberRow.getByRole("button", { name: "Show Person Name" }).click();
    await expect(own).toContainText(OWNER);
    await expect(memberRow).toContainText(MEMBER);
    await expectOnlyRevealed(page, OWNER, MEMBER);

    await watchIdentifierLeaks(page);
    await renameEveryone(page);
    // Saving a team refreshes the identity through RunnersView's onIdentityChange while the panel,
    // and the reveal state of each name in it, stays mounted.
    const requestsBefore = await identityRequests(page);
    await openRow(page.getByRole("region", { name: "Teams" }).locator(".access-row").first());
    const dialog = page.getByRole("dialog", { name: "Manage Team" });
    // Save Changes sends nothing when nothing changed, so the team is renamed to make it save (#3000).
    await dialog.getByRole("textbox", { name: "Team Name" }).fill("Support Desk");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await identityRequests(page)).toBeGreaterThan(requestsBefore);
    await expect(own.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expect(memberRow.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    expect(await takeIdentifierLeaks(page)).toEqual([]);

    await own.getByRole("button", { name: "Show Person Name" }).click();
    await expect(own).toContainText(NEXT_OWNER);
    await expectOnlyRevealed(page, NEXT_OWNER);
    await memberRow.getByRole("button", { name: "Show Person Name" }).click();
    await expect(memberRow).toContainText(RENAMED_MEMBER);
    await expect(deviceRow.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectOnlyRevealed(page, NEXT_OWNER, RENAMED_MEMBER);

    // The reveal is bound to the tab visit as well as the value.
    await watchIdentifierLeaks(page);
    await leaveAndReturn(page, "pointer");
    await expect(own.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expect(memberRow.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    expect(await takeIdentifierLeaks(page)).toEqual([]);
  });
  });
}
