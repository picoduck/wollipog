import React from "react";
import type { AssistantConnection } from "../assistant-connections.js";
import { StatusBadge } from "./StatusBadge.js";

export function AssistantConnectionStatusBadge({ connection }: { connection: AssistantConnection }) {
  if (connection.revoked) return <StatusBadge label="Revoked" tone="danger" />;
  if (connection.expiresAt != null && connection.expiresAt <= Date.now()) {
    return <StatusBadge label="Expired" tone="neutral" />;
  }
  return <StatusBadge label="Active" tone="success" />;
}
