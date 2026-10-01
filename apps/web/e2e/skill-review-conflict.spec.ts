import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { choosePageAction } from "./page-actions.js";

// #2129: a review's accept carries back the deployment impact its preview reported. When the
// skill's assignments changed in between, the server refuses with a conflict: every review dialog
// replaces its consent with the conflict, keeps its primary disabled, and Preview Again reads a fresh
// preview whose consent names the current count.

const digest = "4f1c".padEnd(64, "0");
const observedDigest = "9b2e".padEnd(64, "0");
const library = "---\nname: code-review\n---\n\nAlways review the diff.\n";
const edited = `${library}Also check the tests before approving.\n`;
const skillFile = (content: string) => ({ path: "SKILL.md", encoding: "utf8", content });

/**
 * The fake server's previews and accepts: the first preview reports `first` assignments and the
 * first accept is refused as a conflict; every later preview reports `fresh`.
 */
function reviewServer(first: number, fresh: number) {
  const accepts: unknown[] = [];
  let previews = 0;
  return {
    accepts,
    impact() {
      previews++;
      return previews === 1
        ? { assignmentCount: first, deploymentImpact: "1".repeat(64) }
        : { assignmentCount: fresh, deploymentImpact: "2".repeat(64) };
    },
    async accept(route: Route, json: unknown) {
      accepts.push(route.request().postDataJSON());
      await (accepts.length === 1
        ? route.fulfill({ status: 409, json: { error: "Assignments for this skill changed. Preview it again.", code: "deployment_impact_changed" } })
        : route.fulfill({ json }));
    },
  };
}

type Server = ReturnType<typeof reviewServer>;
interface Review {
  title: string;
  /** Route the dialog's requests, then open it on its first preview. */
  open(page: Page, server: Server): Promise<Locator>;
  primary: string;
  /** The first preview's consent, or null when it reports no assignments. */
  consent: string | null;
  freshConsent: string;
  first: number;
  fresh: number;
}

const reviews: Review[] = [{
  title: "Import from Git",
  first: 0, fresh: 2, consent: null, freshConsent: "Deploy to 2 existing assignments", primary: "Import Selected",
  async open(page, server) {
    await page.route("**/api/skill-git/preview", (route) => route.fulfill({ json: { previewId: "preview-1", candidates: [{
      name: "code-review", path: "skills/code-review", commit: "a".repeat(40), digest: observedDigest,
      source: { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills" },
      files: [skillFile(edited)], previousFiles: [skillFile(library)], disposition: "update", executablePaths: [], ...server.impact(),
    }] } }));
    await page.route("**/api/skill-git/preview/*", (route) => route.fulfill({ status: 204 }));
    await page.route("**/api/skill-git/import", (route) => server.accept(route, { skill: { id: "skill-1", name: "code-review" } }));
    await page.goto("/skills-removals-e2e.html");
    await choosePageAction(page, "Import from Git…", "Import");
    const dialog = page.getByRole("dialog", { name: "Import Skills from Git" });
    await dialog.getByLabel("Git Repository", { exact: true }).fill("example/skills");
    await dialog.getByRole("button", { name: "Preview Skills" }).click();
    await dialog.getByRole("checkbox", { name: "code-review", exact: true }).check();
    return dialog;
  },
}, {
  title: "Import from Machine",
  first: 2, fresh: 3, consent: "Deploy to 2 existing assignments", freshConsent: "Deploy to 3 existing assignments", primary: "Import as New Version",
  async open(page, server) {
    const candidate = { id: "opaque", name: "code-review", sourceDirectory: ".codex/skills", generation: "generation" };
    await page.route("**/api/runners/*/skill-snapshots", (route) => route.fulfill({ json: { discoveryId: "discovery", candidates: [candidate] } }));
    await page.route("**/api/skill-machine/discovery/preview", (route) => route.fulfill({ json: {
      previewId: "preview-opaque", candidate, digest: observedDigest, disposition: "update",
      files: [skillFile(edited)], previousFiles: [skillFile(library)], ...server.impact(),
    } }));
    await page.route("**/api/skill-machine/discovery/import", (route) => server.accept(route, { skill: { id: "skill-1", name: "code-review" } }));
    await page.route("**/api/skill-machine/discovery", (route) => route.fulfill({ status: 204 }));
    await page.goto("/skills-removals-e2e.html");
    await choosePageAction(page, "Import from Machine…", "Import");
    const dialog = page.getByRole("dialog", { name: "Import from Machine" });
    await dialog.getByRole("group", { name: "Skill Folders" }).getByRole("button", { name: /^code-review/u }).click();
    return dialog;
  },
}, {
  title: "Import Edit as New Version",
  first: 2, fresh: 3, consent: "Deploy to 2 existing assignments", freshConsent: "Deploy to 3 existing assignments",
  primary: "Import as v4",
  async open(page, server) {
    const drift = { name: "code-review", digest, variant: "agent", observedDigest, held: true,
      detail: "Updates and removals for this skill are held until the edit is imported as a new version or the library version is restored." };
    await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: {
      removalReporting: "supported", driftReporting: "supported",
      desired: [{ name: "code-review", versionDigest: digest, targets: [{ agentId: "claude", invocation: "agent" }] }],
      reported: { deployed: [{ name: "code-review", digest, links: [{ agentId: "claude", status: "conflict" }] }], unmanaged: [], drift: [drift],
        updatedAt: 1_700_000_000_000 },
    } }));
    await page.route("**/api/runners/runner-1/skill-drift/preview", (route) => route.fulfill({ json: {
      previewId: "review-1", drift: { name: "code-review", digest, variant: "agent", observedDigest },
      files: [skillFile(edited)], previousFiles: [skillFile(library)], digest: observedDigest, importable: true,
      disposition: "update", publishedFromLatest: true, pinned: false, ...server.impact(),
    } }));
    await page.route("**/api/skill-drift/review-1/import", (route) => server.accept(route, { released: false, pinMoved: false }));
    await page.route("**/api/skill-drift/review-1", (route) => route.fulfill({ status: 204, body: "" }));
    await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: {
      versions: [{ id: "skillv_3", digest, createdAt: 1_700_000_000_000, versionNumber: 3 }], nextCursor: null,
    } }));
    await page.goto("/skills-removals-e2e.html?drift=1");
    await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
    await page.locator(".skill-notice-slot").getByRole("button", { name: "Review Edit…" }).click();
    return page.getByRole("dialog", { name: "Import Edit as New Version" });
  },
}, {
  title: "Import Orphaned Copy",
  first: 0, fresh: 2, consent: null, freshConsent: "Deploy to 2 existing assignments", primary: "Import as New Version",
  async open(page, server) {
    const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
    await page.route("**/api/runners/*/skills", (route) => route.fulfill({ json: {
      removalReporting: "supported", driftReporting: "supported", keptAsideReporting: "supported", desired: [],
      reported: { deployed: [], unmanaged: [], updatedAt: 1_700_000_000_000 },
      orphaned: route.request().url().includes("/runner-1/") ? [{ kind: "kept_aside", id, name: "code-review", digest, variant: "agent",
        keptAsideAt: 1_700_000_000_000, observedDigest, observedFingerprint: "7e1d".padEnd(64, "0"), skillId: "skill-1",
        detail: "A restore kept this edited copy aside in the skill store instead of deleting it." }] : [],
    } }));
    await page.route("**/api/runners/runner-1/orphaned-skill-copies/preview", (route) => route.fulfill({ json: {
      previewId: "review-1", copy: { kind: "kept_aside", id, observedDigest }, name: "code-review",
      files: [skillFile(edited)], previousFiles: [skillFile(library)], digest: observedDigest, importable: true, disposition: "update",
      ...server.impact(),
    } }));
    await page.route("**/api/orphaned-skill-copies/review-1/import", (route) => server.accept(route, { released: true }));
    await page.route("**/api/orphaned-skill-copies/review-1", (route) => route.fulfill({ status: 204, body: "" }));
    await page.goto("/skills-removals-e2e.html?orphans=1");
    await page.locator(".master-detail-list .row", { hasText: "Orphaned Copies" }).click();
    await page.getByRole("region", { name: "Orphaned Copies" }).locator("article", { hasText: "Build Machine" })
      .getByRole("button", { name: "Import…" }).first().click();
    return page.getByRole("dialog", { name: "Import Orphaned Copy" });
  },
}, {
  title: "Review Built-In Update",
  first: 2, fresh: 1, consent: "Deploy to 2 existing assignments", freshConsent: "Deploy to 1 existing assignment",
  primary: "Accept Built-In Update",
  async open(page, server) {
    await page.route("**/api/skills/skill-1/built-in-version", (route) => route.request().method() === "POST"
      ? server.accept(route, { skill: { id: "skill-1", name: "code-review" } })
      : route.fulfill({ json: {
        kind: "update", release: "1.1.0", digest: "e".repeat(64), files: [skillFile(edited)],
        currentVersion: { id: "v1", digest: "d1", files: [skillFile(library)] }, expectedLatestVersionId: "v1",
        gitAutoUpdate: false, ...server.impact(),
      } }));
    await page.goto("/skills-removals-e2e.html?builtIn=1");
    await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
    await page.locator(".skill-notice-slot").getByRole("button", { name: "Review Update…" }).click();
    return page.getByRole("dialog", { name: "Review Built-In Update" });
  },
}, {
  title: "Version History",
  first: 2, fresh: 3, consent: "Deploy to machines that track the latest version",
  freshConsent: "Deploy to machines that track the latest version", primary: "Restore Version",
  async open(page, server) {
    const historical = { id: "v0", digest: "b".repeat(64), createdAt: 1_700_000_000_000, note: "Initial reviewed version", files: [skillFile(library)] };
    const current = { id: "v1", digest: "a".repeat(64), files: [skillFile(edited)] };
    await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: [historical], nextCursor: null } }));
    await page.route("**/api/skills/skill-1/versions/v0", (route) => {
      const { deploymentImpact } = server.impact();
      return route.fulfill({ json: { version: historical, currentVersion: current, deploymentImpact } });
    });
    await page.route("**/api/skills/skill-1/restore", (route) => server.accept(route, { version: { ...historical, id: "v2" } }));
    await page.goto("/skills-removals-e2e.html");
    await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
    await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
    await page.getByRole("menuitem", { name: "Version History…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Version History" });
    await dialog.getByRole("button", { name: "Preview Version v0", exact: true }).click();
    return dialog;
  },
}];

const slug = (title: string) => title.toLowerCase().replace(/[^a-z]+/gu, "-");

for (const review of reviews) for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of ["dark", "light"]) {
  test(`${review.title} shows a changed-assignments conflict and previews again at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const server = reviewServer(review.first, review.fresh);
    const dialog = await review.open(page, server);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const foot = dialog.locator(".modal-foot");
    const primary = foot.getByRole("button", { name: review.primary, exact: true });
    if (review.consent === null) {
      await expect(foot.getByRole("checkbox")).toHaveCount(0);
      await expect(primary).toBeEnabled();
    } else {
      await foot.getByRole("checkbox", { name: review.consent, exact: true }).check();
    }
    await primary.click();

    // The conflict takes the consent's slot; nothing stale can be accepted.
    const conflict = foot.locator(".review-conflict");
    await expect(conflict).toHaveAttribute("role", "alert");
    await expect(conflict).toHaveText(/Assignments for (this skill|code-review) changed after the preview, so it wasn't deployed\.\s*Preview Again/u);
    await expect(foot.getByRole("checkbox")).toHaveCount(0);
    await expect(primary).toBeDisabled();
    await expect(dialog.locator(".form-error")).toHaveCount(0);
    const previewAgain = conflict.getByRole("button", { name: "Preview Again", exact: true });
    await expect(previewAgain).toBeEnabled();
    const layout = await foot.evaluate((element) => {
      const box = (node: Element) => node.getBoundingClientRect();
      const notice = element.querySelector(".review-conflict")!;
      const button = notice.querySelector("button")!;
      const style = getComputedStyle(element);
      const buttons = [...element.querySelectorAll(":scope > .btn")];
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        inside: box(notice).left >= box(element).left - 0.5 && box(notice).right <= box(element).right + 0.5,
        buttonVisible: box(button).bottom <= innerHeight && box(button).right <= innerWidth,
        rowWidth: box(notice).width,
        footWidth: box(element).width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
        // On a phone the conflict is its own row above Cancel and the primary; wider, it shares their row.
        above: box(notice).bottom <= Math.min(...buttons.map((node) => box(node).top)) + 0.5,
        oneRow: Math.max(...buttons.map((node) => box(node).top)) - Math.min(...buttons.map((node) => box(node).top)) < 1 &&
          box(notice).top < Math.min(...buttons.map((node) => box(node).bottom)),
      };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.inside).toBe(true);
    expect(layout.buttonVisible).toBe(true);
    if (width < 760) {
      expect(layout.rowWidth).toBeGreaterThanOrEqual(layout.footWidth - 1);
      expect(layout.above).toBe(true);
    } else {
      expect(layout.oneRow).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`${slug(review.title)}-conflict-${width}-${theme}.png`) });

    // A fresh preview's consent names the current count, and accepting it carries the fresh impact.
    await previewAgain.click();
    await expect(conflict).toHaveCount(0);
    const fresh = foot.getByRole("checkbox", { name: review.freshConsent, exact: true });
    await expect(fresh).not.toBeChecked();
    await expect(primary).toBeDisabled();
    await fresh.check();
    await primary.click();
    await expect.poll(() => server.accepts.length).toBe(2);
    expect(server.accepts.map((body) => (body as { expectedDeploymentImpact?: string }).expectedDeploymentImpact))
      .toEqual(["1".repeat(64), "2".repeat(64)]);
  });
}
