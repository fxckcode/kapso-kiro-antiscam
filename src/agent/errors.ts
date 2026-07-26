import {
  ContextWindowOverflowError,
  MaxTokensError,
  ModelError,
  ModelThrottledError,
  StructuredOutputError,
  ToolNotFoundError,
  ToolValidationError,
  JsonValidationError,
} from "@strands-agents/sdk";
import type { AnalysisResult } from "../domain/analysis-result.js";

/**
 * Clasificacion de errores del agente y contrato de resultado (PR-06 sec. 13).
 *
 * Principio: el llamador NUNCA ve un mensaje crudo de AWS ni de Strands. Un
 * error de proveedor puede contener el ARN del modelo, el id de cuenta, el
 * nombre del rol o fragmentos del prompt; nada de eso puede propagarse a logs,
 * a la cola ni al usuario. Aqui todo error se reduce a un `reason` de un
 * conjunto CERRADO y documentado.
 *
 * Dos familias, con politicas de reintento opuestas:
 *  - `retryable_error`: el problema es del transporte o de la capacidad; el
 *    mismo mensaje puede analizarse mas tarde con exito. La reentrega la decide
 *    la infraestructura (SQS), NO este modulo: aqui no hay reintentos manuales
 *    alrededor de `agent.invoke` (PR-06 sec. 8 y 13).
 *  - `fallback`: el problema es del contenido o de la configuracion; repetir la
 *    llamada daria el mismo resultado, asi que se entrega una respuesta PRUDENTE
 *    (`buildCautiousResult`) que no declara seguridad ni inventa evidencia.
 */

/** Motivos que producen una respuesta prudente en lugar de un reintento. */
export const AGENT_FALLBACK_REASONS = [
  /** La salida estructurada falto, no valido o violo el contrato de PR-01. */
  "invalid_output",
  /** Se agotaron turnos o tokens del bucle del agente. */
  "limit_exceeded",
  /** Error permanente del modelo: acceso denegado, modelo inexistente, config. */
  "permanent_model_error",
  /** El modelo intento usar una herramienta inexistente o con argumentos invalidos. */
  "tool_contract_error",
] as const;

export type AgentFallbackReason = (typeof AGENT_FALLBACK_REASONS)[number];

/** Motivos transitorios: la infraestructura puede reintentar el mensaje. */
export const AGENT_RETRYABLE_REASONS = [
  "throttled",
  "model_not_ready",
  "service_unavailable",
  "timeout",
] as const;

export type AgentRetryableReason = (typeof AGENT_RETRYABLE_REASONS)[number];

export interface AgentAnalysisSuccess {
  readonly status: "success";
  readonly result: AnalysisResult;
}

export interface AgentAnalysisFallback {
  readonly status: "fallback";
  readonly result: AnalysisResult;
  readonly reason: AgentFallbackReason;
}

/**
 * No lleva `result`: el mensaje no se ha analizado y no debe entregarse una
 * respuesta al usuario. Reintentarlo es responsabilidad de la cola.
 */
export interface AgentAnalysisRetryable {
  readonly status: "retryable_error";
  readonly reason: AgentRetryableReason;
}

export type AgentAnalysisOutcome =
  | AgentAnalysisSuccess
  | AgentAnalysisFallback
  | AgentAnalysisRetryable;

/**
 * Error de configuracion del proveedor (ej. `BEDROCK_MODEL_ID` ausente). El
 * mensaje nombra la VARIABLE, jamas su valor: un modelId puede ser un ARN con
 * el id de cuenta AWS.
 */
export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigurationError";
  }
}

/**
 * Violacion del contrato cerrado de herramientas detectada por NUESTRO codigo
 * (no por Strands): p. ej. dos evidencias distintas registradas con el mismo
 * `evidenceId`, o un `invocationState` sin contexto de ejecucion. Falla cerrado.
 */
export class ToolContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolContractError";
  }
}

/** Clasificacion interna: familia + motivo, sin datos del error original. */
export type AgentErrorClassification =
  | { readonly kind: "fallback"; readonly reason: AgentFallbackReason }
  | { readonly kind: "retryable"; readonly reason: AgentRetryableReason };

/** Profundidad maxima al recorrer `cause`: evita ciclos y cadenas absurdas. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Nombres de excepcion de Bedrock Runtime que representan una condicion
 * TRANSITORIA. Se comparan por nombre para no depender del AWS SDK como
 * dependencia directa (PR-06 sec. 2).
 */
const RETRYABLE_AWS_NAMES: ReadonlyMap<string, AgentRetryableReason> = new Map([
  ["ThrottlingException", "throttled"],
  ["TooManyRequestsException", "throttled"],
  ["ServiceQuotaExceededException", "throttled"],
  ["ProvisionedThroughputExceededException", "throttled"],
  ["ModelNotReadyException", "model_not_ready"],
  ["ServiceUnavailableException", "service_unavailable"],
  ["InternalServerException", "service_unavailable"],
  ["InternalFailure", "service_unavailable"],
  ["RequestTimeout", "timeout"],
  ["RequestTimeoutException", "timeout"],
  ["TimeoutError", "timeout"],
  ["AbortError", "timeout"],
  ["ModelTimeoutException", "timeout"],
]);

/**
 * Nombres de excepcion PERMANENTES: acceso, configuracion o entrada invalida.
 * Reintentarlas solo gastaria cuota. Se degradan a respuesta prudente.
 */
const PERMANENT_AWS_NAMES: ReadonlySet<string> = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "ValidationException",
  "ResourceNotFoundException",
  "ModelErrorException",
  "SerializationException",
  "IncompleteSignatureException",
  "InvalidSignatureException",
  "ExpiredTokenException",
  "CredentialsProviderError",
]);

/** Codigos HTTP que se consideran transitorios. */
function retryableForStatus(status: number): AgentRetryableReason | null {
  if (status === 429) return "throttled";
  if (status === 408) return "timeout";
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return "service_unavailable";
  }
  return null;
}

/**
 * Extrae `$metadata.httpStatusCode` de un error del AWS SDK sin importar tipos
 * de AWS y sin castear a `any`.
 */
function httpStatusOf(value: object): number | null {
  if (!("$metadata" in value)) return null;
  const metadata = (value as { $metadata?: unknown }).$metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

/** Nombre declarado del error (`name`), si lo hay. */
function nameOf(value: object): string | null {
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * Clasifica un error de proveedor recorriendo la cadena `cause`. Devuelve null
 * si nada en la cadena es reconocible; el llamador decide el motivo por defecto.
 *
 * Solo se leen `name` y `$metadata.httpStatusCode`. El `message` NUNCA se lee ni
 * se propaga: es la via mas comun por la que un ARN o un fragmento de prompt
 * acabaria en un log.
 */
function classifyProviderChain(error: unknown): AgentErrorClassification | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return null;

    const name = nameOf(current);
    if (name !== null) {
      const retryable = RETRYABLE_AWS_NAMES.get(name);
      if (retryable !== undefined) return { kind: "retryable", reason: retryable };
      if (PERMANENT_AWS_NAMES.has(name)) {
        return { kind: "fallback", reason: "permanent_model_error" };
      }
    }

    const status = httpStatusOf(current);
    if (status !== null) {
      const reason = retryableForStatus(status);
      if (reason !== null) return { kind: "retryable", reason };
      if (status >= 400 && status < 500) {
        return { kind: "fallback", reason: "permanent_model_error" };
      }
    }

    current = (current as { cause?: unknown }).cause;
    if (current === undefined || current === null) return null;
  }
  return null;
}

/**
 * Traduce cualquier excepcion a la clasificacion cerrada de PR-06 sec. 13.
 *
 * Orden importante: las subclases concretas de `ModelError` se comprueban ANTES
 * que la clase base, porque `ModelThrottledError instanceof ModelError` es true.
 *
 * Un error desconocido se clasifica como `permanent_model_error` y NO como
 * reintentable: reintentar en bucle un fallo que no entendemos es peor que
 * entregar una respuesta prudente una sola vez.
 */
export function classifyAgentError(error: unknown): AgentErrorClassification {
  // Errores propios: contrato de herramientas y configuracion.
  if (error instanceof ToolContractError) {
    return { kind: "fallback", reason: "tool_contract_error" };
  }
  if (error instanceof AgentConfigurationError) {
    return { kind: "fallback", reason: "permanent_model_error" };
  }

  // Cancelacion por timeout: `AbortSignal.timeout` lanza un DOMException
  // `TimeoutError`; un abort externo lanza `AbortError`.
  if (typeof error === "object" && error !== null) {
    const name = nameOf(error);
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "retryable", reason: "timeout" };
    }
  }

  // Errores de Strands, de mas especifico a mas general.
  if (error instanceof ModelThrottledError) {
    return { kind: "retryable", reason: "throttled" };
  }
  if (error instanceof MaxTokensError || error instanceof ContextWindowOverflowError) {
    return { kind: "fallback", reason: "limit_exceeded" };
  }
  if (error instanceof StructuredOutputError || error instanceof JsonValidationError) {
    return { kind: "fallback", reason: "invalid_output" };
  }
  if (error instanceof ToolNotFoundError || error instanceof ToolValidationError) {
    return { kind: "fallback", reason: "tool_contract_error" };
  }

  // `ModelError` envuelve el error del proveedor en `cause`: se inspecciona la
  // cadena para distinguir throttling/indisponibilidad de un fallo permanente.
  const fromChain = classifyProviderChain(error);
  if (fromChain !== null) return fromChain;

  if (error instanceof ModelError) {
    return { kind: "fallback", reason: "permanent_model_error" };
  }

  return { kind: "fallback", reason: "permanent_model_error" };
}
