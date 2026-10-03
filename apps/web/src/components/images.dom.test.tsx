/**
 * #2156: every way an attachment can fail to land is reported in plain words (§17): what happened and
 * what to do, with no MIME type, byte unit or internal noun.
 */

import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  MAX_PROMPT_IMAGE_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  WORKSPACE_REFERENCE_MIME_TYPE,
  type WorkspaceReference,
} from "@wollipog/protocol";
import {
  attachedImageAlt,
  attachmentFileName,
  describeAttachmentProblem,
  imageTypeName,
  modelRefusesImagesSentence,
  usePastedImages,
  type AttachmentProblem,
} from "./images.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
/** Just enough FileReader for `fileToImage`: a data URL, or an error for a file named corrupt.png. */
class TestFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      if ((blob as File).name === "corrupt.png") return this.onerror?.();
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  FileReader: TestFileReader,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** Words a notice must never show a person. */
const DEVELOPER_WORDS = /image\/|MiB|payload|mime|base64|undefined|null/i;

function assertPlain(text: { title: string; message: string }, context: string) {
  assert.doesNotMatch(text.message, DEVELOPER_WORDS, `${context}: ${text.message}`);
  assert.doesNotMatch(text.title, DEVELOPER_WORDS, `${context}: ${text.title}`);
  // A Title Case title for the "+N More" menu; a sentence-case message that ends a sentence.
  for (const word of text.title.split(" ")) {
    if (!["a", "an", "and", "for", "of", "or", "the", "to"].includes(word)) {
      assert.match(word, /^[A-Z]/, `${context}: "${text.title}" is Title Case`);
    }
  }
  assert.match(text.message, /^[“"A-Z0-9/]/, `${context}: starts a sentence`);
  assert.match(text.message, /[.]$/, `${context}: ends a sentence`);
}

// One of each kind; the Record makes a new kind fail to compile until it is listed here.
const EVERY_PROBLEM: Record<AttachmentProblem["kind"], AttachmentProblem[]> = {
  "unsupported-type": [
    { kind: "unsupported-type", mimeType: "image/bmp", allowedMimeTypes: PROMPT_IMAGE_MIME_TYPES },
    { kind: "unsupported-type", mimeType: "image/gif", allowedMimeTypes: CODEX_APP_SERVER_IMAGE_MIME_TYPES },
    { kind: "unsupported-type", mimeType: "image/svg+xml", allowedMimeTypes: PROMPT_IMAGE_MIME_TYPES },
    { kind: "unsupported-type", mimeType: "image/vnd.adobe.photoshop", allowedMimeTypes: PROMPT_IMAGE_MIME_TYPES },
    { kind: "unsupported-type", mimeType: "", allowedMimeTypes: PROMPT_IMAGE_MIME_TYPES },
  ],
  "model-refuses-images": [
    { kind: "model-refuses-images", modelName: "Haiku" },
    { kind: "model-refuses-images", modelName: null },
  ],
  "too-large": [{ kind: "too-large", fileName: "huge.png" }],
  unreadable: [{ kind: "unreadable", fileName: "corrupt.png" }],
  "too-many": [{ kind: "too-many" }],
  "too-large-together": [{ kind: "too-large-together" }],
  "too-many-references": [{ kind: "too-many-references" }],
  "duplicate-reference": [{ kind: "duplicate-reference", path: "src/session.ts" }],
};

test("every attachment problem reads in plain words", () => {
  for (const problems of Object.values(EVERY_PROBLEM)) {
    for (const problem of problems) assertPlain(describeAttachmentProblem(problem), JSON.stringify(problem));
  }
});

test("the issue's sentences, word for word", () => {
  const say = (problem: AttachmentProblem) => describeAttachmentProblem(problem);
  assert.deepEqual(say({ kind: "unsupported-type", mimeType: "image/bmp", allowedMimeTypes: PROMPT_IMAGE_MIME_TYPES }), {
    title: "Image Not Supported",
    message: "BMP images aren't supported. Attach a PNG, JPEG, GIF or WebP image.",
  });
  // Codex's app server drops GIF, and the sentence lists only what this session takes.
  assert.equal(
    say({ kind: "unsupported-type", mimeType: "image/gif", allowedMimeTypes: CODEX_APP_SERVER_IMAGE_MIME_TYPES }).message,
    "GIF images aren't supported. Attach a PNG, JPEG or WebP image.",
  );
  assert.equal(
    say({ kind: "unsupported-type", mimeType: "image/vnd.adobe.photoshop", allowedMimeTypes: PROMPT_IMAGE_MIME_TYPES }).message,
    "This image type isn't supported. Attach a PNG, JPEG, GIF or WebP image.",
  );
  assert.equal(say({ kind: "too-large", fileName: "huge.png" }).message, "“huge.png” is larger than 8 MB. Attach a smaller image.");
  assert.equal(say({ kind: "unreadable", fileName: "corrupt.png" }).message, "“corrupt.png” couldn't be read. Try saving it as PNG or JPEG.");
  assert.equal(say({ kind: "too-many" }).message, "You can attach up to 6 images. Remove one to add another.");
  assert.equal(say({ kind: "too-large-together" }).message, "These images are too large to send together. Remove one to add another.");
  assert.equal(
    say({ kind: "model-refuses-images", modelName: "Haiku" }).message,
    "Haiku can't read images. Choose another model in Model Settings to attach them.",
  );
  // One sentence everywhere: the notice, the drop target and the + menu row all call this.
  assert.equal(say({ kind: "model-refuses-images", modelName: "Haiku" }).message, modelRefusesImagesSentence("Haiku"));
  assert.equal(modelRefusesImagesSentence(null), "This model can't read images. Choose another model in Model Settings to attach them.");
});

test("type names are the ones people know, never a MIME type", () => {
  assert.equal(imageTypeName("image/bmp"), "BMP");
  assert.equal(imageTypeName("image/x-ms-bmp"), "BMP");
  assert.equal(imageTypeName("image/jpg"), "JPEG");
  assert.equal(imageTypeName("image/webp"), "WebP");
  assert.equal(imageTypeName("image/svg+xml"), "SVG");
  assert.equal(imageTypeName("image/heic"), "HEIC");
  assert.equal(imageTypeName("image/vnd.adobe.photoshop"), null);
  assert.equal(imageTypeName(""), null);
});

type Hook = ReturnType<typeof usePastedImages>;

/** Mount the hook and hand back its latest value, the problems it reported and its draft changes. */
async function mountHook(allowed: readonly string[], modelName: string | null = null) {
  const problems: AttachmentProblem[] = [];
  let changes = 0;
  let current: Hook | null = null;
  function Harness() {
    current = usePastedImages(() => { changes += 1; }, (problem) => problems.push(problem), allowed, modelName);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  return {
    problems,
    changes: () => changes,
    hook: () => current!,
    add: async (files: File[]) => {
      await act(async () => {
        await current!.addFiles(files);
      });
    },
    unmount: () => act(async () => root.unmount()),
  };
}

const png = (name: string, size = 4) => new File([new Uint8Array(size)], name, { type: "image/png" });

test("every addFiles outcome reports one plain notice, after what fit has landed", async () => {
  const outcomes: Array<{ name: string; allowed: readonly string[]; files: () => File[]; kind: AttachmentProblem["kind"]; attached: number }> = [
    { name: "unsupported type", allowed: PROMPT_IMAGE_MIME_TYPES, files: () => [new File(["x"], "scan.bmp", { type: "image/bmp" }), png("ok.png")], kind: "unsupported-type", attached: 1 },
    { name: "model without images", allowed: [], files: () => [png("photo.png")], kind: "model-refuses-images", attached: 0 },
    { name: "too large", allowed: PROMPT_IMAGE_MIME_TYPES, files: () => [png("huge.png", MAX_PROMPT_IMAGE_BYTES + 1)], kind: "too-large", attached: 0 },
    { name: "too many", allowed: PROMPT_IMAGE_MIME_TYPES, files: () => Array.from({ length: 7 }, (_, i) => png(`shot-${i}.png`)), kind: "too-many", attached: 6 },
  ];
  for (const outcome of outcomes) {
    const mounted = await mountHook(outcome.allowed, "Haiku");
    try {
      await mounted.add(outcome.files());
      assert.equal(mounted.problems.length, 1, outcome.name);
      assert.equal(mounted.problems[0]!.kind, outcome.kind, outcome.name);
      assert.equal(mounted.hook().images.length, outcome.attached, outcome.name);
      assertPlain(describeAttachmentProblem(mounted.problems[0]!), outcome.name);
    } finally {
      await mounted.unmount();
    }
  }
});

test("an unreadable file and an over-budget pick report in words too", async () => {
  const unreadable = await mountHook(PROMPT_IMAGE_MIME_TYPES);
  try {
    await unreadable.add([png("corrupt.png"), png("fine.png")]);
    assert.deepEqual(unreadable.problems.map((problem) => problem.kind), ["unreadable"]);
    assert.equal(unreadable.hook().images.length, 1);
    assert.equal(describeAttachmentProblem(unreadable.problems[0]!).message, "“corrupt.png” couldn't be read. Try saving it as PNG or JPEG.");
  } finally {
    await unreadable.unmount();
  }

  // Four 6 MiB images are under the per-image and count limits but past the combined budget.
  const mounted = await mountHook(PROMPT_IMAGE_MIME_TYPES);
  try {
    await mounted.add(Array.from({ length: 4 }, (_, i) => png(`bulk-${i}.png`, 6 * 1024 * 1024)));
    assert.deepEqual(mounted.problems.map((problem) => problem.kind), ["too-large-together"]);
    assert.ok(mounted.hook().images.length > 0 && mounted.hook().images.length < 4);
    // The draft changed (some images landed) before the notice was reported, so the change does not
    // clear it.
    assert.equal(mounted.changes(), 1);
  } finally {
    await mounted.unmount();
  }
});

test("each attached image keeps the name of the file it came from, for its alt text and notices (#2177)", async () => {
  const mounted = await mountHook(PROMPT_IMAGE_MIME_TYPES);
  try {
    await mounted.add([png("diagram.png"), png("screenshot.png")]);
    const [first, second] = mounted.hook().images;
    assert.equal(attachmentFileName(first!), "diagram.png");
    assert.equal(attachmentFileName(second!), "screenshot.png");
    assert.equal(attachedImageAlt(2, attachmentFileName(second!)), "Attached image 2: screenshot.png");
    // A restored draft's image has no name, and is numbered instead.
    assert.equal(attachedImageAlt(1, attachmentFileName({ mimeType: "image/png", data: "AAAA" })), "Attached image 1");
  } finally {
    await mounted.unmount();
  }
});

test("a reference already attached is an attachment notice, not a toast (#2177)", async () => {
  const mounted = await mountHook(PROMPT_IMAGE_MIME_TYPES);
  const reference: WorkspaceReference = {
    artifactId: "workspace:readme", mimeType: WORKSPACE_REFERENCE_MIME_TYPE, sizeBytes: 0, sha256: "a".repeat(64),
    referenceVersion: 1, kind: "file", path: "README.md", rootFingerprint: "b".repeat(64), targetFingerprint: "a".repeat(64),
  };
  try {
    let outcome: string | undefined;
    await act(async () => { outcome = mounted.hook().addWorkspaceReference(reference); });
    assert.equal(outcome, "added");
    assert.deepEqual(mounted.problems, [], "the chip is the confirmation");
    await act(async () => { outcome = mounted.hook().addWorkspaceReference({ ...reference, artifactId: "workspace:again" }); });
    assert.equal(outcome, "duplicate");
    assert.deepEqual(mounted.problems, [{ kind: "duplicate-reference", path: "README.md" }]);
    assert.deepEqual(describeAttachmentProblem(mounted.problems[0]!), {
      title: "Already Attached", message: "“README.md” is already attached.",
    });
  } finally {
    await mounted.unmount();
  }
});
