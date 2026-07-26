import { parseAgentEvaluation } from "../domain/agent-evaluation.js";
import {
  buildAnalysisResult,
  buildCautiousResult,
} from "../domain/analysis-result.js";
import {
  createAnalysisExecutionContext,
  snapshotEvidence,
  toInvocationState,
} from "./analysis-execution-context.js";
import type { AnalysisAgentInput, ValidatedAgentInput } from "./analysis-agent-input.js";
import { validateAnalysisAgentInput } from "./analysis-agent-input.js";
import { classifyAgentError } from "./errors.js";
import type {
  AgentAnalysisOutcome,
  AgentAnalysisFallback,
  AgentAnalysisRetryable,
} from "./errors.js";
import { resolveAgentLimits, toInvocationBudget, createTimeoutSignal } from "./limits.js";
import type { AgentLimitsOverrides } from "./limits.js";
import { buildUserMessage } from "./system-prompt.js";
import type { AnalysisAgentDeps } from "./create-analysis-agent.js";
import { createAnalysisAgent } from "./create-analysis-agent.js";

/**
 * Opciones por invocacion. `messageId`/`userId` identifican al mensaje para
 * `buildAnalysisResult`; `limitsOverrides` permite ajustar los limites del
 * bucle sin modificar los defaults globales.
 */
export interface AnalyzeWithAgentOptions {
  readonly messageId: string;
  readonly userId: string;
  readonly limitsOverrides?: AgentLimitsOverrides;
}

/**
 * Punto de entrada del analisis con agente (PR-06 sec. 14 / orchestracion).
 *
 * Flujo:
 *  1. Validar la entrada (`validateAnalysisAgentInput`): falla rapidamente ante
 *     datos malformados, antes de crear el agente o el contexto.
 *  2. Crear el contexto de ejecucion (`createAnalysisExecutionContext`): nuevo
 *     por invocacion, nunca compartido.
 *  3. Resolver limites (`resolveAgentLimits`): validados y congelados.
 *  4. Crear un `Agent` NUEVO para esta ejecucion (no singleton).
 *  5. Construir el prompt de usuario (`buildUserMessage`): sin URLs, sin secretos.
 *  6. Invocar el agente con timeout y presupuesto de tokens.
 *  7. Validar la salida estructurada con `parseAgentEvaluation` (doble validacion:
 *     Strands + PR-01).
 *  8. Tomar snapshot defensivo de la evidencia.
 *  9. Construir `AnalysisResult` via `buildAnalysisResult`: resuelve procedencia,
 *     deriva veredicto en el backend.
 * 10. Si algo falla, clasificar el error y devolver `fallback` o `retryable_error`.
 *
 * INVARIANTES CRITICOS:
 *  - No se hacen reintentos propios; la reentrega la decide SQS.
 *  - No se loguea RedactedText, URLs, argumentos de herramientas ni respuestas crudas.
 *  - El modelo no controla `executionId`, `messageId` ni `userId`.
 *  - El resultado siempre es uno de los tres tipos del union discriminado.
 */
export async function analyzeWithAgent(
  input: AnalysisAgentInput,
  deps: AnalysisAgentDeps,
  options: AnalyzeWithAgentOptions,
): Promise<AgentAnalysisOutcome> {
  let validated: ValidatedAgentInput;
  try {
    validated = validateAnalysisAgentInput(input);
  } catch {
    // Error de frontera: entrada invalida -> fallback prudente inmediato.
    // No es reintentable: el mismo input volaria a fallar.
    return buildFallbackOutcome(deps, options, "permanent_model_error");
  }

  const limits = (() => {
    try {
      return resolveAgentLimits(options.limitsOverrides);
    } catch {
      return resolveAgentLimits(); // usa defaults si los overrides son invalidos
    }
  })();

  const execCtx = createAnalysisExecutionContext(validated);
  const agent = createAnalysisAgent(deps);

  let userMessage: string;
  try {
    userMessage = buildUserMessage(
      validated.redactedText,
      validated.signals,
      validated.urlReferences,
    );
  } catch {
    return buildFallbackOutcome(deps, options, "permanent_model_error");
  }

  const cancelSignal = createTimeoutSignal(limits);

  try {
    const result = await agent.invoke(userMessage, {
      invocationState: toInvocationState(execCtx),
      limits: toInvocationBudget(limits),
      ...(cancelSignal !== undefined ? { cancelSignal } : {}),
    });

    // Verificar que se recibio salida estructurada. Si Strands no la produjo,
    // no intentamos parsear texto libre (sec. 12).
    if (result.structuredOutput === undefined || result.structuredOutput === null) {
      return buildFallbackOutcome(deps, options, "invalid_output");
    }

    // Doble validacion: no confiamos unicamente en la validacion interna de Strands.
    const parseResult = parseAgentEvaluation(result.structuredOutput);
    if (!parseResult.ok) {
      return buildFallbackOutcome(deps, options, "invalid_output");
    }

    const evaluation = parseResult.value;

    // Rechazo explicito de campos prohibidos (sec. 12): aunque el schema no los
    // admite (`.strict()`), una segunda comprobacion runtime da doble seguridad.
    // `verdict` y `signals` nunca deben aparecer porque el schema es `.strict()`,
    // pero se verifica igualmente.
    const raw = result.structuredOutput as Record<string, unknown>;
    if ("verdict" in raw || "signals" in raw) {
      return buildFallbackOutcome(deps, options, "invalid_output");
    }

    // Snapshot defensivo ANTES de construir el resultado.
    const evidenceSnapshot = snapshotEvidence(execCtx);

    const analysisResult = buildAnalysisResult({
      messageId: options.messageId,
      userId: options.userId,
      createdAt: deps.now(),
      evaluation,
      signals: validated.signals,
      toolEvidence: evidenceSnapshot,
      executionId: validated.executionId,
    });

    return { status: "success", result: analysisResult };
  } catch (err) {
    const classification = classifyAgentError(err);

    if (classification.kind === "retryable") {
      const outcome: AgentAnalysisRetryable = {
        status: "retryable_error",
        reason: classification.reason,
      };
      return outcome;
    }

    return buildFallbackOutcome(deps, options, classification.reason);
  }
}

/** Construye un `AgentAnalysisFallback` con resultado prudente. */
function buildFallbackOutcome(
  deps: AnalysisAgentDeps,
  options: AnalyzeWithAgentOptions,
  reason: AgentAnalysisFallback["reason"],
): AgentAnalysisFallback {
  return {
    status: "fallback",
    reason,
    result: buildCautiousResult({
      messageId: options.messageId,
      userId: options.userId,
      createdAt: deps.now(),
    }),
  };
}
