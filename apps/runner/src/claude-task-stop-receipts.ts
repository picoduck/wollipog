/** Exact, correlated provider TaskStop receipts. Quoted text and failed/missing-task responses
 * cannot end work. A later launch/resume (including one racing the stop response) wins. */
export function claudeTaskStopReceipts(transcript: string): Map<string, number> {
  const calls = new Map<string, { taskId: string; offset: number }>();
  const seenCalls = new Set<string>();
  const launches = new Map<string, number>();
  const stopped = new Map<string, number>();
  let offset = 0;
  for (const line of transcript.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    let record;
    if (!line.trim()) continue;
    try { record = JSON.parse(line); } catch { return new Map(); }
    if (!record || typeof record !== "object" || record.isMeta || record.isCompactSummary) continue;
    const content = record.message?.content;
    if (record.type === "system" && record.subtype === "task_started" && typeof record.task_id === "string") {
      launches.set(record.task_id, at);
    }
    if (record.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        if ((block.name === "Agent" || block.name === "Task") && typeof block.input?.resume === "string") {
          launches.set(block.input.resume, at);
        }
        if (block.name !== "TaskStop" || typeof block.id !== "string" ||
            typeof block.input?.task_id !== "string" || !block.input.task_id) continue;
        // Duplicate call identities are ambiguous, even when a response follows them.
        if (seenCalls.has(block.id)) { calls.delete(block.id); continue; }
        seenCalls.add(block.id);
        calls.set(block.id, { taskId: block.input.task_id, offset: at });
      }
    }
    if (record.type !== "user") continue;
    const launch = record.toolUseResult;
    if (launch && typeof launch === "object") {
      for (const id of [launch.agentId, launch.taskId, launch.resumedAgentId]) {
        if (typeof id === "string") launches.set(id, at);
      }
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      calls.delete(block.tool_use_id);
      if (block.is_error === true || record.toolUseResult?.is_error === true) continue;
      let result = block.content;
      if (Array.isArray(result)) result = result.filter((part) => part?.type === "text").map((part) => part.text).join("");
      if (typeof result === "string") {
        try { result = JSON.parse(result); } catch { continue; }
      }
      if (!result || result.task_id !== call.taskId || typeof result.message !== "string") continue;
      const prefix = `Successfully stopped task: ${call.taskId}`;
      if (result.message !== prefix && !result.message.startsWith(`${prefix} (`)) continue;
      if ((launches.get(call.taskId) ?? -1) > call.offset) continue;
      stopped.set(call.taskId, at);
    }
  }
  for (const [id, at] of stopped) {
    if ((launches.get(id) ?? -1) > at) stopped.delete(id);
  }
  return stopped;
}
