/**
 * The stylesheet guard's debt inventory on disk: one file per recorded identity.
 *
 * It used to be one sorted JSON file, and every pull request that paid debt down edited the same
 * arrays. Git conflicts whenever two branches delete neighbouring lines, even when the deletions
 * are independent, and GitHub's merge queue runs no custom merge driver, so queued pull requests
 * were ejected over removals that never touched each other (#2469). No single-file layout avoids
 * that: deleting an entry deletes its lines, and the deletions of two neighbours always touch.
 * Git merges trees by path, so here every identity owns its own path, and two branches that pay
 * down different entries delete different files.
 *
 *   apps/web/src/stylesheet-debt/
 *     inventories.txt                       one inventory name per line, including empty ones
 *     <inventory>/<slug>.<hash>.txt         the identity, once per recorded occurrence
 *
 * The directory is a pure function of the inventory: `inventoryFiles` names every path and its
 * exact contents, `writeInventory` makes the directory equal that (pruning everything else), and
 * `readInventory` refuses a directory that differs from what it would write for the inventory it
 * reads. A hand-edited, misnamed, or stray file therefore fails the guard instead of quietly
 * recording something the regenerator would not.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INVENTORY_DIRECTORY = fileURLToPath(new URL("../apps/web/src/stylesheet-debt", import.meta.url));
export const REGENERATE_COMMAND = "pnpm regenerate:stylesheet-debt";

const MANIFEST = "inventories.txt";
/**
 * A readable prefix, cut short so the deepest path stays far inside Windows' 260-character limit
 * (the directory, the longest inventory name and a name are about 120 characters together).
 */
const SLUG_LENGTH = 48;
/** 48 bits of SHA-256: a collision among a few thousand identities is about one in 10^8, and is refused. */
const HASH_LENGTH = 12;

/** Code-unit order, so the output does not depend on the locale it was generated in. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Windows device names, which it reserves even with an extension: `con.1143da2bc54c.txt` cannot be
 * checked out there. Only the part before the first dot counts, and for an entry that is the slug.
 */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Lowercase ASCII words joined by `-`: safe on every filesystem, including case-insensitive ones. */
export function slugOf(identity) {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, SLUG_LENGTH).replace(/-+$/, "");
  if (WINDOWS_DEVICE.test(slug)) return `${slug}-entry`;
  return slug || "entry";
}

/** The file one identity is stored in. The hash, not the slug, is what keeps distinct identities apart. */
export function entryFileName(identity) {
  const hash = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, HASH_LENGTH);
  return `${slugOf(identity)}.${hash}.txt`;
}

function assertInventoryName(name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`stylesheet debt: "${name}" is not a valid inventory name`);
}

/** Every file the inventory is stored as, by path relative to the directory, with its exact contents. */
export function inventoryFiles(inventory) {
  const names = Object.keys(inventory).sort(byCodeUnits);
  const files = new Map([[MANIFEST, names.map((name) => `${name}\n`).join("")]]);
  for (const name of names) {
    assertInventoryName(name);
    const counts = new Map();
    for (const identity of inventory[name]) {
      if (typeof identity !== "string" || identity === "" || /[\r\n]/.test(identity)) {
        throw new Error(`stylesheet debt: ${name} has an identity that is empty or spans lines: ${JSON.stringify(identity)}`);
      }
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    for (const identity of [...counts.keys()].sort(byCodeUnits)) {
      const path = `${name}/${entryFileName(identity)}`;
      if (files.has(path)) throw new Error(`stylesheet debt: ${path} would store two identities; lengthen the hash`);
      files.set(path, `${identity}\n`.repeat(counts.get(identity)));
    }
  }
  return files;
}

function assertRealDirectory(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error(`stylesheet debt: ${directory} is not a directory (a link is refused)`);
}

/** Every regular file under `directory`, by `/`-separated relative path. Links and the like are refused. */
function listFiles(directory, relative = "", found = new Map()) {
  for (const entry of readdirSync(join(directory, relative)).sort(byCodeUnits)) {
    const path = relative ? `${relative}/${entry}` : entry;
    const stat = lstatSync(join(directory, path));
    if (stat.isDirectory()) listFiles(directory, path, found);
    else if (stat.isFile()) found.set(path, readFileSync(join(directory, path), "utf8").replace(/\r\n/g, "\n"));
    else throw new Error(`stylesheet debt: ${path} is not a regular file or directory`);
  }
  return found;
}

/**
 * The inventory the directory records, each list sorted, a repeated identity once per occurrence.
 *
 * Fails, naming the path, unless the directory is exactly what `writeInventory` writes for the
 * result: no missing manifest, no stray or misnamed file, no file holding mixed or extra lines.
 */
export function readInventory(directory = INVENTORY_DIRECTORY) {
  const fix = `run \`${REGENERATE_COMMAND}\` instead of editing apps/web/src/stylesheet-debt/ by hand`;
  if (!existsSync(directory)) throw new Error(`stylesheet debt: ${directory} is missing; ${fix}`);
  assertRealDirectory(directory);
  const found = listFiles(directory);
  const manifest = found.get(MANIFEST);
  if (manifest === undefined) throw new Error(`stylesheet debt: ${MANIFEST} is missing; ${fix}`);
  const inventory = {};
  for (const name of manifest.split("\n").filter(Boolean)) {
    assertInventoryName(name);
    inventory[name] = [];
  }
  for (const [path, contents] of found) {
    const [name, entry, ...deeper] = path.split("/");
    // The manifest, nested paths and unlisted directories are left out here; the comparison
    // below reports each one that is not exactly what the regenerator writes.
    if (entry === undefined || deeper.length > 0 || !Object.hasOwn(inventory, name)) continue;
    const lines = contents.split("\n");
    if (lines.pop() !== "" || lines.length === 0 || lines.some((line) => line !== lines[0])) {
      throw new Error(`stylesheet debt: ${path} must repeat one identity, one per line; ${fix}`);
    }
    inventory[name].push(...lines);
  }
  const expected = inventoryFiles(inventory);
  for (const [path, contents] of found) {
    if (expected.get(path) !== contents) {
      throw new Error(`stylesheet debt: ${path} is not a file the regenerator writes ` +
        `(a stray file, a misnamed entry, or an unlisted inventory); ${fix}`);
    }
  }
  for (const path of expected.keys()) {
    if (!found.has(path)) throw new Error(`stylesheet debt: ${path} is missing; ${fix}`);
  }
  for (const name of Object.keys(inventory)) inventory[name].sort(byCodeUnits);
  return inventory;
}

/**
 * Make `directory` hold exactly `inventory`: write what differs, delete every other file, and
 * remove directories left empty. Running it twice on the same tree changes nothing the second time.
 */
export function writeInventory(inventory, directory = INVENTORY_DIRECTORY) {
  const files = inventoryFiles(inventory);
  mkdirSync(directory, { recursive: true });
  // Pruning follows the root, so a linked root would delete files wherever the link points.
  assertRealDirectory(directory);
  const existing = listFiles(directory);
  for (const path of existing.keys()) if (!files.has(path)) rmSync(join(directory, path));
  for (const [path, contents] of files) {
    if (existing.get(path) === contents) continue;
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  }
  removeEmptyDirectories(directory, false);
}

function removeEmptyDirectories(directory, removeSelf) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (lstatSync(path).isDirectory()) removeEmptyDirectories(path, true);
  }
  if (removeSelf && readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
}
