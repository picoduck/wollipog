import { expect, type Locator, type Page } from "@playwright/test";

/** Measurements of a rail item's attention mark (#1967), shared by the desktop rail specs. */

/**
 * How many device pixels of an item's glyph lie under its attention mark and the mark's 2px ring
 * (#1967). The mark's box, grown by the ring, is captured with the mark lifted out and again with
 * the glyph lifted out too; every position that differs is the glyph's stroke, antialiasing
 * included. The two captures differ in nothing else, so a backdrop cancels.
 */
export async function glyphUnderMark(page: Page, item: Locator): Promise<number> {
  const mark = item.locator(".count-badge, .rail-attention-dot");
  await expect(mark).toHaveCount(1);
  const clip = await mark.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 };
  });
  const lift = (target: Locator, lifted: boolean) =>
    target.evaluate((element, hide) => { (element as HTMLElement).style.opacity = hide ? "0" : ""; }, lifted);
  const glyph = item.locator("svg");
  await lift(mark, true);
  const withGlyph = await page.screenshot({ clip, animations: "disabled" });
  await lift(glyph, true);
  const without = await page.screenshot({ clip, animations: "disabled" });
  await lift(glyph, false);
  await lift(mark, false);
  return page.evaluate(async ([a, b]) => {
    const load = async (png: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return canvas.getContext("2d")!.getImageData(0, 0, image.width, image.height).data;
    };
    const [front, back] = [await load(a!), await load(b!)];
    let stroke = 0;
    for (let index = 0; index < front.length; index += 4) {
      const delta = Math.max(...[0, 1, 2].map((channel) => Math.abs(front[index + channel]! - back[index + channel]!)));
      if (delta > 4) stroke += 1;
    }
    return stroke;
  }, [withGlyph.toString("base64"), without.toString("base64")]);
}

/** The ring an on-icon mark draws, and the fill of the item it sits on. */
export async function ringAndFill(item: Locator) {
  return item.evaluate((element) => {
    const mark = element.querySelector(".count-badge, .rail-attention-dot")!;
    const probe = document.createElement("span");
    probe.style.background = getComputedStyle(element).backgroundColor;
    document.body.append(probe);
    const opaqueFill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      ring: getComputedStyle(mark).boxShadow,
      fill: opaqueFill === "rgba(0, 0, 0, 0)" ? getComputedStyle(element.closest(".app-rail")!).backgroundColor : opaqueFill,
    };
  });
}
