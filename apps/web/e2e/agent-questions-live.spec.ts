import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  restart(): Promise<void>;
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
  codexScenario: "question" | "dogfood-question" = "question",
  restartRecovery = false,
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
  const fakeClaudeCommand = join(runnerBin, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    writeFileSync(fakeClaudeCommand, `@\"${process.execPath}\" \"${FAKE_CLAUDE}\" %*\r\n`);
  } else {
    copyFileSync(FAKE_CLAUDE, fakeClaudeCommand);
    chmodSync(fakeClaudeCommand, 0o755);
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
  });
  const spawnRunner = () => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts", "--config", configPath], {
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
          command: process.execPath,
          args: [FAKE_CODEX, codexScenario],
          driver: "codex-app-server",
          context: { kind: "native" },
          env: {
            WOLLIPOG_FAKE_CODEX_RECEIPT: receiptPath,
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

    const restart = async () => {
      await stopChild(runner);
      runner = null;
      await stopChild(controlPlane);
      controlPlane = null;
      const restartedControlPlane = spawnControlPlane();
      await waitForHealth(httpBase, restartedControlPlane, logs);
      const restartedRunner = spawnRunner();
      let lastSession: SessionView | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const session = await fetchSession({ httpBase, ownerToken, sessionId });
        lastSession = session;
        if (session.pendingApproval?.kind === "question" &&
            session.pendingApproval.recoveryReason === "provider_restart" &&
            session.pendingApproval.recoveryAction === "resume_answer") return;
        if (restartedRunner.exitCode !== null) throw new Error(`runner exited during restart recovery\n${logs()}`);
        await delay(100);
      }
      throw new Error(`recovered question never became resumable: ${JSON.stringify(lastSession)}\n${logs()}`);
    };
    const stack = { httpBase, ownerToken, receiptPath, sessionId, logs, restart, stop };
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const session = await fetchSession(stack);
      if (session.pendingApproval?.kind === "question") return stack;
      if (session.status === "failed") {
        throw new Error(`session failed before asking a question: ${JSON.stringify(session)}\n` +
          `events: ${JSON.stringify(await fetchEvents(stack))}\n${logs()}`);
      }
      await delay(100);
    }
    throw new Error(`${provider === "codex" ? "Codex" : "Claude"} question never reached the control plane\n${logs()}`);
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
      await page.getByLabel("Response").fill("Ship after checks pass");
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
              await page.getByLabel("Response").fill("Ship after checks pass");
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
        await expect(page.getByLabel("Queued Messages").locator(".queued-item")).toHaveCount(queuedMessages.length);
        await expect(page.getByLabel("Queued Messages").locator(".queued-text")).toHaveText(queuedMessages);
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
