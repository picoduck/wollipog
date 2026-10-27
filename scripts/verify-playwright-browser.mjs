import { chromium, webkit } from "@playwright/test";

const browsers = { chromium, webkit };
const browserType = browsers[process.argv[2]];
if (!browserType) throw new Error("Expected chromium or webkit");
const browser = await browserType.launch();
await browser.close();
console.log(`Verified ${browserType.name()} launch before tests`);
