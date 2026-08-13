import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  validatePromptImages,
  type AgentContext,
  type PromptImage,
} from "@wollipog/protocol";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface LocalImageInput {
  type: "localImage";
  path: string;
}

export interface StagedPromptImages {
  inputs: LocalImageInput[];
  /** Paths as seen by the owning agent context (useful for diagnostics/tests). */
  paths: string[];
  cleanup: () => Promise<void>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type WslImageCommand = (args: string[], input?: Buffer) => Promise<CommandResult>;

function runWslImageCommand(args: string[], input?: Buffer): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15_000);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 64 * 1024) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", finishReject);
    child.stdin.on("error", finishReject);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) reject(new Error("WSL image staging timed out"));
      else if (code === 0) resolve(result);
      else reject(new Error(result.stderr.trim() || `wsl.exe exited ${code}`));
    });
    child.stdin.end(input);
  });
}

/** Securely stage validated prompt images inside the agent-owning native/WSL context. */
export async function stagePromptImages(
  images: PromptImage[],
  context: AgentContext,
  wslCommand: WslImageCommand = runWslImageCommand,
): Promise<StagedPromptImages> {
  const validation = validatePromptImages(images, CODEX_APP_SERVER_IMAGE_MIME_TYPES);
  if (!validation.ok) throw new Error(validation.error ?? "invalid image attachment");
  if (!images.length) return { inputs: [], paths: [], cleanup: async () => {} };

  if (context.kind === "wsl") return stageWslImages(images, context.distro, wslCommand);
  return stageNativeImages(images);
}

async function stageNativeImages(images: PromptImage[]): Promise<StagedPromptImages> {
  const dir = await mkdtemp(join(tmpdir(), "wollipog-prompt-images-"));
  try {
    await chmod(dir, 0o700);
    const paths: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i]!;
      const path = join(dir, `image-${i + 1}.${MIME_EXT[image.mimeType]}`);
      await writeFile(path, Buffer.from(image.data, "base64"), { flag: "wx", mode: 0o600 });
      paths.push(path);
    }
    let cleaned = false;
    return {
      paths,
      inputs: paths.map((path) => ({ type: "localImage", path })),
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function stageWslImages(
  images: PromptImage[],
  distro: string,
  run: WslImageCommand,
): Promise<StagedPromptImages> {
  const made = await run(["-d", distro, "--exec", "mktemp", "-d", "/tmp/wollipog-prompt-images.XXXXXX"]);
  const dir = made.stdout.trim();
  if (!/^\/tmp\/wollipog-prompt-images\.[A-Za-z0-9]+$/.test(dir)) {
    throw new Error("WSL image staging returned an unsafe temporary path");
  }
  const cleanupDir = async () => {
    await run(["-d", distro, "--exec", "rm", "-rf", "--", dir]).catch(() => {});
  };
  try {
    const paths: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i]!;
      const path = `${dir}/image-${i + 1}.${MIME_EXT[image.mimeType]}`;
      await run(
        ["-d", distro, "--exec", "sh", "-c", 'umask 077; cat > "$1"', "sh", path],
        Buffer.from(image.data, "base64"),
      );
      paths.push(path);
    }
    let cleaned = false;
    return {
      paths,
      inputs: paths.map((path) => ({ type: "localImage", path })),
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await cleanupDir();
      },
    };
  } catch (error) {
    await cleanupDir();
    throw error;
  }
}
