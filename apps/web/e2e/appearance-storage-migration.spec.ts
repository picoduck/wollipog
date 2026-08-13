import { expect, test } from "@playwright/test";

test("legacy appearance is copied before first paint across all three axes", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mam.theme", "light");
    localStorage.setItem("mam.scheme", "dracula");
    localStorage.setItem("mam.density", "comfortable");
  });

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: document.documentElement.dataset.scheme,
    density: document.documentElement.dataset.density,
  }))).toEqual({ theme: "light", scheme: "dracula", density: "comfortable" });

  expect(await page.evaluate(() => ({
    theme: localStorage.getItem("wollipog.theme"),
    scheme: localStorage.getItem("wollipog.scheme"),
    density: localStorage.getItem("wollipog.density"),
    legacyTheme: localStorage.getItem("mam.theme"),
  }))).toEqual({ theme: "light", scheme: "dracula", density: "comfortable", legacyTheme: "light" });
});

test("Wollipog appearance values win conflicts before React hydrates", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wollipog.theme", "dark");
    localStorage.setItem("wollipog.scheme", "monokai");
    localStorage.setItem("wollipog.density", "compact");
    localStorage.setItem("mam.theme", "light");
    localStorage.setItem("mam.scheme", "dracula");
    localStorage.setItem("mam.density", "comfortable");
  });

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: document.documentElement.dataset.scheme,
    density: document.documentElement.dataset.density ?? null,
  }))).toEqual({ theme: "dark", scheme: "monokai", density: null });
});
