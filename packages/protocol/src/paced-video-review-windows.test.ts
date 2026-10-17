import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { PACED_VIDEO_REVIEW_WINDOW_LIMITS, pacedVideoReviewWindowPlan, pacedVideoReviewWindowPlanBody,
  parsePacedVideoReviewWindowNotes, validPacedVideoReviewWindowNotes, type PacedVideoReviewWindowNotes } from "./paced-video-review-windows.js";

const frames = (sizes: number[]) => sizes.map((sizeBytes, index) => ({ index, ptsUs: index * 33_334, durationUs: 33_334,
  sha256: "a".repeat(64), sizeBytes }));
const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4;

test("window plans cover every frame in order, overlap by exactly one frame and respect both window limits", () => {
  fc.assert(fc.property(fc.array(fc.oneof(fc.integer({ min: 1, max: 300_000 }), fc.integer({ min: 1, max: 2 * 1024 * 1024 })), { minLength: 1, maxLength: 900 }), (sizes) => {
    let plan;
    try { plan = pacedVideoReviewWindowPlan(frames(sizes)); } catch (error) {
      assert.match((error as Error).message, /more delivery windows/u); return;
    }
    const { windows } = plan;
    assert.equal(windows[0]!.firstIndex, 0);
    assert.equal(windows.at(-1)!.endIndex, sizes.length);
    assert.deepEqual(windows.map((w) => w.final), windows.map((_, i) => i === windows.length - 1));
    for (const [i, w] of windows.entries()) {
      assert.equal(w.index, i);
      assert.ok(w.endIndex > w.firstIndex && w.endIndex - w.firstIndex <= PACED_VIDEO_REVIEW_WINDOW_LIMITS.frames);
      const bytes = sizes.slice(w.firstIndex, w.endIndex).reduce((sum, size) => sum + base64(size), 0);
      assert.ok(w.endIndex - w.firstIndex === 1 || bytes <= PACED_VIDEO_REVIEW_WINDOW_LIMITS.base64Bytes);
      if (i) {
        const previous = windows[i - 1]!;
        assert.ok(w.firstIndex === previous.endIndex - 1 || w.firstIndex === previous.endIndex && previous.endIndex - previous.firstIndex === 1);
      }
    }
    assert.equal(pacedVideoReviewWindowPlanBody(pacedVideoReviewWindowPlan(frames(sizes))), pacedVideoReviewWindowPlanBody(plan),
      "deterministic from the grant alone");
  }), { numRuns: 200 });
});

test("the paced and maximum profiles split into the expected fresh-context windows", () => {
  assert.equal(pacedVideoReviewWindowPlan(frames(Array(360).fill(200_000))).windows.length, 7);
  assert.equal(pacedVideoReviewWindowPlan(frames(Array(900).fill(100_000))).windows.length, 16);
  // Large native frames shrink each window by bytes, never by sampling.
  const large = pacedVideoReviewWindowPlan(frames(Array(64).fill(2 * 1024 * 1024)));
  assert.ok(large.windows.every((w) => w.endIndex - w.firstIndex <= 9));
  assert.throws(() => pacedVideoReviewWindowPlan([]));
  assert.throws(() => pacedVideoReviewWindowPlan(frames([10, 20]).map((f, i) => i ? { ...f, index: 5 } : f)));
  assert.throws(() => pacedVideoReviewWindowPlan(frames([0])));
});

const window = { index: 0, firstIndex: 0, endIndex: 4, final: false };
const grantFrames = frames([10, 10, 10, 10, 10]);
const valid = (): PacedVideoReviewWindowNotes => ({
  window: { firstIndex: 0, endIndex: 4 },
  observations: [{ fromIndex: 0, toIndex: 1, description: "settings panel idle" }, { fromIndex: 2, toIndex: 3, description: "toast appears" }],
  transients: [{ index: 2, ptsUs: 2 * 33_334, description: "one-frame red flash" }],
  defects: [{ criterionId: "transition", frameIndices: [2], description: "flash during transition" }],
});

test("structured window notes must account for every frame and name transients at their exact native time", () => {
  assert.equal(validPacedVideoReviewWindowNotes(valid(), window, grantFrames), true);
  const broken: Array<[string, (n: PacedVideoReviewWindowNotes) => unknown]> = [
    ["gap in coverage", (n) => ({ ...n, observations: [n.observations[0], { ...n.observations[1]!, fromIndex: 3 }] })],
    ["coverage stops early", (n) => ({ ...n, observations: [n.observations[0]] })],
    ["coverage past window", (n) => ({ ...n, observations: [n.observations[0], { ...n.observations[1]!, toIndex: 4 }] })],
    ["wrong window", (n) => ({ ...n, window: { firstIndex: 0, endIndex: 5 } })],
    ["transient timestamp guessed", (n) => ({ ...n, transients: [{ ...n.transients[0]!, ptsUs: 66_000 }] })],
    ["transient outside window", (n) => ({ ...n, transients: [{ index: 4, ptsUs: 4 * 33_334, description: "x" }] })],
    ["defect outside window", (n) => ({ ...n, defects: [{ ...n.defects[0]!, frameIndices: [4] }] })],
    ["duplicate defect frames", (n) => ({ ...n, defects: [{ ...n.defects[0]!, frameIndices: [2, 2] }] })],
    ["extra key", (n) => ({ ...n, verdict: "accept" })],
    ["empty description", (n) => ({ ...n, observations: [{ ...n.observations[0]!, description: " " }, n.observations[1]] })],
    ["oversized notes", (n) => ({ ...n, observations: [{ fromIndex: 0, toIndex: 3, description: "x".repeat(1_000) }],
      transients: Array.from({ length: 8 }, () => ({ index: 2, ptsUs: 2 * 33_334, description: "y".repeat(900) })) })],
  ];
  for (const [label, mutate] of broken) assert.equal(validPacedVideoReviewWindowNotes(mutate(valid()), window, grantFrames), false, label);
});

test("notes parse only as the whole message or one fenced JSON block", () => {
  const text = JSON.stringify(valid());
  assert.deepEqual(parsePacedVideoReviewWindowNotes(text), valid());
  assert.deepEqual(parsePacedVideoReviewWindowNotes("```json\n" + text + "\n```"), valid());
  assert.equal(parsePacedVideoReviewWindowNotes("Here are my notes: " + text), null);
  assert.equal(parsePacedVideoReviewWindowNotes(text + "\nDone."), null);
  assert.equal(parsePacedVideoReviewWindowNotes(" ".repeat(PACED_VIDEO_REVIEW_WINDOW_LIMITS.notesChars + 65)), null);
  assert.equal(parsePacedVideoReviewWindowNotes(undefined), null);
});
