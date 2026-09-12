import { expect } from "@playwright/test";

/** #931 had only about 5% headroom; 10% rejects it while preserving the audited suite. */
export const MINIMUM_GEOMETRY_HEADROOM = 0.1;

type Direction = "above" | "below";

const finite = (value: number, label: string): void => {
  expect(Number.isFinite(value), `${label} must be a finite number; received ${value}`).toBe(true);
};

const describe = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(4);
const requiredHeadroom = (bound: number): number =>
  Math.max(Math.abs(bound), 1) * MINIMUM_GEOMETRY_HEADROOM;

function assertHeadroom(observed: number, bound: number, direction: Direction, reason: string): void {
  finite(observed, "observed geometry");
  finite(bound, "geometry bound");
  expect(reason.trim().length, "a geometry assertion must state why the bound is safe").toBeGreaterThan(0);

  const margin = direction === "above" ? observed - bound : bound - observed;
  const scale = Math.max(Math.abs(bound), 1);
  const required = requiredHeadroom(bound);
  const marginRatio = margin / scale;
  const report = {
    reason,
    observed,
    bound,
    margin,
    required,
    headroomPercent: marginRatio * 100,
  };
  if (process.env.GEOMETRY_MARGIN_REPORT === "1") {
    console.log(`GEOMETRY_MARGIN ${JSON.stringify(report)}`);
  }

  expect(
    margin,
    `${reason}: geometry margin ${describe(margin)} is below ${describe(required)} `
      + `(${MINIMUM_GEOMETRY_HEADROOM * 100}% headroom); observed ${describe(observed)}, `
      + `bound ${describe(bound)}`,
  ).toBeGreaterThanOrEqual(required);
}

/**
 * Assert a numeric geometry bound and separately require enough measured headroom to survive a
 * different renderer. Express coordinates as a delta first, so the bound describes the quantity
 * whose margin matters: overflow past an edge, distance between elements, or change in size.
 */
export function expectGeometry(observed: number, reason: string) {
  finite(observed, "observed geometry");
  expect(reason.trim().length, "a geometry assertion must state why the bound is safe").toBeGreaterThan(0);
  return {
    toBeGreaterThan(bound: number): void {
      finite(bound, "geometry bound");
      expect(observed, reason).toBeGreaterThan(bound);
      assertHeadroom(observed, bound, "above", reason);
    },
    toBeGreaterThanOrEqual(bound: number): void {
      finite(bound, "geometry bound");
      expect(observed, reason).toBeGreaterThanOrEqual(bound);
      assertHeadroom(observed, bound, "above", reason);
    },
    toBeLessThan(bound: number): void {
      finite(bound, "geometry bound");
      expect(observed, reason).toBeLessThan(bound);
      assertHeadroom(observed, bound, "below", reason);
    },
    toBeLessThanOrEqual(bound: number): void {
      finite(bound, "geometry bound");
      expect(observed, reason).toBeLessThanOrEqual(bound);
      assertHeadroom(observed, bound, "below", reason);
    },
  };
}

export function expectGeometryPoll(observe: () => number | Promise<number>, reason: string) {
  expect(reason.trim().length, "a geometry assertion must state why the bound is safe").toBeGreaterThan(0);
  const poll = async (bound: number, direction: Direction): Promise<void> => {
    finite(bound, "geometry bound");
    let settled: number | undefined;
    const sample = async (): Promise<number> => {
      const observed = await observe();
      // A transient missing element commonly reports infinity. Return NaN so every numeric matcher
      // retries it; throwing here would escape expect.poll's matcher retry loop.
      if (!Number.isFinite(observed)) return Number.NaN;
      settled = observed;
      return observed;
    };
    const required = requiredHeadroom(bound);
    const effectiveBound = direction === "above" ? bound + required : bound - required;
    const assertion = expect.poll(sample, { message: reason });
    // Headroom is positive, so the adjusted inclusive comparison implies both strict and inclusive
    // forms of the caller's original bound while allowing polling to continue through a tight
    // transient sample.
    if (direction === "above") await assertion.toBeGreaterThanOrEqual(effectiveBound);
    else await assertion.toBeLessThanOrEqual(effectiveBound);
    assertHeadroom(settled!, bound, direction, reason);
  };
  return {
    async toBeGreaterThan(bound: number): Promise<void> {
      await poll(bound, "above");
    },
    async toBeGreaterThanOrEqual(bound: number): Promise<void> {
      await poll(bound, "above");
    },
    async toBeLessThan(bound: number): Promise<void> {
      await poll(bound, "below");
    },
    async toBeLessThanOrEqual(bound: number): Promise<void> {
      await poll(bound, "below");
    },
  };
}
