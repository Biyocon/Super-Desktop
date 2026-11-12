import type { DispatchIdentity, ProviderDispatch, SpecialistProvider } from "@pi-desktop/conductor-runtime/adapter";
import type { AgentEventEnvelope, MessageUsage, SubagentThinkingLevel } from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { SubagentRun } from "../subagent.js";
import { conductorPrompt } from "./prompt.js";
import { conductorTools } from "./tools.js";

export type ConductorWorkerResult = DispatchIdentity & {
  type: "worker-result"; modelId: string; status: string;
  turns: number; toolCalls: number; usage?: MessageUsage;
};

/** Reuses the existing request-time provider/auth transport; no parent Agent or Task registry. */
export function createConductorProvider(options: {
  ownerSessionId: string;
  provider: RuntimeProviderConfig;
  thinkingLevel: SubagentThinkingLevel;
  recordResult(event: ConductorWorkerResult): Promise<void>;
  onActivity?(identity: DispatchIdentity, event: AgentEventEnvelope["event"]): void;
}): SpecialistProvider {
  return {
    async dispatch(request: ProviderDispatch): Promise<unknown> {
      request.signal.throwIfAborted();
      const identity: DispatchIdentity = { runId: request.runId, stage: request.stage, mode: request.mode, dispatchId: request.dispatchId, workerId: request.workerId };
      const prompt = conductorPrompt(request);
      let finalText: string | undefined;
      const tools = conductorTools(request);
      const run = new SubagentRun({
        definition: {
          name: `conductor-${request.stage}`, description: "Harness-owned specialist dispatch.",
          tools: tools.map(tool => tool.name), permission: "inherit", source: "builtin",
          prompt: prompt.systemPrompt,
          ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
        },
        // Auth remains bound to the durable owner, never an invented worker session.
        sessionId: options.ownerSessionId, parentToolCallId: request.dispatchId,
        provider: options.provider, thinkingLevel: options.thinkingLevel,
        systemPrompt: prompt.systemPrompt, task: prompt.task, tools,
        signal: request.signal,
        ...(request.mode === "critic" ? { contextPolicy: "exact" as const } : {}),
        onEvent: ({ event }) => {
          if (request.signal.aborted) return;
          if (event.type === "message_end" && event.message.role === "assistant") {
            // Clear any earlier tool-turn answer when the final response failed.
            finalText = event.message.status === "complete" ? event.message.content : undefined;
          }
          options.onActivity?.(identity, event);
        },
      });
      const result = await run.run();
      request.signal.throwIfAborted();
      await options.recordResult({ ...identity, type: "worker-result", modelId: result.modelId,
        status: result.status, turns: result.turns, toolCalls: result.toolCalls,
        ...(result.usage ? { usage: result.usage } : {}),
      });
      request.signal.throwIfAborted();
      if (result.status !== "completed") throw new Error(`CONDUCTOR_WORKER_${result.status.toUpperCase()}`);
      if (request.mode === "critic" && (result.contextCompactions || result.contextDegraded)) throw new Error("CONDUCTOR_CRITIC_CONTEXT_CHANGED");
      if (!finalText?.trim()) throw new Error("CONDUCTOR_WORKER_OUTPUT_MISSING");
      let value: unknown;
      try { value = JSON.parse(finalText); }
      catch { throw new Error("CONDUCTOR_WORKER_OUTPUT_INVALID_JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONDUCTOR_WORKER_OUTPUT_INVALID_JSON");
      if (request.mode !== "critic") return value;
      const usage = result.usage;
      // Missing usage is deliberately absent, not a fabricated zero. The
      // dispatcher lets Harness record the resulting authority/budget failure.
      return { value, ...(usage ? {
        inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        outputTokens: Math.max(usage.outputTokens, usage.reasoningTokens ?? 0),
      } : {}) };
    },
  };
}
