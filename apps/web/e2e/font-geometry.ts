import { expect, type Locator, type Page } from "@playwright/test";

export interface WideFaceCandidate {
  family: string;
  installPackage: string;
}

export interface PinWidestFaceOptions {
  candidates?: readonly WideFaceCandidate[];
  probeText?: string;
}

const DEFAULT_CANDIDATES = [
  { family: "DejaVu Sans", installPackage: "fonts-dejavu-core" },
  { family: "Liberation Sans", installPackage: "fonts-liberation" },
] as const satisfies readonly WideFaceCandidate[];

/**
 * Pin the widest verified candidate face on `scope` and every descendant.
 *
 * Asking the browser for an absent family silently falls back, so each candidate is measured
 * against a deliberately absent family before it is trusted. Of the faces that resolve, the one
 * with the widest probe is used and returned for assertion messages.
 */
export async function pinWidestFace(
  page: Page,
  scope: Locator,
  options: PinWidestFaceOptions = {},
): Promise<string> {
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const probeText = options.probeText ?? "Claude Code · Wollipog";

  const result = await page.evaluate(({ candidateFamilies, text }) => {
    const widthIn = (family: string) => {
      const probe = document.createElement("span");
      probe.textContent = text;
      probe.style.cssText =
        `position:absolute;visibility:hidden;white-space:nowrap;font-size:12px;font-family:${family}`;
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };

    const absentWidth = widthIn('"a face no machine has, 8f3c1"');
    return candidateFamilies
      .map((family) => ({ family, width: widthIn(JSON.stringify(family)) }))
      .filter(({ width }) => Math.abs(width - absentWidth) > 0.01)
      .sort((left, right) => right.width - left.width)[0] ?? null;
  }, { candidateFamilies: candidates.map(({ family }) => family), text: probeText });

  const installPackages = [...new Set(candidates.map(({ installPackage }) => installPackage))];
  expect(
    result,
    `no verified wide face to measure: install ${installPackages.join(" or ")}`,
  ).not.toBeNull();

  const matchCount = await scope.count();
  expect(matchCount, "the wide-face scope must match at least one element").toBeGreaterThan(0);

  const face = result!.family;
  await scope.evaluateAll((elements) => {
    for (const element of elements) element.setAttribute("data-e2e-wide-face", "");
  });
  await page.addStyleTag({
    content: `[data-e2e-wide-face], [data-e2e-wide-face] * { font-family: ${JSON.stringify(face)} !important; }`,
  });
  return face;
}
