import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SessionEventsResponse, SessionView } from "@wollipog/protocol";
import {
  defaultLocalDeviceTokenPath,
  loadOrCreateLocalDeviceToken,
} from "../../control-plane/src/local-device-credential.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const FAKE_CLAUDE = fileURLToPath(new URL(
  "../../runner/src/drivers/fixtures/fake-claude-code-question.mjs",
  import.meta.url,
));
const FAKE_CODEX = fileURLToPath(new URL(
  "../../runner/src/drivers/fixtures/fake-codex-app-server.mjs",
  import.meta.url,
));
const RUNNER_ID = "agent-question-live-e2e-runner";
const CONTROL_PLANE_TOKEN = "agent-question-live-e2e-control-plane-token";

interface LiveStack {
  httpBase: string;
  ownerToken: string;
  receiptPath: string;
  sessionId: string;
  logs(): string;
  restart(restartRunner?: boolean): Promise<void>;
  stop(): Promise<void>;
}

function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RUNNER_|CONTROL_PLANE_)/u.test(key)) delete env[key];
  }
  return env;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to reserve a loopback port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (
    error ? reject(error) : resolvePromise()
  )));
  return address.port;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    delay(5_000, false),
  ]);
  if (exited) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(3_000),
  ]);
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

async function fetchSession(stack: Pick<LiveStack, "httpBase" | "ownerToken" | "sessionId">): Promise<SessionView> {
  const response = await fetch(
    `${stack.httpBase}/api/sessions/lookup/by-id?${new URLSearchParams({ id: stack.sessionId })}`,
    { headers: { authorization: `Bearer ${stack.ownerToken}` } },
  );
  if (!response.ok) throw new Error(`session lookup failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { session: SessionView }).session;
}

async function fetchEvents(
  stack: Pick<LiveStack, "httpBase" | "ownerToken" | "sessionId">,
): Promise<SessionEventsResponse> {
  const response = await fetch(`${stack.httpBase}/api/sessions/${stack.sessionId}/events`, {
    headers: { authorization: `Bearer ${stack.ownerToken}` },
  });
  if (!response.ok) throw new Error(`event lookup failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<SessionEventsResponse>;
}

async function queuePrompt(
  stack: Pick<LiveStack, "httpBase" | "ownerToken" | "sessionId">,
  text: string,
): Promise<void> {
  const response = await fetch(`${stack.httpBase}/api/sessions/${stack.sessionId}/prompt`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stack.ownerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`prompt queue failed: ${response.status} ${await response.text()}`);
}

async function expectQuestionControlsInsideCard(page: Page): Promise<void> {
  const card = page.getByRole("region", { name: "Agent Questions" });
  const cardRect = await card.evaluate((element) => element.getBoundingClientRect().toJSON());
  const list = page.locator(".question-list");
  const overflow = await list.evaluate((element) => ({
    clientWidth: element.clientWidth,
    overflowY: getComputedStyle(element).overflowY,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollLeft).toBe(0);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(["auto", "visible"]).toContain(overflow.overflowY);
  await expect(card.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' detail-chat ')][1]"))
    .toHaveCount(1);
  await expect(card.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' detail-scroll ')][1]"))
    .toHaveCount(1);
  await expect(page.locator('[data-virtual-kind="timeline"]')).toHaveAttribute("data-virtual-total", "49");
  const initiallyInViewport = await card.evaluate((element) => {
    const scroll = element.closest(".detail-scroll");
    if (!scroll) return true;
    const cardRect = element.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    return cardRect.bottom > scrollRect.top && cardRect.top < scrollRect.bottom;
  });
  expect(initiallyInViewport).toBe(false);
  await card.scrollIntoViewIfNeeded();

  const rects = await page.locator(
    ".question-list, .question-block, .question-text, .question-option, .question-input",
  ).evaluateAll((elements) =>
    elements.map((element) => ({
      className: element.className,
      rect: element.getBoundingClientRect().toJSON(),
    })),
  );
  expect(rects.length).toBeGreaterThan(0);
  for (const { className, rect } of rects) {
    expect(rect.left, `${className} starts inside the question card`).toBeGreaterThanOrEqual(cardRect.left - 0.5);
    expect(rect.right, `${className} ends inside the question card`).toBeLessThanOrEqual(cardRect.right + 0.5);
  }
}

async function startLiveStack(
  provider: "claude" | "codex" = "claude",
  codexScenario: "question" | "dogfood-question" | "async-question" = "question",
  restartRecovery = false,
  asyncDelivery?: "accepted" | "rejected",
  journalFault = false,
): Promise<LiveStack> {
  const port = await reservePort();
  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const temp = mkdtempSync(join(tmpdir(), "wollipog-agent-question-live-e2e-"));
  const databasePath = join(temp, "control-plane.db");
  const workspaceDir = join(temp, "workspace");
  const runnerDataDir = join(temp, "runner-data");
  const runnerHome = join(temp, "home");
  const runnerBin = join(temp, "bin");
  const configPath = join(temp, "runner.config.json");
  const receiptPath = join(temp, "provider-receipt.json");
  const recoveryStatePath = join(temp, "provider-recovery-state.json");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(runnerHome, { recursive: true });
  mkdirSync(runnerBin, { recursive: true });
  if (provider === "codex") {
    mkdirSync(join(runnerHome, ".codex"), { recursive: true });
    writeFileSync(join(runnerHome, ".codex", "auth.json"), "{}");
  }
  const fakeClaudeCommand = join(runnerBin, process.platform === "win32" ? "claude.cmd" : "claude");
  const fakeCodexCommand = join(runnerBin, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32") {
    writeFileSync(fakeClaudeCommand, `@\"${process.execPath}\" \"${FAKE_CLAUDE}\" %*\r\n`);
    writeFileSync(fakeCodexCommand, `@\"${process.execPath}\" \"${FAKE_CODEX}\" %*\r\n`);
  } else {
    copyFileSync(FAKE_CLAUDE, fakeClaudeCommand);
    chmodSync(fakeClaudeCommand, 0o755);
    copyFileSync(FAKE_CODEX, fakeCodexCommand);
    chmodSync(fakeCodexCommand, 0o755);
  }

  const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));

  let controlPlaneOutput = "";
  let runnerOutput = "";
  let controlPlane: ChildProcess | null = null;
  let runner: ChildProcess | null = null;
  const captureControlPlane = (chunk: unknown) => {
    controlPlaneOutput = (controlPlaneOutput + String(chunk)).slice(-65_536);
  };
  const captureRunner = (chunk: unknown) => {
    runnerOutput = (runnerOutput + String(chunk)).slice(-65_536);
  };
  const spawnControlPlane = () => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...hermeticEnv(),
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath,
        CONTROL_PLANE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", captureControlPlane);
    child.stderr?.on("data", captureControlPlane);
    controlPlane = child;
    return child;
  };
  const runnerEnv = () => ({
    ...hermeticEnv(),
    HOME: runnerHome,
    USERPROFILE: runnerHome,
    XDG_CONFIG_HOME: join(runnerHome, ".config"),
    XDG_DATA_HOME: join(runnerHome, ".local", "share"),
    XDG_STATE_HOME: join(runnerHome, ".local", "state"),
    PATH: `${runnerBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    XDG_CACHE_HOME: join(runnerHome, ".cache"),
    ...(journalFault ? { WOLLIPOG_TEST_JOURNAL_FAULT_MARKER: receiptPath + ".journal-fault" } : {}),
  });
  const spawnRunner = () => {
    const imports = journalFault ? ["--import", fileURLToPath(new URL("./fixtures/async-answer-journal-fault.ts", import.meta.url))] : [];
    const child = spawn(process.execPath, ["--import", "tsx", ...imports, "apps/runner/src/cli.ts", "--config", configPath], {
      cwd: REPO_ROOT,
      env: runnerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", captureRunner);
    child.stderr?.on("data", captureRunner);
    runner = child;
    return child;
  };
  const logs = () => `=== CONTROL PLANE ===\n${controlPlaneOutput}\n=== RUNNER ===\n${runnerOutput}`;
  const stop = async () => {
    await stopChild(runner);
    await stopChild(controlPlane);
    rmSync(temp, { recursive: true, force: true });
  };

  try {
    const initialControlPlane = spawnControlPlane();
    await waitForHealth(httpBase, initialControlPlane, logs);
    const credentialResponse = await fetch(`${httpBase}/api/runner-credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runnerId: RUNNER_ID, label: "Agent Question Live E2E" }),
    });
    if (credentialResponse.status !== 201) {
      throw new Error(`runner credential creation failed: ${credentialResponse.status}\n${logs()}`);
    }
    const runnerToken = ((await credentialResponse.json()) as { token: string }).token;

    const agent = provider === "codex"
      ? {
          id: "codex-question",
          name: "Codex Question E2E",
          command: "codex",
          driver: "codex-app-server",
          context: { kind: "native" },
          env: {
            WOLLIPOG_FAKE_CODEX_SCENARIO: codexScenario,
            WOLLIPOG_FAKE_CODEX_RECEIPT: receiptPath,
            ...(asyncDelivery ? {
              WOLLIPOG_FAKE_CODEX_ASYNC_DELIVERY: asyncDelivery,
              WOLLIPOG_FAKE_CODEX_ASYNC_RELEASE: receiptPath + ".release",
            } : {}),
            ...(restartRecovery ? { WOLLIPOG_FAKE_QUESTION_STATE: recoveryStatePath } : {}),
          },
        }
      : {
          id: "claude-question",
          name: "Claude Question E2E",
          command: fakeClaudeCommand,
          driver: "claude-code",
          context: { kind: "native" },
          env: {
            WOLLIPOG_CLAUDE_PERSISTENT: "1",
            WOLLIPOG_FAKE_CLAUDE_RECEIPT: receiptPath,
            ...(restartRecovery ? { WOLLIPOG_FAKE_QUESTION_STATE: recoveryStatePath } : {}),
          },
        };
    writeFileSync(configPath, JSON.stringify({
      runnerId: RUNNER_ID,
      controlPlaneUrl: `${wsBase}/runner`,
      token: runnerToken,
      dataDir: runnerDataDir,
      workspaces: [{ id: "repo", name: "Repo", path: workspaceDir }],
      agents: [agent],
    }));

    const initialRunner = spawnRunner();

    let sessionId = "";
    let lastCreateFailure = "";
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (initialRunner.exitCode !== null) throw new Error(`runner exited before registering\n${logs()}`);
      const created = await fetch(`${httpBase}/api/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          runnerId: RUNNER_ID,
          workspaceId: "repo",
          agentId: provider === "codex" ? "codex-question" : "claude-question",
          prompt: provider === "codex" ? "Ask the Codex release questions" : "Ask the release questions",
          useWorktree: false,
          config: { permissionMode: provider === "codex" ? "on-request" : "default" },
        }),
      });
      if (created.status === 201) {
        sessionId = ((await created.json()) as SessionView).id;
        break;
      }
      lastCreateFailure = `${created.status} ${await created.text()}`;
      await delay(100);
    }
    if (!sessionId) throw new Error(`session was never created (${lastCreateFailure})\n${logs()}`);

    const restart = async (restartRunner = true) => {
      if (restartRunner) {
        await stopChild(runner);
        runner = null;
      }
      await stopChild(controlPlane);
      controlPlane = null;
      const restartedControlPlane = spawnControlPlane();
      await waitForHealth(httpBase, restartedControlPlane, logs);
      const restartedRunner = restartRunner ? spawnRunner() : runner!;
      let lastSession: SessionView | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const session = await fetchSession({ httpBase, ownerToken, sessionId });
        lastSession = session;
        if (!restartRunner && asyncDelivery && session.pendingApproval === null &&
            session.queued?.length === 1) return;
        if (asyncDelivery && session.pendingApproval === null && existsSync(receiptPath)) return;
        if (session.pendingApproval?.kind === "question" && (
          codexScenario === "async-question"
            ? session.pendingApproval.async === true && session.status === "idle"
            : session.pendingApproval.recoveryReason === "provider_restart" &&
              session.pendingApproval.recoveryAction === "resume_answer"
        )) return;
        if (restartedRunner.exitCode !== null) throw new Error(`runner exited during restart recovery\n${logs()}`);
        await delay(100);
      }
      throw new Error(`recovered question never became resumable: ${JSON.stringify(lastSession)}\n${logs()}`);
    };
    const stack = { httpBase, ownerToken, receiptPath, sessionId, logs, restart, stop };
    // An async question arrives mid-turn, and the turn's completion reaches the control plane as a
    // separate update, so a question alone is not settled yet. Delivery runs hold the turn open.
    const awaitIdle = codexScenario === "async-question" && !asyncDelivery;
    let lastSession: SessionView | null = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const session = await fetchSession(stack);
      lastSession = session;
      if (session.pendingApproval?.kind === "question" && (
        !awaitIdle || (session.pendingApproval.async === true && session.status === "idle")
      )) return stack;
      if (session.status === "failed") {
        throw new Error(`session failed before asking a question: ${JSON.stringify(session)}\n` +
          `events: ${JSON.stringify(await fetchEvents(stack))}\n${logs()}`);
      }
      await delay(100);
    }
    throw new Error(`${provider === "codex" ? "Codex" : "Claude"} question never reached the control plane` +
      `${awaitIdle ? " with the session idle" : ""}\n` +
      `session: ${JSON.stringify(lastSession)}\nevents: ${JSON.stringify(await fetchEvents(stack))}\n${logs()}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

for (const style of ["interactive", "composer"] as const) test(`Claude AskUserQuestion answers cross the live stack in ${style} style`, async ({ page }) => {
  test.setTimeout(120_000);
  const stack = await startLiveStack();
  try {
    const pending = await fetchSession(stack);
    expect(pending.pendingApproval).toMatchObject({
      kind: "question",
      requestId: "live-question-1",
    });

    const fragment = new URLSearchParams({
      origin: stack.httpBase,
      token: stack.ownerToken,
      sessionId: stack.sessionId,
    });
    await page.addInitScript((responseStyle) => {
      localStorage.setItem("wollipog.question-response-style", responseStyle);
    }, style);
    await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);

    await expect(page.getByRole("region", { name: "Agent Questions" })).toBeVisible();
    if (style === "interactive") {
      const submit = page.getByRole("button", { name: "Submit" });
      await expect(submit).toBeDisabled();
      await page.getByRole("radio", { name: /Canary/ }).click();
      await expect(submit).toBeDisabled();
      await page.getByRole("checkbox", { name: /Unit Tests/ }).click();
      await page.getByRole("checkbox", { name: /Browser Tests/ }).click();
      await expect(submit).toBeEnabled();
      await submit.click();
    } else {
      const response = page.locator(".composer-answer-input");
      await response.fill("1");
      await response.press("Enter");
      await response.fill("1, 2");
      await response.press("Enter");
    }
    await expect(page.getByText("Question Answered", { exact: true })).toBeVisible();

    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(stack.receiptPath, "utf8"));
      } catch {
        return null;
      }
    }, { timeout: 30_000 }).toEqual({
      requestId: "live-question-1",
      behavior: "allow",
      answers: {
        "Which rollout strategy should we use?": "Canary",
        "Which checks should run before promotion?": ["Unit Tests", "Browser Tests"],
      },
    });

    await expect.poll(async () => (await fetchSession(stack)).pendingApproval, {
      timeout: 30_000,
    }).toBeNull();
    await expect.poll(async () => (await fetchSession(stack)).status, {
      timeout: 30_000,
    }).toBe("idle");
    await expect.poll(async () => (await fetchSession(stack)).preview, {
      timeout: 30_000,
    }).toContain("Question answers received by Claude Code.");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stack.logs()}`);
  } finally {
    await stack.stop();
  }
});

for (const style of ["interactive", "composer"] as const) test(`Codex structured questions cross the live stack in ${style} style`, async ({ page }) => {
  test.setTimeout(120_000);
  const stack = await startLiveStack("codex");
  try {
    const pending = await fetchSession(stack);
    expect(pending.pendingApproval).toMatchObject({
      kind: "question",
      requestId: "live-codex-question-1",
    });

    const fragment = new URLSearchParams({
      origin: stack.httpBase,
      token: stack.ownerToken,
      sessionId: stack.sessionId,
    });
    await page.addInitScript((responseStyle) => {
      localStorage.setItem("wollipog.question-response-style", responseStyle);
    }, style);
    await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);

    await expect(page.getByRole("region", { name: "Agent Questions" })).toBeVisible();
    if (style === "interactive") {
      const submit = page.getByRole("button", { name: "Submit" });
      await expect(submit).toBeDisabled();
      await page.getByRole("radio", { name: /Staging/ }).click();
      await page.getByRole("textbox", { name: /Release Note/ }).fill("Ship after checks pass");
      await expect(submit).toBeEnabled();
      await submit.click();
    } else {
      const response = page.locator(".composer-answer-input");
      await response.fill("1");
      await response.press("Enter");
      await response.fill("Ship after checks pass");
      await response.press("Enter");
    }
    await expect(page.getByText("Question Answered", { exact: true })).toBeVisible();

    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(stack.receiptPath, "utf8"));
      } catch {
        return null;
      }
    }, { timeout: 30_000 }).toEqual({
      requestId: "live-codex-question-1",
      result: {
        answers: {
          environment: { answers: ["Staging"] },
          note: { answers: ["Ship after checks pass"] },
        },
      },
    });

    await expect.poll(async () => (await fetchSession(stack)).pendingApproval, {
      timeout: 30_000,
    }).toBeNull();
    await expect.poll(async () => (await fetchSession(stack)).status, {
      timeout: 30_000,
    }).toBe("idle");
    await expect.poll(async () => (await fetchSession(stack)).preview, {
      timeout: 30_000,
    }).toContain("Question answers received by Codex.");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stack.logs()}`);
  } finally {
    await stack.stop();
  }
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) test(`Codex async question remains answerable after continued work on ${viewport.name}`, async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(viewport);
  const stack = await startLiveStack("codex", "async-question");
  try {
    // Question and turn completion arrive separately; asking is not proof work has settled.
    await expect.poll(async () => (await fetchSession(stack)).status, { timeout: 30_000 }).toBe("idle");
    const pending = await fetchSession(stack);
    expect(pending.status).toBe("idle");
    expect(pending.pendingApproval).toMatchObject({
      kind: "question", async: true, requestId: "codex-async:async-ask",
    });
    const events = await fetchEvents(stack);
    const kinds = events.events.map((event) => event.payload.kind);
    expect(kinds.filter((kind) => kind === "agent_message")).toHaveLength(1);
    expect(kinds.indexOf("question_request")).toBeLessThan(kinds.indexOf("tool_call"));
    expect(events.events.find((event) => event.payload.kind === "question_request")?.payload).toMatchObject({ async: true });

    const fragment = new URLSearchParams({
      origin: stack.httpBase, token: stack.ownerToken,
      sessionId: stack.sessionId, actualAsyncMessage: "1",
    });
    await page.addInitScript(() => localStorage.setItem("wollipog.question-response-style", "interactive"));
    await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);
    await expect(page.locator(".tl-agent-msg")).toHaveCount(1);
    await expect(page.locator(".tl-agent-msg")).toContainText("I will keep investigating.");
    const card = page.getByRole("region", { name: "Agent Questions" });
    await expect(card).toContainText("Async Agent Question");
    await page.reload();
    await expect(card).toContainText("Async Agent Question");
    if (viewport.name === "desktop") {
      await stack.restart();
      await page.reload();
      await expect(card).toContainText("Async Agent Question");
    }
    const evidenceDir = process.env.WOLLIPOG_ISSUE_1602_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await page.screenshot({ path: join(evidenceDir, `async-question-${viewport.name}-${theme}.png`) });
      }
    }
    await card.getByRole("radio", { name: "Patch" }).click();
    await card.getByRole("button", { name: "Submit" }).click();
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(stack.receiptPath, "utf8")); }
      catch { return null; }
    }, { timeout: 30_000 }).toEqual({ requestId: "codex-async:async-ask", answer: "Patch" });
    await expect.poll(async () => (await fetchSession(stack)).pendingApproval).toBeNull();
    await expect.poll(async () => (await fetchSession(stack)).preview).toContain("Async answer received by Codex.");
    if (evidenceDir) {
      await page.screenshot({ path: join(evidenceDir, `async-answer-${viewport.name}-light.png`) });
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n` +
      `session: ${JSON.stringify(await fetchSession(stack))}\n` +
      `events: ${JSON.stringify((await fetchEvents(stack)).events.map((event) => event.payload))}\n${stack.logs()}`);
  } finally {
    await stack.stop();
  }
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(`Async Answer Delivery on ${viewport.name}`, () => {
    const evidenceDir = process.env.WOLLIPOG_ISSUE_2340_EVIDENCE_DIR ?? process.env.WOLLIPOG_ISSUE_2306_EVIDENCE_DIR;
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
    });
    for (const delivery of ["accepted", "rejected", "journal"] as const) {
      test(`running async answers ${delivery === "accepted" ? "steer automatically" : delivery === "journal" ? "recover from journal failure" : "stay queued"} without reopening`, async ({ page: fixturePage, browser, baseURL }) => {
        test.setTimeout(180_000);
        const recording = evidenceDir ? await browser.newContext({
          baseURL,
          viewport: { width: viewport.width, height: viewport.height },
          recordVideo: { dir: evidenceDir, size: { width: viewport.width, height: viewport.height } },
        }) : null;
        const page = recording ? await recording.newPage() : fixturePage;
        const stack = await startLiveStack("codex", "async-question", false,
          delivery === "journal" ? "accepted" : delivery, delivery === "journal");
        const prefix = `${delivery}-${viewport.name}`;
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const beat = async (milliseconds: number) => {
          if (evidenceDir) await page.waitForTimeout(milliseconds);
        };
        const capture = async (stage: string) => {
          if (!evidenceDir) return;
          mkdirSync(evidenceDir, { recursive: true });
          for (const theme of ["dark", "light"] as const) {
            await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
            await page.screenshot({ path: join(evidenceDir, `${prefix}-${stage}-${theme}.png`) });
          }
          await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        };
        try {
          expect((await fetchSession(stack)).status).toBe("running");
          const fragment = new URLSearchParams({
            origin: stack.httpBase, token: stack.ownerToken, sessionId: stack.sessionId,
            actualAsyncMessage: "1", queued: "1", liveQueue: "1",
          });
          await page.addInitScript(() => localStorage.setItem("wollipog.question-response-style", "composer"));
          await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);
          const answer = page.locator(".composer-answer-input");
          await expect(answer).toBeVisible();
          await capture("before");
          await beat(2_500);
          await answer.fill("1");
          await beat(1_500);
          await page.getByRole("button", { name: "Submit Answers" }).click();
          await expect(answer).toHaveCount(0);
          await expect(page.locator(".composer-input")).toBeVisible();
          if (delivery === "journal") {
            await expect.poll(async () => existsSync(stack.receiptPath + ".journal-fault")).toBe(true);
            await expect.poll(async () => stack.logs()).toContain('"event":"async_answer_journal_recovery"');
            expect(existsSync(stack.receiptPath + ".steer")).toBe(false);
          } else {
            await expect.poll(async () => existsSync(stack.receiptPath + ".steer")).toBe(true);
          }
          await expect.poll(async () => (await fetchSession(stack)).pendingApproval).toBeNull();
          await expect.poll(async () => (await fetchSession(stack)).queued?.length ?? 0)
            .toBe(delivery === "accepted" ? 0 : 1);
          await page.reload();
          await expect(answer).toHaveCount(0);
          await expect(page.getByRole("region", { name: "Agent Questions" })).toHaveCount(0);
          await expect(page.locator(".composer-input")).toBeVisible();
          if (delivery !== "accepted") {
            await expect(page.locator(".queue-row")).toHaveCount(1);
            await expect(page.locator(".queue-row")).toContainText("Answer: Patch");
            expect(existsSync(stack.receiptPath)).toBe(false);
          } else {
            expect(JSON.parse(await readFile(stack.receiptPath, "utf8"))).toMatchObject({ delivery: "steer", answer: "Patch" });
            expect((await fetchSession(stack)).status).toBe("running");
          }
          await capture("after");
          await beat(3_000);
          if (delivery !== "accepted") {
            // Reconnect the live runner to a restarted CP while delivery remains queued.
            // Journal tests separately prove replay after a runner process is lost.
            await stack.restart(false);
            await page.reload();
            await expect(answer).toHaveCount(0);
            await expect(page.locator(".queue-row")).toHaveCount(1);
            writeFileSync(stack.receiptPath + ".release", "release");
            await expect.poll(async () => existsSync(stack.receiptPath)).toBe(true);
            expect(JSON.parse(await readFile(stack.receiptPath, "utf8"))).toMatchObject({ delivery: "queue", answer: "Patch" });
          } else {
            writeFileSync(stack.receiptPath + ".release", "release");
          }
          await expect.poll(async () => (await fetchSession(stack)).status).toBe("idle");
          expect(errors).toEqual([]);
          if (evidenceDir) {
            await beat(3_000);
            const video = page.video();
            await page.close();
            await video?.saveAs(join(evidenceDir, `${prefix}.webm`));
          }
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stack.logs()}`);
        } finally {
          await stack.stop();
          await recording?.close();
        }
      });
    }
  });
}

test("an async answer refused by a full queue can be resubmitted safely", async ({ page }) => {
  test.setTimeout(180_000);
  const stack = await startLiveStack("codex", "async-question", false, "accepted");
  let liveQueue: NonNullable<SessionView["queued"]> = [];
  const socket = new WebSocket(`${stack.httpBase.replace("http:", "ws:")}/ui?token=${stack.ownerToken}`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const session = message.type === "snapshot"
      ? message.sessions.find((candidate: SessionView) => candidate.id === stack.sessionId)
      : message.type === "session_upsert" ? message.session : null;
    if (session?.id === stack.sessionId) liveQueue = session.queued ?? [];
  });
  try {
    const occurrence = (await fetchSession(stack)).pendingApproval!.occurrenceId;
    for (let index = 0; index < 100; index += 1) await queuePrompt(stack, `Queued work ${index}`);
    await expect.poll(() => liveQueue.length).toBe(100);
    const fragment = new URLSearchParams({ origin: stack.httpBase, token: stack.ownerToken,
      sessionId: stack.sessionId, actualAsyncMessage: "1" });
    await page.addInitScript(() => localStorage.setItem("wollipog.question-response-style", "composer"));
    await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);
    await page.locator(".composer-answer-input").fill("1");
    await page.getByRole("button", { name: "Submit Answers" }).click();
    await expect.poll(async () => (await fetchSession(stack)).pendingPrompts
      ?.find((prompt) => prompt.errorCode === "QUEUE_FULL")?.state).toBe("failed");
    await expect.poll(async () => (await fetchSession(stack)).pendingApproval?.occurrenceId).toBe(occurrence);
    expect(existsSync(stack.receiptPath)).toBe(false);
    await page.reload();
    await expect(page.locator(".composer-answer-input")).toBeVisible();
    const queuedId = liveQueue.find((prompt) =>
      prompt.durableDeliveryState !== "failed")!.id;
    const cancelled = await fetch(`${stack.httpBase}/api/sessions/${stack.sessionId}/cancel-queued`, {
      method: "POST", headers: { authorization: `Bearer ${stack.ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ promptId: queuedId }),
    });
    expect(cancelled.status).toBe(204);
    await expect.poll(() => liveQueue.some((prompt) => prompt.id === queuedId &&
      prompt.durableDeliveryState !== "failed")).toBe(false);
    await page.locator(".composer-answer-input").fill("1");
    await page.getByRole("button", { name: "Submit Answers" }).click();
    await expect.poll(async () => existsSync(stack.receiptPath)).toBe(true);
    expect(JSON.parse(await readFile(stack.receiptPath, "utf8"))).toMatchObject({ delivery: "steer", answer: "Patch" });
    await expect.poll(async () => (await fetchSession(stack)).pendingApproval).toBeNull();
    await page.reload();
    await expect(page.locator(".composer-answer-input")).toHaveCount(0);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stack.logs()}`);
  } finally { socket.close(); await stack.stop(); }
});

for (const provider of ["claude", "codex"] as const) {
  for (const style of ["interactive", "composer"] as const) {
    for (const viewport of [
      { name: "desktop", width: 1280, height: 800 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      test(`${provider} recovered questions resume exactly once in ${style} style on ${viewport.name}`, async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const stack = await startLiveStack(provider, "question", true);
        try {
          await stack.restart();
          const recovered = await fetchSession(stack);
          expect(recovered.pendingApproval).toMatchObject({
            kind: "question",
            requestId: provider === "claude" ? "live-question-1" : "live-codex-question-1",
            recoveryReason: "provider_restart",
            recoveryAction: "resume_answer",
          });

          const fragment = new URLSearchParams({
            origin: stack.httpBase,
            token: stack.ownerToken,
            sessionId: stack.sessionId,
          });
          await page.addInitScript((responseStyle) => {
            localStorage.setItem("wollipog.question-response-style", responseStyle);
          }, style);
          await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);

          const card = page.getByRole("region", { name: "Agent Questions" });
          await expect(card).toBeVisible();
          await expect(card).toHaveCount(1);
          await expect(page.getByText("Agent Question Recovery Required")).toBeVisible();
          await expect(page.getByText(/resume the existing agent conversation and deliver these answers once/)).toBeVisible();
          if (style === "interactive") {
            const submit = page.getByRole("button", { name: "Submit" });
            if (provider === "claude") {
              await page.getByRole("radio", { name: /Canary/ }).click();
              await page.getByRole("checkbox", { name: /Unit Tests/ }).click();
              await page.getByRole("checkbox", { name: /Browser Tests/ }).click();
            } else {
              await page.getByRole("radio", { name: /Staging/ }).click();
              await page.getByRole("textbox", { name: /Release Note/ }).fill("Ship after checks pass");
            }
            await expect(submit).toBeEnabled();
            await submit.scrollIntoViewIfNeeded();
            await expect(submit).toBeInViewport();
            await submit.click();
          } else {
            const response = page.locator(".composer-answer-input");
            await expect(response).toBeVisible();
            await response.fill("1");
            await response.press("Enter");
            await response.fill(provider === "claude" ? "1, 2" : "Ship after checks pass");
            await response.press("Enter");
          }
          await expect(page.getByText("Question Answered", { exact: true })).toBeVisible();

          const requestId = provider === "claude" ? "live-question-1" : "live-codex-question-1";
          const expectedAnswers = provider === "claude"
            ? {
                "Which rollout strategy should we use?": "Canary",
                "Which checks should run before promotion?": ["Unit Tests", "Browser Tests"],
              }
            : { environment: "Staging", note: "Ship after checks pass" };
          await expect.poll(async () => {
            try {
              return JSON.parse(await readFile(stack.receiptPath, "utf8"));
            } catch {
              return null;
            }
          }, { timeout: 30_000 }).toEqual({
            requestId,
            recovered: true,
            answers: expectedAnswers,
            initialQuestions: 1,
            recoveryTurns: 1,
          });
          await expect.poll(async () => (await fetchSession(stack)).status, {
            timeout: 30_000,
          }).toBe("idle");
          await expect.poll(async () => (await fetchSession(stack)).preview, {
            timeout: 30_000,
          }).toContain(`Recovered question answers received by ${provider === "claude" ? "Claude Code" : "Codex"}.`);

          const events = await fetchEvents(stack);
          const requests = events.events.filter((event) =>
            event.payload.kind === "question_request" && event.payload.requestId === requestId);
          const resolutions = events.events.filter((event) =>
            event.payload.kind === "question_resolved" && event.payload.requestId === requestId);
          expect(requests).toHaveLength(1);
          expect(resolutions).toHaveLength(1);
          expect(resolutions[0]?.payload).toMatchObject({
            kind: "question_resolved",
            requestId,
          });
          expect((resolutions[0]?.payload as { commandId?: string }).commandId).toBeTruthy();
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stack.logs()}`);
        } finally {
          await stack.stop();
        }
      });
    }
  }
}

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844, touch: true },
  { name: "mobile landscape", width: 844, height: 390, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
]) {
  test.describe(viewport.name, () => {
    test.use({
      hasTouch: viewport.touch,
      viewport: { width: viewport.width, height: viewport.height },
    });

    test(`Codex dogfood approval resolves its exact live request on ${viewport.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      const stack = await startLiveStack("codex", "dogfood-question");
      try {
        const queuedMessages = [
          "Keep this long message queued until both structured questions are answered.",
          "The complete two-question form must remain visible and reachable above the composer.",
        ];
        for (const message of queuedMessages) await queuePrompt(stack, message);

        const pending = await fetchSession(stack);
        expect(pending.pendingApproval).toMatchObject({
          kind: "question",
          requestId: "5",
          questions: [
            {
              id: "merge_pr_342",
              header: "Merge PR",
              question: "Should I squash-merge pull request #342 now?",
              allowOther: true,
              inputFormat: "text",
              options: [
                { label: "Merge Now (Recommended)", description: "Squash-merge the pull request now." },
                { label: "Leave Open", description: "Leave the pull request open." },
              ],
            },
            {
              id: "delete_remote_branch",
              header: "Delete Branch",
              question: "Should I delete the remote branch after merging?",
              allowOther: true,
              inputFormat: "text",
              options: [
                { label: "Delete Branch (Recommended)", description: "Delete the remote branch after merging." },
                { label: "Keep Branch", description: "Keep the remote branch." },
              ],
            },
          ],
        });

        const fragment = new URLSearchParams({
          origin: stack.httpBase,
          token: stack.ownerToken,
          sessionId: stack.sessionId,
          queued: "1",
        });
        await page.goto(`/agent-questions-live-e2e.html#${fragment.toString()}`);
        await page.reload();

        const submit = page.getByRole("button", { name: "Submit" });
        const mergeNow = page.getByRole("radio", { name: /Merge Now \(Recommended\)/ });
        const leaveOpen = page.getByRole("radio", { name: /Leave Open/ });
        const deleteBranch = page.getByRole("radio", { name: /Delete Branch \(Recommended\)/ });
        const keepBranch = page.getByRole("radio", { name: /Keep Branch/ });
        const otherResponses = page.getByLabel("Other Response");
        await expect(page.getByRole("region", { name: "Agent Questions" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Agent Questions" })).toHaveCount(1);
        await expect(page.locator(".tl-question")).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Agent Questions" })
          .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' detail-scroll ')][1]"))
          .toHaveCount(1);
        await expect(page.getByLabel("Queued Messages").locator(".queue-row")).toHaveCount(queuedMessages.length);
        await expect(page.getByLabel("Queued Messages").locator(".queue-text")).toHaveText(queuedMessages);
        await expectQuestionControlsInsideCard(page);
        await expect(page.getByRole("region", { name: "Agent Questions" })
          .getByText("Should I squash-merge pull request #342 now?", { exact: false })).toBeVisible();
        await expect(mergeNow).toBeVisible();
        await expect(leaveOpen).toBeVisible();
        await expect(mergeNow).toBeInViewport();
        await expect(leaveOpen).toBeInViewport();
        await expect(otherResponses).toHaveCount(2);
        await expect(submit).toBeDisabled();

        await otherResponses.nth(0).fill("Merge after another review");
        await expect(submit).toBeDisabled();
        await mergeNow.focus();
        await page.keyboard.press("Space");
        await expect(mergeNow).toHaveAttribute("aria-checked", "true");
        await expect(otherResponses.nth(0)).toHaveValue("");
        await expect(submit).toBeDisabled();

        await deleteBranch.scrollIntoViewIfNeeded();
        await expect(page.getByRole("region", { name: "Agent Questions" })
          .getByText("Should I delete the remote branch after merging?", { exact: false })).toBeVisible();
        await expect(deleteBranch).toBeVisible();
        await expect(keepBranch).toBeVisible();
        await keepBranch.scrollIntoViewIfNeeded();
        await expect(deleteBranch).toBeInViewport();
        await expect(keepBranch).toBeInViewport();
        await otherResponses.nth(1).fill("Keep it for a follow-up");
        if (viewport.touch) await deleteBranch.tap();
        else await deleteBranch.click();
        await expect(deleteBranch).toHaveAttribute("aria-checked", "true");
        await expect(otherResponses.nth(1)).toHaveValue("");
        await expect(submit).toBeEnabled();
        if (viewport.touch) await submit.tap();
        else await submit.click();
        await expect(page.getByText("Question Answered", { exact: true })).toBeVisible();

        await expect.poll(async () => {
          try {
            return JSON.parse(await readFile(stack.receiptPath, "utf8"));
          } catch {
            return null;
          }
        }, { timeout: 30_000 }).toEqual({
          requestId: 5,
          result: {
            answers: {
              merge_pr_342: { answers: ["Merge Now (Recommended)"] },
              delete_remote_branch: { answers: ["Delete Branch (Recommended)"] },
            },
          },
        });

        await expect.poll(async () => (await fetchSession(stack)).pendingApproval, {
          timeout: 30_000,
        }).toBeNull();
        await expect.poll(async () => (await fetchSession(stack)).status, {
          timeout: 30_000,
        }).toBe("idle");
        await expect.poll(async () => (await fetchSession(stack)).preview, {
          timeout: 30_000,
        }).toContain("Queued prompt delivered after the questions.");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stack.logs()}`);
      } finally {
        await stack.stop();
      }
    });
  });
}

for (const provider of ["claude", "codex"] as const) {
  for (const style of ["interactive", "composer"] as const) {
    test(`${provider} ${style} custom text reaches the provider under its question request (#1595)`, async ({ page }) => {
      test.setTimeout(120_000);
      const stack = await startLiveStack(provider);
      try {
        const fragment = new URLSearchParams({ origin: stack.httpBase, token: stack.ownerToken, sessionId: stack.sessionId });
        await page.addInitScript((value) => localStorage.setItem("wollipog.question-response-style", value), style);
        await page.goto(`/agent-questions-live-e2e.html#${fragment}`);
        const answers = provider === "claude" ? ["Regional canary", "Unit Tests"] : ["Canary", "Custom release note"];
        if (style === "interactive") {
          const inputs = page.locator('.question-input');
          await expect(inputs).toHaveCount(2);
          await inputs.nth(0).fill(answers[0]!);
          await inputs.nth(1).fill(answers[1]!);
          await page.getByRole("button", { name: "Submit", exact: true }).click();
        } else {
          const input = page.locator('.composer-answer-input');
          await page.getByRole("button", { name: "Other Response", exact: true }).click();
          await input.fill(answers[0]!);
          await input.press("Enter");
          if (provider === "claude") await page.getByRole("button", { name: "Other Response", exact: true }).click();
          await input.fill(answers[1]!);
          await input.press("Enter");
        }
        await expect(page.getByText("Question Answered", { exact: true })).toBeVisible();
        await expect.poll(async () => {
          try { return JSON.parse(await readFile(stack.receiptPath, "utf8")); } catch { return null; }
        }, { timeout: 30_000 }).toMatchObject(provider === "claude" ? {
          requestId: "live-question-1", behavior: "allow", answers: {
            "Which rollout strategy should we use?": answers[0], "Which checks should run before promotion?": answers[1],
          },
        } : {
          requestId: "live-codex-question-1", result: { answers: { environment: { answers: [answers[0]] }, note: { answers: [answers[1]] } } },
        });
        await expect.poll(async () => (await fetchSession(stack)).pendingApproval).toBeNull();
      } finally { await stack.stop(); }
    });
  }
}
