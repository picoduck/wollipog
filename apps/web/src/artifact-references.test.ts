import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { SessionArtifactDirectory } from "./artifact-directory.js";
import {
  ARTIFACT_REFERENCE_TAG,
  isArtifactId,
  referencedArtifactIds,
  rehypeArtifactReferences,
  splitArtifactIds,
} from "./artifact-references.js";

const SHORT = "art_ce7748e66d88";
const LONG = "art_0123456789abcdef0123456789abcdef";

test("only the control plane's two artifact id shapes are artifact ids", () => {
  assert.equal(isArtifactId(SHORT), true);
  assert.equal(isArtifactId(LONG), true);
  for (const value of ["art_CE7748E66D88", "art_ce7748e66d8", "art_ce7748e66d88a", "xart_ce7748e66d88", "art_", "run_ce7748e66d88"]) {
    assert.equal(isArtifactId(value), false, value);
  }
  assert.deepEqual(splitArtifactIds(`See ${SHORT}, then ${LONG}.`), [
    { text: "See " }, { id: SHORT }, { text: ", then " }, { id: LONG }, { text: "." },
  ]);
  // Inside a longer word or path it is not a reference.
  assert.deepEqual(splitArtifactIds(`${SHORT}x and my_art_ce7748e66d88`), [{ text: `${SHORT}x and my_art_ce7748e66d88` }]);
});

test("a reply's references are its ids outside fenced code, each once, in order", () => {
  const reply = [
    `Captured \`${SHORT}\` and ${LONG}.`,
    "```json",
    '{ "artifactId": "art_aaaaaaaaaaaa" }',
    "```",
    `Again: ${SHORT}.`,
    "~~~~",
    "art_bbbbbbbbbbbb",
    "~~~~",
    "And art_cccccccccccc.",
  ].join("\n");
  assert.deepEqual(referencedArtifactIds(reply), [SHORT, LONG, "art_cccccccccccc"]);
  assert.deepEqual(referencedArtifactIds("No ids here."), []);
});

test("references follow the rendered grammar: code in quotes and lists, inline triple backticks, links", () => {
  const reply = [
    "    art_dddddddddddd",
    "",
    "> ```",
    "> art_aaaaaaaaaaaa",
    "> ```",
    "",
    "- item",
    "",
    "  ```",
    "  art_bbbbbbbbbbbb",
    "  ```",
    "",
    // A valid inline code span opened by three backticks: a citation, and no fence follows it.
    "Inline ```art_cccccccccccc``` then art_eeeeeeeeeeee.",
    `[the ${SHORT} link](https://example.com) and \`  ${LONG}  \`.`,
  ].join("\n");
  assert.deepEqual(referencedArtifactIds(reply), ["art_cccccccccccc", "art_eeeeeeeeeeee"],
    "quoted, listed and indented code, link text and a padded code span are not citations");
});

test("the rehype pass marks ids in prose and whole-id code spans, and leaves fenced code alone", () => {
  const text = (value: string) => ({ type: "text", value });
  const tree = {
    type: "root",
    children: [
      { type: "element", tagName: "p", children: [
        text(`See ${SHORT} now `),
        { type: "element", tagName: "code", children: [text(LONG)] },
        { type: "element", tagName: "code", children: [text(`id ${SHORT}`)] },
      ] },
      { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", children: [text(SHORT)] }] },
    ],
  };
  rehypeArtifactReferences()(tree);
  const paragraph = tree.children[0]!.children;
  assert.deepEqual(paragraph.map((node) => ("tagName" in node ? node.tagName : (node as { value: string }).value)), [
    "See ", ARTIFACT_REFERENCE_TAG, " now ", ARTIFACT_REFERENCE_TAG, "code",
  ]);
  assert.deepEqual((paragraph[3] as unknown as { properties: unknown }).properties, { dataCode: "true" });
  // A code span that only mentions an id among other words stays code.
  assert.equal((paragraph[4] as { children: Array<{ value: string }> }).children[0]!.value, `id ${SHORT}`);
  const fenced = tree.children[1] as { children: Array<{ tagName: string; children: Array<{ value: string }> }> };
  assert.equal(fenced.children[0]!.tagName, "code");
  assert.equal(fenced.children[0]!.children[0]!.value, SHORT);
});

const artifact = (id: string, sessionId = "s1"): WorkflowArtifactView => ({
  artifactId: id, sessionId, kind: "screenshot", name: `${id}.png`, mimeType: "image/png", encoding: "base64",
  sizeBytes: 1, sha256: "0".repeat(64), createdBy: { kind: "agent", id: sessionId }, createdAt: 1,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the directory names attachments without a read, and pages the list only as far as asked", async () => {
  const pages: Record<string, WorkflowArtifactPage> = {
    first: { artifacts: [artifact("art_000000000001")], nextCursor: "2" },
    "2": { artifacts: [artifact("art_000000000002")], nextCursor: "3" },
    "3": { artifacts: [artifact("art_000000000003")] },
  };
  const reads: Array<string | undefined> = [];
  const directory = new SessionArtifactDirectory("s1", async (_session, cursor) => {
    reads.push(cursor);
    return pages[cursor ?? "first"]!;
  });
  directory.remember([artifact(SHORT), artifact("art_ffffffffffff", "other-session")]);
  directory.request([SHORT]);
  await settle();
  assert.deepEqual(reads, [], "an attachment the transcript holds needs no read");
  assert.equal(directory.resolve(SHORT).state, "resolved");
  assert.equal(directory.resolve(SHORT), directory.resolve(SHORT), "a resolution keeps its identity");

  directory.request(["art_000000000002"]);
  assert.equal(directory.resolve("art_000000000002").state, "pending");
  await settle();
  await settle();
  assert.deepEqual(reads, [undefined, "2"], "it stops at the page that names the id");
  assert.equal(directory.resolve("art_000000000002").state, "resolved");
});

test("an id no page carries, another session's, or one whose read fails is missing, and is read once", async () => {
  let reads = 0;
  let fail = false;
  const directory = new SessionArtifactDirectory("s1", async () => {
    reads += 1;
    if (fail) throw new Error("503");
    return { artifacts: [artifact("art_aaaaaaaaaaaa"), artifact("art_bbbbbbbbbbbb", "s2")] };
  });
  directory.remember([artifact("art_cccccccccccc", "s2")]);
  directory.request(["art_bbbbbbbbbbbb", "art_cccccccccccc", "art_dddddddddddd"]);
  await settle();
  await settle();
  for (const id of ["art_bbbbbbbbbbbb", "art_cccccccccccc", "art_dddddddddddd"]) {
    assert.equal(directory.resolve(id).state, "missing", id);
  }
  directory.request(["art_dddddddddddd"]);
  await settle();
  assert.equal(reads, 1, "a settled id is not looked up again");

  fail = true;
  directory.request(["art_eeeeeeeeeeee"]);
  await settle();
  await settle();
  assert.equal(directory.resolve("art_eeeeeeeeeeee").state, "missing");
  // An attachment that arrives later names it after all.
  directory.remember([artifact("art_eeeeeeeeeeee")]);
  assert.equal(directory.resolve("art_eeeeeeeeeeee").state, "resolved");
});
