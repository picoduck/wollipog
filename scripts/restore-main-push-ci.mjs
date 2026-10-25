#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CUTOVER_MARKER = "  # Main pushes use Main Rolling Controller; rollback: scripts/restore-main-push-ci.mjs.\n";
const PUSH = "  push:\n    branches: [main]\n";

/** Restore only the reviewed event block; never revert later jobs or PR routing. */
export function restoreMainPushCI(source) {
  const headers = [...source.matchAll(/^on:\n((?:[ \t].*\n|\n)*)/gm)];
  if (headers.length !== 1) throw new Error("Expected one canonical workflow event mapping");
  const [header] = headers, events = header[1];
  const keys = [...events.matchAll(/^  ([^\s#].*)$/gm)].map(match => match[1]);
  if (keys.some(key => !/^(workflow_call|merge_group|pull_request|workflow_dispatch|push):$/.test(key)) ||
      new Set(keys).size !== keys.length)
    throw new Error("Event keys differ from the reviewed canonical mapping; review before restoring");
  if (!/^  merge_group:\n/m.test(events) || !/^  pull_request:\n/m.test(events) || !/^  workflow_call:\n/m.test(events))
    throw new Error("Required PR, merge-group or rolling event is missing");
  const pushes = [...events.matchAll(/^  push:[^\n]*\n(?:[ \t]{4}.*\n|\n|  #.*\n)*/gm)];
  if (pushes.length) {
    if (pushes.length !== 1 || pushes[0][0] !== PUSH || events.includes(CUTOVER_MARKER))
      throw new Error("Existing push event differs from the reviewed main-only trigger");
    return source;
  }
  if (events.split(CUTOVER_MARKER).length !== 2)
    throw new Error("Cutover marker missing or ambiguous; review current workflow before restoring");
  const restored = header[0].replace(CUTOVER_MARKER, PUSH);
  return source.slice(0, header.index) + restored + source.slice(header.index + header[0].length);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const write = argv[0] === "--write";
    const args = write ? argv.slice(1) : argv;
    if (args.length > 1 || args[0]?.startsWith("-")) throw new Error("Usage: restore-main-push-ci.mjs [--write] [workflow-file]");
    const path = args[0] ?? fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
    const source = readFileSync(path, "utf8"), restored = restoreMainPushCI(source);
    if (source === restored) console.log("Main-push full CI is already restored; no changes.");
    else if (write) {
      writeFileSync(path, restored);
      console.log("Restored main-push full CI. Review the diff and land it through the normal PR/merge queue.");
    } else console.log("Rollback is applicable. Run with --write to restore the main-push trigger locally.");
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
