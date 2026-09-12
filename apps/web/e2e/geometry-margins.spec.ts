import { expect, test } from "@playwright/test";
import { expectGeometry, expectGeometryPoll, MINIMUM_GEOMETRY_HEADROOM } from "./geometry-margins.js";

test("geometry bounds require measured headroom and name a narrow margin", () => {
  expect(MINIMUM_GEOMETRY_HEADROOM).toBe(0.1);

  expectGeometry(90, "a generous lower bound").toBeGreaterThan(40);
  expectGeometry(0, "a containment tolerance").toBeLessThanOrEqual(0.5);

  expect(() => expectGeometry(42, "the branch keeps a safe share").toBeGreaterThan(40))
    .toThrow(/the branch keeps a safe share: geometry margin 2 is below 4 .*observed 42, bound 40/);
  expect(() => expectGeometry(87, "the card height has renderer headroom").toBeLessThanOrEqual(88))
    .toThrow(/geometry margin 1 is below 8\.8000 .*observed 87, bound 88/);
});

test("a polled geometry bound checks the sample that actually settled", async () => {
  let samples = 0;
  await expectGeometryPoll(() => {
    samples += 1;
    return 0;
  }, "the settled sample has headroom").toBeLessThanOrEqual(1);
  expect(samples).toBe(1);
});
