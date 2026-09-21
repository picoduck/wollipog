import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderLoginView } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

const login: ProviderLoginView = {
  operationId: "login_12345678-1234-4123-8123-123456789abc",
  accountId: "work",
  label: "Work Claude",
  provider: "claude",
  status: "awaiting_code",
  verificationUrl: "https://claude.ai/oauth/authorize",
  expectsCode: true,
  startedAt: 1,
};

test("provider sign-in card links out safely and submits the pasted code once", async () => {
  const submitted: string[] = [];
  const client = {
    submitProviderLoginCode: async (_runnerId: string, _operationId: string, code: string) => {
      submitted.push(code);
      return { login: { ...login, status: "waiting_for_provider" as const, expectsCode: false } };
    },
    cancelProviderLogin: async () => ({ login: { ...login, status: "cancelled" as const } }),
  } as unknown as ApiClient;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<ApiProvider client={client}><ProviderLoginCard runnerId="runner-1" login={login} /></ApiProvider>);
    });
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noreferrer");
    assert.equal(link.href, "https://claude.ai/oauth/authorize");
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => fireDomEvent.change(input, { target: { value: "transient-response" } }));
    await act(async () => fireDomEvent.submit(container.querySelector("form")!));
    assert.deepEqual(submitted, ["transient-response"]);
    assert.equal(input.value, "");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Codex device flow renders the provider code without a paste field", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={{} as ApiClient}>
          <ProviderLoginCard runnerId="runner-1" login={{
            ...login,
            provider: "codex",
            status: "waiting_for_provider",
            expectsCode: false,
            userCode: "ABCD-EFGH",
          }} />
        </ApiProvider>,
      );
    });
    assert.equal(container.querySelector("code")?.textContent, "ABCD-EFGH");
    assert.equal(container.querySelector("input"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
