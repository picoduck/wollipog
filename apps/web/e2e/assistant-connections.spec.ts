import { test, expect } from "@playwright/test";
import { assistantUiServer } from "../../control-plane/test-support/assistant-ui-server.js";

for (const theme of ["dark", "light"] as const) {
  test(`owner connection lifecycle uses real HTTP routes in ${theme}`, async ({page}, testInfo) => {
    const server = await assistantUiServer();
    try {
      await page.addInitScript(({origin, ownerCredential}) => { (window as unknown as {assistantTest: unknown}).assistantTest = {origin, ownerCredential}; }, {origin: server.origin, ownerCredential: server.ownerCredential});
      await page.goto(`/assistant-connections-e2e.html?theme=${theme}`);
      await page.getByRole("button", {name: /Manage Assistant Connections/}).click();
      await expect(page.getByRole("button", {name: "New Connection", exact: true})).toBeVisible();
      await page.getByLabel("Installation Display Name").fill("Workbench");
      await page.getByRole("button", {name: "Save Installation Name"}).click();
      await expect(page.getByRole("status")).toContainText("Installation name saved");
      await page.getByRole("button", {name: "New Connection", exact: true}).click();
      await page.getByLabel("Connection Name", {exact: true}).fill("OpenClaw Desktop");
      await expect(page.getByRole("button", {name: /^Management Access:/})).toContainText("Full Access");
      await expect(page.getByRole("button", {name: /^Destructive Confirmation:/})).toContainText("None");
      await page.getByRole("button", {name: "Create Connection", exact: true}).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      const secret = page.getByLabel("Assistant Credential", {exact: true});
      await expect(secret).toHaveAttribute("type", "password");
      const token = await secret.inputValue();
      expect(await secret.getAttribute("value")).toBeNull();
      expect(await page.locator("html").evaluate((element, credential) => element.innerHTML.includes(credential), token)).toBe(false);
      expect(server.db.assistantConnections.authenticate(token)).not.toBeNull();
      expect((server.db.raw().prepare("SELECT count(*) AS n FROM assistant_connections").get() as {n: number}).n).toBe(1);
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: async () => { throw new Error("fixture denied"); }}}));
      await page.getByRole("button", {name: "Copy Credential", exact: true}).click();
      await expect(page.getByRole("alert")).toContainText("Choose Show Credential");
      await expect(page.getByRole("alert")).not.toContainText("delivered");
      await page.getByRole("button", {name: "Show Credential", exact: true}).click();
      await expect(secret).toHaveAttribute("type", "text");
      await page.getByRole("button", {name: "Hide Credential", exact: true}).click();
      await expect(secret).toHaveAttribute("type", "password");
      expect(await page.evaluate(value => JSON.stringify({...localStorage, ...sessionStorage}).includes(value), token)).toBe(false);
      // Capture the UI's own password masking, using only a runtime-generated synthetic secret.
      if (process.env.ASSISTANT_EVIDENCE_DIR && !process.env.ASSISTANT_MOBILE_EVIDENCE_ONLY) await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-credential-${theme}.png`, animations: "disabled"});
      await page.getByRole("button", {name: "Dismiss Credential"}).click();
      await expect(secret).toHaveCount(0);
      await page.getByLabel("Connection Name", {exact: true}).fill("OpenClaw Remote");
      await page.getByRole("button", {name: /^Management Access:/}).click();
      await page.getByRole("option", {name: "Configured Access", exact: true}).click();
      await page.getByRole("checkbox", {name: /Assistant Discover/}).check();
      await page.getByRole("button", {name: /^Project Access:/}).click();
      await page.getByRole("option", {name: "Selected Projects", exact: true}).click();
      await page.getByRole("checkbox", {name: "Assistant Sandbox"}).check();
      await page.getByRole("button", {name: /^Destructive Confirmation:/}).click();
      await page.getByRole("option", {name: "Confirm", exact: true}).click();
      await page.getByRole("button", {name: "Save Connection", exact: true}).click();
      await expect(page.getByRole("status")).toContainText("Connection saved");
      const connection = server.db.assistantConnections.current(server.db.assistantConnections.authenticate(token)!);
      expect(connection.name).toBe("OpenClaw Remote");
      expect(connection.grant.projects).toEqual([server.project.id]);
      expect(connection.grant.destructiveConfirmation).toBe("confirm");
      await page.route(/\/api\/assistant-connections\/[^/]+\/configure$/, route => route.abort("connectionfailed"));
      await page.getByLabel("Connection Name", {exact: true}).fill("Unsaved Draft");
      await page.getByRole("button", {name: "Save Connection", exact: true}).click();
      await expect(page.getByRole("alert")).toContainText("refresh and inspect");
      expect(server.db.assistantConnections.get(connection.id)!.name).toBe("OpenClaw Remote");
      await page.unroute(/\/api\/assistant-connections\/[^/]+\/configure$/);
      await page.getByLabel("Connection Name", {exact: true}).fill("OpenClaw Remote");
      await page.getByRole("button", {name: "Save Connection", exact: true}).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("status")).toContainText("Connection saved");
      if (process.env.ASSISTANT_EVIDENCE_DIR) {
        await page.setViewportSize({width: 1280, height: 1400});
        await page.getByLabel("Connection Name", {exact: true}).scrollIntoViewIfNeeded();
        await expect(page.getByRole("button", {name: /^Destructive Confirmation:/})).toBeInViewport();
        await expect(page.getByRole("checkbox", {name: "Assistant Sandbox"})).toBeInViewport();
        expect((await page.getByLabel("Connection ID", {exact: true}).boundingBox())!.width).toBeGreaterThan(500);
        if (!process.env.ASSISTANT_MOBILE_EVIDENCE_ONLY) await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-configure-${theme}.png`, animations: "disabled"});
        await page.setViewportSize({width: 390, height: 1000});
        await expect(page.getByRole("dialog")).toBeInViewport({ratio: 0.95});
        const operationRow = page.locator(".choice-row").filter({hasText: "Assistant Discover"});
        await operationRow.evaluate(row => {
          row.scrollIntoView({block: "center"});
          const body = row.closest(".modal-body");
          const group = row.closest("fieldset");
          if (body && group) body.scrollTop += group.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
        });
        const header = await page.locator(".modal-head").boundingBox();
        const row = await operationRow.boundingBox();
        expect(row!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
        await expect(operationRow).toBeInViewport({ratio: 1});
        await expect(operationRow.locator(".choice-row-desc")).toHaveCSS("display", "block");
        expect(await operationRow.locator(".choice-row-desc").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
        await expect(page.getByRole("button", {name: /^Destructive Confirmation:/})).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-configure-mobile-${theme}.png`, animations: "disabled"});
        await page.setViewportSize({width: 1280, height: 1000});
      }
      const discovery = await fetch(`${server.origin}/assistant/mcp`, {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "assistant_discover"}})});
      expect(discovery.status).toBe(200);
      await page.getByRole("button", {name: "Refresh Activity"}).click();
      await expect(page.getByText("Succeeded", {exact: true})).toBeVisible();
      await page.getByRole("button", {name: "Rotate Credential", exact: true}).click();
      await expect(page.getByRole("dialog", {name: "Rotate Credential", exact: true})).toBeVisible();
      if (process.env.ASSISTANT_EVIDENCE_DIR && !process.env.ASSISTANT_MOBILE_EVIDENCE_ONLY) await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-rotate-confirm-${theme}.png`, animations: "disabled"});
      await page.getByRole("button", {name: "Cancel", exact: true}).click();
      expect(server.db.assistantConnections.authenticate(token)).not.toBeNull();
      await page.getByRole("button", {name: "Rotate Credential", exact: true}).click();
      await page.getByRole("dialog", {name: "Rotate Credential", exact: true}).getByRole("button", {name: "Rotate Credential", exact: true}).click();
      await expect(secret).toBeVisible();
      const rotated = await secret.inputValue();
      expect(server.db.assistantConnections.authenticate(token)).toBeNull();
      expect(server.db.assistantConnections.authenticate(rotated)).not.toBeNull();
      await page.getByRole("button", {name: "Done", exact: true}).click();
      await page.getByRole("button", {name: /Manage Assistant Connections/}).click();
      await expect(secret).toHaveCount(0);
      await page.getByRole("button", {name: /OpenClaw Remote/}).click();
      await page.getByRole("button", {name: "Revoke Connection", exact: true}).click();
      await expect(page.getByRole("dialog", {name: "Revoke Connection", exact: true})).toBeVisible();
      if (process.env.ASSISTANT_EVIDENCE_DIR && !process.env.ASSISTANT_MOBILE_EVIDENCE_ONLY) await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-revoke-confirm-${theme}.png`, animations: "disabled"});
      await page.getByRole("dialog", {name: "Revoke Connection", exact: true}).getByRole("button", {name: "Revoke Connection", exact: true}).click();
      await expect(page.getByRole("status")).toContainText("Connection revoked");
      expect(server.db.assistantConnections.authenticate(rotated)).toBeNull();
      await page.getByText("Inspect Revoked Grants", {exact: true}).click();
      await expect(page.getByRole("button", {name: "Save Connection", exact: true})).toBeDisabled();
      await page.getByText("Inspect Revoked Grants", {exact: true}).click();
      await page.getByRole("button", {name: "Refresh Activity"}).click();
      await expect(page.getByText("Succeeded", {exact: true})).toBeVisible();
      await expect(page.getByText("Assistant: OpenClaw Remote", {exact: true})).toBeVisible();
      await expect(page.getByText("Target: Control Plane · Workbench", {exact: true})).toBeVisible();
      await expect(page.getByRole("dialog")).not.toContainText('{"kind"');
      if (process.env.ASSISTANT_EVIDENCE_DIR && !process.env.ASSISTANT_MOBILE_EVIDENCE_ONLY) {
        await expect(page.getByText("Revoked", {exact: true})).toBeInViewport();
        await expect(page.getByText("Target: Control Plane · Workbench", {exact: true})).toBeInViewport();
        await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-revoked-${theme}.png`, animations: "disabled"});
        await page.screenshot({path: `${process.env.ASSISTANT_EVIDENCE_DIR}/assistant-revoked-top-${theme}.png`, animations: "disabled"});
      }
      await testInfo.attach("coverage-scope", {body: "Real browser -> HTTP -> Fastify -> SQLite lifecycle; synthetic owner authentication. No OpenClaw, TLS, SSH or Discord evidence.", contentType: "text/plain"});
    } finally { await server.close(); }
  });
}

test("non-owner refusal offers no grant controls", async ({page}) => {
  const server = await assistantUiServer();
  try {
    await page.addInitScript(({origin}) => { (window as unknown as {assistantTest: unknown}).assistantTest = {origin, ownerCredential: "unrecognized-fixture"}; }, {origin: server.origin});
    await page.goto("/assistant-connections-e2e.html");
    await page.getByRole("button", {name: /Manage Assistant Connections/}).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", {name: "New Connection", exact: true})).toHaveCount(0);
  } finally { await server.close(); }
});

test("switching real control planes clears shown credentials and keeps connections independent", async ({page}) => {
  const first = await assistantUiServer(), second = await assistantUiServer();
  try {
    await page.addInitScript(({origin, ownerCredential}) => { (window as unknown as {assistantTest: unknown}).assistantTest = {origin, ownerCredential}; }, {origin: first.origin, ownerCredential: first.ownerCredential});
    await page.goto("/assistant-connections-e2e.html");
    const open = () => page.getByRole("button", {name: /Manage Assistant Connections/}).click();
    await open();
    await page.getByRole("button", {name: "New Connection", exact: true}).click();
    await page.getByLabel("Connection Name", {exact: true}).fill("First Connection");
    await page.getByRole("button", {name: "Create Connection", exact: true}).click();
    const secret = page.getByLabel("Assistant Credential", {exact: true});
    await expect(secret).toBeVisible();
    const token = await secret.inputValue();
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent("assistant-test-switch", {detail})), {origin: second.origin, ownerCredential: second.ownerCredential});
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await open();
    await expect(page.getByText("No Connections", {exact: true})).toBeVisible();
    await expect(secret).toHaveCount(0);
    expect(first.db.assistantConnections.authenticate(token)).not.toBeNull();
    expect(second.db.assistantConnections.authenticate(token)).toBeNull();
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent("assistant-test-switch", {detail})), {origin: first.origin, ownerCredential: first.ownerCredential});
    await open();
    await expect(page.getByRole("button", {name: /First Connection/})).toBeVisible();
    await expect(secret).toHaveCount(0);
  } finally { await first.close(); await second.close(); }
});

test("stale owner editor cannot restore a grant narrowed by another client", async ({page}) => {
  const server = await assistantUiServer();
  try {
    await page.addInitScript(({origin, ownerCredential}) => { (window as unknown as {assistantTest: unknown}).assistantTest = {origin, ownerCredential}; }, {origin: server.origin, ownerCredential: server.ownerCredential});
    await page.goto("/assistant-connections-e2e.html");
    await page.getByRole("button", {name: /Manage Assistant Connections/}).click();
    await page.getByRole("button", {name: "New Connection", exact: true}).click();
    await page.getByLabel("Connection Name", {exact: true}).fill("Concurrent Owner");
    await page.getByRole("button", {name: "Create Connection", exact: true}).click();
    const secret = page.getByLabel("Assistant Credential", {exact: true});
    await expect(secret).toBeVisible();
    const connection = server.db.assistantConnections.current(server.db.assistantConnections.authenticate(await secret.inputValue())!);
    await page.getByRole("button", {name: "Dismiss Credential"}).click();
    const narrowed = await fetch(`${server.origin}/api/assistant-connections/${connection.id}/configure`, {method: "POST", headers: {authorization: `Bearer ${server.ownerCredential}`, "content-type": "application/json"}, body: JSON.stringify({grant: {operations: ["assistant_discover"], projects: [server.project.id]}, expectedRevision: connection.revision})});
    expect(narrowed.status).toBe(200);
    await page.getByLabel("Connection Name", {exact: true}).fill("Stale Rename");
    await page.getByRole("button", {name: "Save Connection", exact: true}).click();
    await expect(page.getByRole("alert")).toContainText("changed in another window");
    expect(server.db.assistantConnections.get(connection.id)!.grant.projects).toEqual([server.project.id]);
    expect(server.db.assistantConnections.get(connection.id)!.name).toBe("Concurrent Owner");
    await page.getByRole("button", {name: "Back to Connections"}).click();
    await page.getByRole("button", {name: "Refresh Connections"}).click();
    await page.getByRole("button", {name: /Concurrent Owner/}).click();
    await expect(page.getByRole("button", {name: /^Project Access:/})).toContainText("Selected Projects");
  } finally { await server.close(); }
});
