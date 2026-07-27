/**
 * Crea un agente conversacional de @strands-agents/sdk.
 *
 * A diferencia de `createAnalysisAgent`, este agente NO tiene
 * `structuredOutputSchema`, lo que le permite conversar libremente.
 * En su lugar, tiene una herramienta `analyzeScam` que invoca cuando
 * detecta un posible fraude o el usuario lo solicita.
 *
 * Cada invocacion crea su propio agente (sin historial compartido).
 */
import { Agent } from "@strands-agents/sdk";
import type { ModelProvider } from "./model/model-provider.js";
import type { CheckUrlReputationDeps } from "../reputation/check-url-reputation.js";
import { createCheckUrlReputationTool } from "./tools/check-url-reputation-tool.js";
import { createAnalyzeScamTool } from "./tools/analyze-scam-tool.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";

export interface ConversationAgentDeps {
  readonly model: ModelProvider;
  readonly reputationDeps: CheckUrlReputationDeps;
  readonly now: () => string;
}

export function createConversationAgent(deps: ConversationAgentDeps): Agent {
  return new Agent({
    model: deps.model,
    systemPrompt: CONVERSATION_SYSTEM_PROMPT,
    tools: [
      createCheckUrlReputationTool(deps.reputationDeps),
      createAnalyzeScamTool(),
    ],
    printer: false,
  });
}
