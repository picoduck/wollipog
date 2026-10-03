import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  entryFileName,
  INVENTORY_DIRECTORY,
  inventoryFiles,
  readInventory,
  slugOf,
  writeInventory,
} from "./stylesheet-debt-store.mjs";

/**
 * Every file under `directory` with its contents, by `/`-separated relative path. Line endings are
 * read as LF, the way `readInventory` reads them, so a `core.autocrlf` checkout compares equal.
 */
function snapshot(directory, relative = "", found = {}) {
  for (const entry of readdirSync(join(directory, relative)).sort()) {
    const path = relative ? `${relative}/${entry}` : entry;
    if (statSync(join(directory, path)).isDirectory()) snapshot(directory, path, found);
    else found[path] = readFileSync(join(directory, path), "utf8").replace(/\r\n/g, "\n");
  }
  return found;
}

function withDirectory(run) {
  const root = mkdtempSync(join(tmpdir(), "stylesheet-debt-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SAMPLE = {
  gapLiterals: ["|.b|gap|6px", "|.a|gap|4px"],
  paddingLiterals: ["|.a|padding|6px", "|.a|padding|6px", "|.a|padding|2px"],
  flexEndOverflow: [],
};

test("the checked-in inventory is exactly what the regenerator writes for it", () => {
  const recorded = readInventory();
  assert.deepEqual(snapshot(INVENTORY_DIRECTORY), Object.fromEntries(inventoryFiles(recorded)));
});

test("every entry name is short, lowercase ASCII and carries its hash", () => {
  for (const path of Object.keys(snapshot(INVENTORY_DIRECTORY))) {
    if (path === "inventories.txt") continue;
    assert.match(path, /^[A-Za-z]+\/[a-z0-9-]{1,48}\.[0-9a-f]{12}\.txt$/, path);
    // Comfortably inside Windows' 260-character limit even under a deep checkout.
    assert.ok(`apps/web/src/stylesheet-debt/${path}`.length <= 120, path);
  }
  assert.equal(slugOf("@media (max-width: 760px)|.pairing-controls input|font-size|16"),
    "media-max-width-760px-pairing-controls-input-fon");
  assert.equal(slugOf("components/Board.tsx|❓|❓"), "components-board-tsx");
  assert.equal(slugOf("🔐"), "entry", "a name with nothing readable still has a slug");
  for (const device of ["con", "AUX", "nul", "com1", "lpt9", "prn"]) {
    assert.equal(slugOf(device), `${device.toLowerCase()}-entry`, `${device} is a Windows device name, even with an extension`);
  }
  assert.equal(slugOf("console"), "console", "only the exact device names are escaped");
  assert.notEqual(entryFileName("|.A|gap|6px"), entryFileName("|.a|gap|6px"),
    "identities differing only in case get different names, so case-insensitive filesystems keep both");
});

test("writing and reading round-trips, keeping repeats and empty inventories, in any input order", () => {
  withDirectory((root) => {
    writeInventory(SAMPLE, root);
    assert.deepEqual(readInventory(root), {
      flexEndOverflow: [],
      gapLiterals: ["|.a|gap|4px", "|.b|gap|6px"],
      paddingLiterals: ["|.a|padding|2px", "|.a|padding|6px", "|.a|padding|6px"],
    });
    const first = snapshot(root);
    assert.equal(first["inventories.txt"], "flexEndOverflow\ngapLiterals\npaddingLiterals\n");
    assert.equal(first[`paddingLiterals/${entryFileName("|.a|padding|6px")}`], "|.a|padding|6px\n|.a|padding|6px\n");

    const shuffled = { paddingLiterals: [...SAMPLE.paddingLiterals].reverse(), flexEndOverflow: [], gapLiterals: [...SAMPLE.gapLiterals].reverse() };
    writeInventory(shuffled, root);
    assert.deepEqual(snapshot(root), first, "the output depends only on the inventory");
  });
});

test("regenerating prunes paid entries, dropped inventories and stray files", () => {
  withDirectory((root) => {
    writeInventory(SAMPLE, root);
    writeFileSync(join(root, "gapLiterals", "notes.md"), "stray\n");
    writeFileSync(join(root, "README.md"), "stray\n");
    mkdirSync(join(root, "oldInventory"));
    writeFileSync(join(root, "oldInventory", "x.txt"), "x\n");
    const paid = { gapLiterals: ["|.a|gap|4px"], flexEndOverflow: [] };
    writeInventory(paid, root);
    assert.deepEqual(snapshot(root), Object.fromEntries(inventoryFiles(paid)));
    assert.deepEqual(readdirSync(root).sort(), ["gapLiterals", "inventories.txt"], "emptied directories are removed");
  });
});

test("reading refuses any directory the regenerator would not have written, naming the path", () => {
  const broken = [
    ["no manifest", (root) => rmSync(join(root, "inventories.txt")), "inventories.txt is missing"],
    ["a stray top-level file", (root) => writeFileSync(join(root, "README.md"), "hi\n"), "README.md is not a file the regenerator writes"],
    ["a stray file beside the entries", (root) => writeFileSync(join(root, "gapLiterals", "notes.txt"), "|.c|gap|8px\n"),
      "gapLiterals/notes.txt is not a file the regenerator writes"],
    ["a misnamed entry", (root) => renameSync(join(root, "gapLiterals", entryFileName("|.a|gap|4px")), join(root, "gapLiterals", "a.txt")),
      "gapLiterals/a.txt is not a file the regenerator writes"],
    ["a hand-edited identity", (root) => writeFileSync(join(root, "gapLiterals", entryFileName("|.a|gap|4px")), "|.a|gap|5px\n"),
      `gapLiterals/${entryFileName("|.a|gap|4px")} is not a file the regenerator writes`],
    ["two identities in one file", (root) => writeFileSync(join(root, "gapLiterals", entryFileName("|.a|gap|4px")), "|.a|gap|4px\n|.b|gap|6px\n"),
      "must repeat one identity"],
    ["a missing final newline", (root) => writeFileSync(join(root, "gapLiterals", entryFileName("|.a|gap|4px")), "|.a|gap|4px"),
      "must repeat one identity"],
    ["an empty entry file", (root) => writeFileSync(join(root, "gapLiterals", entryFileName("|.a|gap|4px")), ""), "must repeat one identity"],
    ["a nested directory", (root) => {
      mkdirSync(join(root, "gapLiterals", "deeper"));
      writeFileSync(join(root, "gapLiterals", "deeper", entryFileName("|.c|gap|8px")), "|.c|gap|8px\n");
    }, `gapLiterals/deeper/${entryFileName("|.c|gap|8px")} is not a file the regenerator writes`],
    ["an inventory left out of the manifest", (root) => writeFileSync(join(root, "inventories.txt"), "flexEndOverflow\npaddingLiterals\n"),
      `gapLiterals/${entryFileName("|.a|gap|4px")} is not a file the regenerator writes`],
    ["an unsorted manifest", (root) => writeFileSync(join(root, "inventories.txt"), "paddingLiterals\ngapLiterals\nflexEndOverflow\n"),
      "inventories.txt is not a file the regenerator writes"],
  ];
  for (const [label, breakIt, message] of broken) {
    withDirectory((root) => {
      writeInventory(SAMPLE, root);
      breakIt(root);
      assert.throws(() => readInventory(root), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(message), `${label}: expected "${message}" in: ${error.message}`);
        assert.ok(error.message.includes("pnpm regenerate:stylesheet-debt"), `${label}: names the fix`);
        return true;
      }, label);
      writeInventory(SAMPLE, root);
      assert.doesNotThrow(() => readInventory(root), `${label}: regenerating repairs it`);
    });
  }
});

test("a checkout with CRLF line endings reads the same inventory, and regenerating leaves it alone", () => {
  withDirectory((root) => {
    writeInventory(SAMPLE, root);
    const expected = readInventory(root);
    for (const [path, contents] of Object.entries(snapshot(root))) writeFileSync(join(root, path), contents.replace(/\n/g, "\r\n"));
    assert.deepEqual(readInventory(root), expected);
    assert.deepEqual(snapshot(root), Object.fromEntries(inventoryFiles(expected)));
    writeInventory(SAMPLE, root);
    assert.match(readFileSync(join(root, "inventories.txt"), "utf8"), /\r\n/, "unchanged files are not rewritten");
  });
});

test("a missing or linked inventory directory is refused before anything is read or pruned", () => {
  withDirectory((root) => {
    assert.throws(() => readInventory(join(root, "absent")), /absent is missing; run `pnpm regenerate:stylesheet-debt`/);
    const target = join(root, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "not debt\n");
    const linked = join(root, "linked");
    symlinkSync(target, linked, "dir");
    assert.throws(() => writeInventory({}, linked), /is not a directory \(a link is refused\)/);
    assert.throws(() => readInventory(linked), /is not a directory \(a link is refused\)/);
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "not debt\n", "nothing behind the link was pruned");
  });
});

/*
 * The #2469 reproduction. #2441 paid the three `.tool-*` font sizes and #2435 paid
 * `.transcript-load-notice`, its neighbour in the sorted list. In the single JSON file that was a
 * conflict on every rebase and an ejection from the merge queue; as one file per entry, it is two
 * deletions of different paths.
 */
const BASE = {
  fontSizeLiterals: [
    "|.tl-working|font-size|12.5",
    "|.tool-body|font-size|12",
    "|.tool-caret|font-size|10",
    "|.tool-title|font-size|13",
    "|.transcript-load-notice|font-size|12",
    "|.usage-breakdown li|font-size|12",
  ],
  gapLiterals: ["|.a|gap|4px"],
};
const PAID_BY_2441 = { ...BASE, fontSizeLiterals: BASE.fontSizeLiterals.filter((entry) => !entry.startsWith("|.tool-")) };
const PAID_BY_2435 = { ...BASE, fontSizeLiterals: BASE.fontSizeLiterals.filter((entry) => !entry.includes("transcript-load-notice")) };
const PAID_BY_BOTH = { ...BASE, fontSizeLiterals: ["|.tl-working|font-size|12.5", "|.usage-breakdown li|font-size|12"] };

/** Git isolated from the machine's own configuration, so hooks, signing or a merge driver cannot help. */
function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
}
function gitOk(cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

/** A repository whose `base` holds `write(BASE)`, and branches `one` and `two` that each pay part of it. */
function concurrentPayments(root, write) {
  gitOk(root, ["init", "-q", "-b", "base"]);
  for (const [key, value] of [["user.name", "Debt"], ["user.email", "debt@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    gitOk(root, ["config", key, value]);
  }
  const commit = (inventory, message) => {
    write(inventory);
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", message]);
  };
  commit(BASE, "base");
  gitOk(root, ["checkout", "-q", "-b", "one"]);
  commit(PAID_BY_2441, "pay the .tool-* font sizes");
  gitOk(root, ["checkout", "-q", "-b", "two", "base"]);
  commit(PAID_BY_2435, "pay .transcript-load-notice");
}

test("two branches paying neighbouring entries merge and rebase onto each other without a conflict", () => {
  withDirectory((root) => {
    const directory = join(root, "inventory");
    concurrentPayments(root, (inventory) => writeInventory(inventory, directory));
    const expected = Object.fromEntries(inventoryFiles(PAID_BY_BOTH));

    // What GitHub's merge queue does: a three-way merge of the two trees, with no custom driver.
    gitOk(root, ["checkout", "-q", "-b", "merged", "one"]);
    gitOk(root, ["merge", "--no-edit", "-q", "two"]);
    assert.deepEqual(snapshot(directory), expected, "the merge is exactly what regenerating would write");
    assert.deepEqual(readInventory(directory), PAID_BY_BOTH);

    gitOk(root, ["checkout", "-q", "two"]);
    gitOk(root, ["rebase", "-q", "one"]);
    assert.deepEqual(snapshot(directory), expected, "the rebase is exactly what regenerating would write");
  });
});

test("the same two payments in the old single JSON file conflict, which is why the layout changed", () => {
  withDirectory((root) => {
    const file = join(root, "stylesheet-debt.json");
    concurrentPayments(root, (inventory) => writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`));
    gitOk(root, ["checkout", "-q", "-b", "merged", "one"]);
    const merge = git(root, ["merge", "--no-edit", "two"]);
    assert.notEqual(merge.status, 0);
    assert.match(merge.stdout, /CONFLICT \(content\): Merge conflict in stylesheet-debt\.json/);
  });
});

test("the regenerator is the documented single command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["regenerate:stylesheet-debt"], "node --import tsx scripts/regenerate-stylesheet-debt.mjs");
});
