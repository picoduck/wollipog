import { expect, test, type Page } from "@playwright/test";

const persisted = (page: Page) => page.evaluate(() => Object.keys(sessionStorage)
  .filter((key) => key.startsWith("wollipog:question-drafts:"))
  .map((key) => sessionStorage.getItem(key)).join("\n"));

async function chooseFirstTwo(page: Page, style: string) {
  await page.getByRole("radio", { name: "Staging", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(style === "composer" ? ".answer-step" : ".question-step-note")).toContainText("Question 2 of 5");
  await page.getByRole("checkbox", { name: "Unit Tests", exact: true }).click();
}

for (const style of ["interactive", "composer"]) {
  test(`${style} restores the same pending form's step and non-secret answers after an actual reload`, async ({ page }) => {
    await page.goto(`/agent-questions-e2e.html?set=forms&style=${style}`);
    await chooseFirstTwo(page, style);
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Unit Tests", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Staging", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Unit Tests", exact: true })).toBeChecked();
  });

  test(`${style} keeps secrets transient while preserving non-secret text and the current step`, async ({ page }) => {
    await page.goto(`/agent-questions-e2e.html?set=forms&style=${style}`);
    await chooseFirstTwo(page, style);
    await page.getByRole("checkbox", { name: "Browser Tests", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const input = page.locator(style === "composer" ? ".composer-answer-input" : ".question-input");
    await input.fill("Synthetic reload note");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await input.fill("fake-secret");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(input).toHaveValue("fake-secret");
    expect(await persisted(page)).not.toContain("fake-secret");
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fake-secret");
    await page.reload();
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveValue("");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(input).toHaveValue("Synthetic reload note");
  });

  test(`${style} does not inherit drafts across sessions, occurrences or schemas`, async ({ page }) => {
    const url = `/agent-questions-e2e.html?set=forms&style=${style}`;
    await page.goto(url);
    await chooseFirstTwo(page, style);
    await page.goto(`${url}&session=another-session`);
    await expect(page.getByRole("radio", { name: "Staging", exact: true })).not.toBeChecked();
    await page.goto(`${url}&epoch=replacement-occurrence`);
    await expect(page.getByRole("radio", { name: "Staging", exact: true })).not.toBeChecked();
    // The provider id and occurrence are the same, but a different schema cannot read the draft.
    await page.goto(`/agent-questions-e2e.html?set=rich&style=${style}`);
    await expect(page.getByRole("radio", { name: "Staging", exact: true })).not.toBeChecked();
  });

  for (const transition of ["completed", "replaced"] as const) {
    test(`${style} retires externally ${transition} drafts before a reload can reuse the provider id`, async ({ page }) => {
      const url = `/agent-questions-e2e.html?set=forms&style=${style}`;
      await page.goto(url);
      await chooseFirstTwo(page, style);
      await page.evaluate((action) => action === "completed" ? window.clearAgentQuestion() : window.replaceAgentQuestion(), transition);
      await expect.poll(() => persisted(page)).not.toContain("Staging");
      await page.goto(url);
      await expect(page.getByRole("radio", { name: "Staging", exact: true })).not.toBeChecked();
    });
  }

  test(`${style} ignores malformed and expired reload storage`, async ({ page }) => {
    const url = `/agent-questions-e2e.html?set=forms&style=${style}`;
    await page.goto(url);
    await chooseFirstTwo(page, style);
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage).filter((key) => key.startsWith("wollipog:question-drafts:"))) {
        const entries = JSON.parse(sessionStorage.getItem(key)!);
        entries[0].savedAt = 1;
        sessionStorage.setItem(key, JSON.stringify(entries));
      }
    });
    await page.reload();
    await expect(page.getByRole("radio", { name: "Staging", exact: true })).not.toBeChecked();
    await chooseFirstTwo(page, style);
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage).filter((key) => key.startsWith("wollipog:question-drafts:"))) {
        sessionStorage.setItem(key, "{invalid");
      }
    });
    await page.reload();
    await expect(page.getByRole("radio", { name: "Staging", exact: true })).not.toBeChecked();
  });
}
