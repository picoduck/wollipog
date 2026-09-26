import assert from "node:assert/strict";
import { test } from "node:test";
import { videoFrameValidationSessionId } from "./video-frame-validation.js";

test("video-frame validation is off unless an operator names one exact Session", () => {
  assert.equal(videoFrameValidationSessionId(undefined), undefined);
  assert.equal(videoFrameValidationSessionId("s_012345abcdef"), "s_012345abcdef");
  for (const value of ["", "true", "1", "s_012345abcde", "s_012345abcdef ",
    "s_012345abcdef,s_111111111111", "S_012345ABCDEF"]) {
    assert.throws(() => videoFrameValidationSessionId(value), /one exact Session ID/u);
  }
});
