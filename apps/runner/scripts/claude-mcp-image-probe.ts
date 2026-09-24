/**
 * Measure whether a real Claude Code session is shown an image that an MCP tool returns, through
 * the exact `review_descendant_ui_evidence` handler an Orchestrator calls (#1492).
 *
 *   pnpm probe:claude-mcp-image                     # needs a signed-in `claude` on PATH
 *   CLAUDE_BIN=/path/to/claude CLAUDE_PROBE_MODEL=haiku pnpm probe:claude-mcp-image
 *   CLAUDE_PROBE_KEEP=1 pnpm probe:claude-mcp-image   # keep the image and logs for inspection
 *
 * This is NOT part of `pnpm test`: it spawns a real `claude -p`, calls the real model, and takes
 * well under a minute. It is the evidence behind `CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION`, kept
 * runnable so a future Claude Code release is re-measured, not re-argued.
 *
 * The evidence is a PNG of a random code word drawn from a bitmap font. The word appears in no
 * text the model can read — not the prompt, the tool description, the file name, or the receipt
 * text block the tool returns beside the image — so naming it proves the pixels reached the model.
 *
 * The MCP server is the runner's own `serveSessionManagementMcp` with the Orchestrator tool table,
 * launched by Claude Code over stdio exactly as an Orchestrator's is. Only the control plane is
 * stubbed: it answers the delivery and acknowledgement routes for this one image, so the handler's
 * digest check, acknowledgement, and MCP image content all run unmodified. The probe also runs the
 * runner's live Claude discovery against the same binary and reports whether it attests
 * `imageToolResults`, so a verified release and the attested floor can be compared directly.
 */

import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import type { UiEvidenceReviewDelivery } from "@wollipog/protocol";
import { capabilitiesFor } from "../src/catalog.js";
import { CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION, claudeCapabilitiesFromProbe, probeClaudeCode } from "../src/discovery/claude-code.js";
import { run } from "../src/discovery/resolve.js";
import { serveSessionManagementMcp, type McpFetch } from "../src/session-management-mcp.js";

const CLAUDE = process.env.CLAUDE_BIN || "claude";
const MODEL = process.env.CLAUDE_PROBE_MODEL;
const KEEP = process.env.CLAUDE_PROBE_KEEP === "1";
const TURN_TIMEOUT_MS = 180_000;
const TOOL = "mcp__wollipog__review_descendant_ui_evidence";
const REVIEWER = "s_probe_reviewer";
const CHILD = "s_probe_child";
const OCCURRENCE = "wdo_probe";
const EVIDENCE = "screenshot-1";

/** 5×7 glyphs for letters that no other glyph resembles (no B/8, I/1, O/0, S/5, Z/2, G/6, Q, and
 * no V or W, which a small model misreads for U at this resolution). */
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
};

function codeWord(length = 6): string {
  const letters = Object.keys(FONT);
  return Array.from({ length }, () => letters[randomInt(letters.length)]).join("");
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Black-on-white RGB PNG of `word`, with no text chunks: the word exists only as pixels. */
function renderWord(word: string, scale = 12, margin = 3, pitch = 7): Buffer {
  const columns = margin * 2 + word.length * pitch - (pitch - 5);
  const rows = margin * 2 + 7;
  const width = columns * scale;
  const height = rows * scale;
  const ink = (x: number, y: number): boolean => {
    const column = Math.floor(x / scale) - margin;
    const row = Math.floor(y / scale) - margin;
    if (row < 0 || row >= 7 || column < 0) return false;
    const glyph = FONT[word[Math.floor(column / pitch)] ?? ""];
    return glyph?.[row]?.[column % pitch] === "#";
  };
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff);
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 3);
    raw[offset] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      if (ink(x, y)) raw.fill(0x00, offset + 1 + x * 3, offset + 4 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit depth, truecolour RGB, deflate, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

interface Fixture { imagePath: string; ackLog: string }

function receiptFor(sha256: string): UiEvidenceReviewDelivery["receipt"] {
  return {
    receiptId: "uer_probe", occurrenceId: OCCURRENCE, reviewerSessionId: REVIEWER, childSessionId: CHILD,
    policyRevision: 1, evidenceId: EVIDENCE, artifactId: "wfa_probe", sha256, deliveredAt: Date.now(),
  };
}

/** MCP server mode: the runner's real Orchestrator tool table over stdio, stubbing only the two
 * control-plane routes `review_descendant_ui_evidence` calls. */
function serve(fixturePath: string): void {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  const bytes = readFileSync(fixture.imagePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = `http://control-plane.probe.invalid/api/sessions/${REVIEWER}/descendant-requests/review-ui-evidence`;
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch: McpFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (init?.method === "POST" && url === base) {
      if (body.sessionId !== CHILD || body.occurrenceId !== OCCURRENCE || body.evidenceId !== EVIDENCE) {
        return reply(404, { error: "no such pending evidence" });
      }
      const delivery: UiEvidenceReviewDelivery = {
        receipt: receiptFor(sha256), mimeType: "image/png", sizeBytes: bytes.byteLength, data: bytes.toString("base64"),
      };
      return reply(200, delivery);
    }
    if (init?.method === "POST" && url === `${base}/acknowledge`) {
      appendFileSync(fixture.ackLog, `${JSON.stringify(body)}\n`);
      return body.receiptId === "uer_probe" && body.sha256 === sha256
        ? reply(200, { acknowledged: true })
        : reply(409, { error: "receipt mismatch" });
    }
    return reply(404, { error: "not stubbed" });
  };
  serveSessionManagementMcp(process.stdin, process.stdout, {
    fetch, cpUrl: "http://control-plane.probe.invalid", selfSessionId: REVIEWER, token: "", orchestrator: true,
  });
}

function runClaude(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // A hosting Wollipog session's variables would point hooks and tools at the live control plane,
  // and measuring an older release must not update the installation under test.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WOLLIPOG_"))),
    DISABLE_AUTOUPDATER: "1",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), TURN_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function main(): Promise<void> {
  const discovery = await probeClaudeCode((args, timeoutMs) => run(CLAUDE, args, { timeoutMs }), "path");
  const attested = capabilitiesFor("claude-code")
    ? claudeCapabilitiesFromProbe(capabilitiesFor("claude-code")!, discovery).imageToolResults === true
    : false;

  const dir = mkdtempSync(join(tmpdir(), "wollipog-claude-mcp-image-"));
  try {
    const word = codeWord();
    const image = renderWord(word);
    const imagePath = join(dir, "evidence.png");
    const ackLog = join(dir, "acknowledgements.jsonl");
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(imagePath, image);
    writeFileSync(ackLog, "");
    writeFileSync(fixturePath, JSON.stringify({ imagePath, ackLog } satisfies Fixture));
    const mcpConfig = join(dir, "mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: {
        wollipog: {
          type: "stdio",
          command: process.execPath,
          args: ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), "--serve", fixturePath],
        },
      },
    }));
    const prompt = [
      `Call the review_descendant_ui_evidence tool exactly once with sessionId "${CHILD}",`,
      `occurrenceId "${OCCURRENCE}", and evidenceId "${EVIDENCE}".`,
      "The image it returns shows one word in capital letters.",
      "Reply with that word and nothing else. If the tool result contains no image, reply NO IMAGE.",
    ].join(" ");
    const receiptText = JSON.stringify(receiptFor(createHash("sha256").update(image).digest("hex")));
    for (const text of [prompt, receiptText, readFileSync(mcpConfig, "utf8")]) {
      if (text.toUpperCase().includes(word)) throw new Error("the code word leaked into model-visible text");
    }

    const started = Date.now();
    const result = await runClaude([
      "-p", prompt,
      "--output-format", "json",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", TOOL,
      "--no-session-persistence",
      ...(MODEL ? ["--model", MODEL] : []),
    ], dir);
    const acknowledgements = readFileSync(ackLog, "utf8").split("\n").filter(Boolean);
    let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number; modelUsage?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      /* reported below */
    }
    const answer = (parsed.result ?? "").trim();
    const read = answer.toUpperCase().replace(/[^A-Z]/g, "");
    const seen = read === word;
    const summary = {
      claudeVersion: discovery.installedVersion ?? null,
      discoveryStatus: discovery.status,
      attestsImageToolResults: attested,
      attestedFloor: CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION,
      models: Object.keys(parsed.modelUsage ?? {}),
      exitCode: result.code,
      acknowledgedReceipts: acknowledgements.length,
      expected: word,
      answer,
      imageReachedModel: seen,
      // Diagnostic only: a near-miss is a misread image, which a text-only turn cannot produce.
      lettersMatched: [...word].filter((letter, index) => read[index] === letter).length,
      elapsedMs: Date.now() - started,
      costUsd: parsed.total_cost_usd ?? null,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!parsed.result) console.error(result.stderr.slice(-2_000) || result.stdout.slice(-2_000));
    if (!seen || acknowledgements.length !== 1) process.exitCode = 1;
  } finally {
    if (KEEP) console.error(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--serve" && process.argv[3]) serve(process.argv[3]);
else await main();
