import { Agent } from "@strands-agents/sdk";
import { agentEvaluationSchema } from "../domain/agent-evaluation.js";
import type { ModelProvider } from "./model/model-provider.js";
import type { CheckUrlReputationDeps } from "../reputation/check-url-reputation.js";
import type { RetrieveKnownCasesToolDeps } from "./tools/retrieve-known-cases-tool.js";
import { createCheckUrlReputationTool } from "./tools/check-url-reputation-tool.js";
import { createRetrieveKnownCasesTool } from "./tools/retrieve-known-cases-tool.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

/**
 * Dependencias compartibles entre ejecuciones. Son NEUTRALES: no contienen
 * `executionId`, allowlist ni registro de evidencia. Pueden inyectarse una sola
 * vez al arrancar la Lambda y reutilizarse en todas las invocaciones calientes.
 */
export interface AnalysisAgentDeps {
  readonly model: ModelProvider;
  readonly reputationDeps: CheckUrlReputationDeps;
  readonly now: () => string;
}

/**
 * Crea un nuevo `Agent` de Strands para UNA ejecucion (PR-06 sec. 14).
 *
 * No existe un singleton con conversacion: cada analisis crea su propio agente,
 * de modo que el historial de mensajes no se comparte entre invocaciones
 * concurrentes en la misma Lambda caliente.
 *
 * Configuracion:
 *  - `structuredOutputSchema`: fuerza la salida estructurada al schema de PR-01.
 *  - `printer: false`: suprime toda salida de consola del SDK (nunca loguear
 *    el prompt, la respuesta del modelo ni los argumentos de herramientas).
 *  - `toolChoice`: NO se usa (sec. 14).
 *  - Streaming: NO se usa (`stream: false` en `BedrockProviderConfig`).
 */
export function createAnalysisAgent(deps: AnalysisAgentDeps): Agent {
  const knownCasesDeps: RetrieveKnownCasesToolDeps = { now: deps.now };

  return new Agent({
    model: deps.model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [
      createCheckUrlReputationTool(deps.reputationDeps),
      createRetrieveKnownCasesTool(knownCasesDeps),
    ],
    structuredOutputSchema: agentEvaluationSchema,
    printer: false,
  });
}
