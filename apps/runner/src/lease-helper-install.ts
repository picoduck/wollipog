import { createHash } from "node:crypto";
import { constants, createReadStream, lstatSync, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { collectHelperBytes, findInstalledHelper, helperDigest, installLeaseHelper, LEASE_HELPER_LIMITS, parseHelperAssociation, sameHelperTuple, type HelperAssociation } from "../../../scripts/lease-helper-distribution.mjs";
import { expectedLeaseHelper, windowsLeaseHelperImage } from "./provider-home-lease-assets.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const allowed = new Set(["--parent", "--association", "--association-url", "--association-sha256", "--image", "--image-url", "--image-sha256"]);
function argumentsOf(argv: readonly string[]): Map<string, string> {
  const args = argv.slice(3), result = new Map<string, string>();
  if (args.length > 14 || args.length % 2) throw new Error("invalid bounded installer arguments");
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!, value = args[i + 1]!;
    if (!allowed.has(name) || result.has(name) || !value || value.includes("\0") || Buffer.byteLength(value) > 32768) throw new Error("invalid bounded installer arguments");
    result.set(name, value);
  }
  if (Number(result.has("--association")) + Number(result.has("--association-url")) !== 1 ||
      Number(result.has("--image")) + Number(result.has("--image-url")) > 1) throw new Error("one exact association and producer required");
  return result;
}
function sameRunnerFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function proveRunnerAliases(path: string, stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("runner association identity unavailable");
  if (stat.nlink === 1n) return;
  // Installer compatibility links are a closed, co-located set. This exception applies only
  // to the running executable; helper images/records still require exactly one link.
  const names = process.platform === "win32" ? ["wollipog.exe", "wollipog-runner.exe", "agent-manager-runner.exe"] : ["wollipog", "wollipog-runner", "agent-manager-runner"];
  if (stat.nlink > 3n || !names.includes(basename(path))) throw new Error("unproved runner hardlinks");
  let count = 0;
  for (const name of names) {
    try {
      const alias = lstatSync(join(dirname(path), name), { bigint: true });
      if (!alias.isSymbolicLink() && alias.isFile() && sameRunnerFile(stat, alias)) count++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (BigInt(count) !== stat.nlink) throw new Error("unproved runner hardlinks");
}
export async function runnerAssociationDigest(path: string, signal: AbortSignal): Promise<string> {
  const named = lstatSync(path, { bigint: true }); proveRunnerAliases(path, named);
  const heldFile = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameRunnerFile(named, await heldFile.stat({ bigint: true }))) throw new Error("runner substituted while opening");
    const hash = createHash("sha256"), chunk = Buffer.alloc(65536); let used = 0n;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await heldFile.read(chunk, 0, chunk.length, null);
      signal.throwIfAborted(); if (!bytesRead) break;
      used += BigInt(bytesRead); if (used > named.size) throw new Error("runner grew during association proof");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const held = await heldFile.stat({ bigint: true }), after = lstatSync(path, { bigint: true });
    if (used !== named.size) throw new Error("runner shrank during association proof");
    if (!sameRunnerFile(named, held) || !sameRunnerFile(named, after)) throw new Error("runner changed during association proof");
    proveRunnerAliases(path, after); return hash.digest("hex");
  } finally { await heldFile.close(); }
}
async function responseBytes(urlText: string, signal: AbortSignal): Promise<Readable> {
  if (urlText.length > 4096) throw new Error("helper transport locator limit");
  const url = new URL(urlText);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("helper transport must use HTTPS");
  const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "wollipog-lease-helper-install" };
  // Reuse existing operator access; credentials never enter arguments, records, or diagnostics.
  if (["github.com", "api.github.com"].includes(url.hostname)) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error("helper transport failed; no retry or alternate producer");
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}
function report(value: unknown): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LEASE_HELPER_LIMITS.diagnosticBytes) throw new Error("helper installer response limit");
  process.stdout.write(`${text}\n`);
}

/** Internal pre-daemon entry: no registry, credentials store, canonical HOME, or service startup. */
export async function runLeaseHelperInstall(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const deadline = performance.now() + LEASE_HELPER_LIMITS.producerMs;
  const timer = setTimeout(() => controller.abort(), LEASE_HELPER_LIMITS.producerMs);
  let input: Readable | undefined;
  try {
    const tuple = expectedLeaseHelper();
    if (argv.length === 4 && argv[3] === "--describe") {
      report({ schema: "WPLIM1", helper: tuple, installerMode: "--lease-helper-install", runtimeCacheEntries: 0 }); return 0;
    }
    const args = argumentsOf(argv), publisher = args.get("--association-sha256");
    if (!publisher || !digestPattern.test(publisher)) throw new Error("association publisher digest required");
    let bytes: Buffer;
    if (args.has("--association")) {
      const encoded = args.get("--association")!;
      if (encoded.length > Math.ceil(LEASE_HELPER_LIMITS.contractBytes / 3) * 4) throw new Error("association before-decode bound");
      bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || bytes.length > LEASE_HELPER_LIMITS.contractBytes) throw new Error("invalid association encoding");
    } else {
      input = await responseBytes(args.get("--association-url")!, controller.signal);
      bytes = await collectHelperBytes(input, LEASE_HELPER_LIMITS.contractBytes, deadline); input = undefined;
    }
    if (helperDigest(bytes) !== publisher) throw new Error("runner/helper association publisher mismatch");
    const association: HelperAssociation = parseHelperAssociation(bytes);
    if (!sameHelperTuple(association.helper, tuple) || association.runnerSha256 !== await runnerAssociationDigest(process.execPath, controller.signal)) throw new Error("association does not match this independently built runner");
    if (performance.now() >= deadline) throw new Error("helper producer deadline exceeded before admission");
    if (association.storage === "embedded") {
      if (args.has("--image") || args.has("--image-url") || args.has("--parent")) throw new Error("embedded Windows helper requires no installation producer");
      windowsLeaseHelperImage(); report({ schema: "WPLIM1", target: tuple.target, storage: "embedded", runtimeCacheEntries: 0 }); return 0;
    }
    const parent = args.get("--parent");
    if (!parent || !isAbsolute(parent)) throw new Error("existing absolute helper installation parent required");
    // Completed matching inputs need no transport or allocation even when every slot is occupied.
    try { findInstalledHelper(parent, tuple).verify(); report({ schema: "WPLIM1", target: tuple.target, reused: true, runtimeCacheEntries: 0 }); return 0; } catch { /* admission re-proves all fixed positions */ }
    const imagePublisher = args.get("--image-sha256");
    if (args.has("--image-url") && imagePublisher !== tuple.imageSha256) throw new Error("helper publisher digest disagrees with the association");
    if (args.has("--image")) {
      const path = args.get("--image")!, stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== tuple.imageBytes) throw new Error("local helper producer proof unavailable");
      input = createReadStream(path, { highWaterMark: 65536 });
    } else input = args.has("--image-url") ? await responseBytes(args.get("--image-url")!, controller.signal) : process.stdin;
    controller.signal.addEventListener("abort", () => input?.destroy(new Error("helper producer deadline exceeded")), { once: true });
    await installLeaseHelper(parent, tuple, input, { deadline }); input = undefined;
    report({ schema: "WPLIM1", target: tuple.target, reused: false, runtimeCacheEntries: 0 }); return 0;
  } catch (error) {
    // Never log URL, token, source bytes, native exception contents or an unbounded diagnostic.
    const reason = error instanceof Error && /budget exhausted|inventory unavailable|deadline exceeded/u.test(error.message)
      ? error.message : "helper association, producer or ownership proof unavailable";
    process.stderr.write(`${reason.slice(0, 240)}; preserve occupied positions and request operator inspection; no fallback.\n`);
    return 2;
  } finally { clearTimeout(timer); input?.destroy(); controller.abort(); }
}
