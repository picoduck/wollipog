import { expect, test } from "@playwright/test";

// All payloads are deliberately synthetic; no host service or account is contacted.
test("synthetic failure artifact interaction", async ({ page, context }) => {
  await context.addCookies([{ name: "synthetic-cookie", value: "SYNTHETIC_COOKIE_SENTINEL",
    domain: "synthetic.invalid", path: "/" }]);
  await context.setExtraHTTPHeaders({ Authorization: "Bearer SYNTHETIC_AUTH_SENTINEL" });
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `
    <html><body><button onclick="document.querySelector('output').textContent='Synthetic Complete'">Synthetic Button</button>
    <output>Synthetic Ready</output><p>SYNTHETIC_PROMPT_SENTINEL</p>
    <p>SYNTHETIC_TRANSCRIPT_SENTINEL SYNTHETIC_PERSONAL_SENTINEL</p>
    <a href="https://SYNTHETIC_PRIVATE_URL_SENTINEL.invalid/private">Synthetic Link</a>
    <input value="SYNTHETIC_SECRET_SENTINEL"></body></html>` }));
  await page.goto("https://synthetic.invalid/");
  await page.getByRole("button", { name: "Synthetic Button" }).click();
  await expect(page.locator("output")).toHaveText("Synthetic Complete");
  // Only the explicitly dispatched validation run fails. CI retries and flaky rules stay intact.
  expect(process.env.SYNTHETIC_ARTIFACT_FAILURE === "true",
    "SYNTHETIC_ERROR_SENTINEL: deliberately failing synthetic evidence validation").toBe(false);
});
