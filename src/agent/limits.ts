import { assertBoundedInteger } from "../shared/numeric-limits.js";

/**
 * Limites del bucle del agente (PR-06 sec. 8).
 *
 * Son un mecanismo de CONTENCION DE COSTO Y TIEMPO, no una barrera de
 * seguridad: acotan cuantas veces puede iterar el bucle, cuantos tokens puede
 * generar y cuanto puede tardar antes de que la Lambda agote su propio tiempo.
 *
 * La validacion reutiliza `assertBoundedInteger` (PR-04): rechaza `NaN`,
 * `Infinity`, negativos, decimales y strings forzados en runtime. No se
 * normaliza ni se recorta en silencio; un valor fuera de rango se RECHAZA,
 * porque recortarlo oculta el bug del llamador.
 *
 * No hay reintentos propios alrededor de `agent.invoke`: si se agota el
 * `timeoutMs`, el resultado es `retryable_error` y la reentrega la decide SQS.
 */

export interface AgentLimits {
  /** Iteraciones del bucle (una llamada al modelo + sus herramientas). */
  readonly turns: number;
  /** Tokens generados acumulados en toda la invocacion. */
  readonly outputTokens: number;
  /** Tokens totales (entrada + salida) acumulados. */
  readonly totalTokens: number;
  /** Presupuesto de reloj de pared de la invocacion completa. */
  readonly timeoutMs: number;
}

/**
 * Valores por defecto. Cuatro turnos bastan para: analizar, consultar
 * reputacion, consultar casos conocidos y responder.
 */
export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  turns: 4,
  outputTokens: 1024,
  totalTokens: 4096,
  timeoutMs: 20_000,
});

/**
 * Rangos admitidos. El maximo de `turns` coincide con el valor por defecto: no
 * existe un caso de uso que necesite mas iteraciones y cada turno extra es una
 * llamada de pago. `timeoutMs` se queda por debajo del tiempo de Lambda para
 * que el fallback pueda construirse y entregarse.
 */
export const AGENT_LIMIT_RANGES = Object.freeze({
  turns: Object.freeze({ min: 1, max: 4 }),
  outputTokens: Object.freeze({ min: 1, max: 2048 }),
  /** El minimo real es `outputTokens`; se comprueba aparte. */
  totalTokens: Object.freeze({ min: 1, max: 8192 }),
  timeoutMs: Object.freeze({ min: 1_000, max: 25_000 }),
});

/** Sobrescritura parcial: cada campo ausente toma el valor por defecto. */
export interface AgentLimitsOverrides {
  readonly turns?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly timeoutMs?: number;
}

/**
 * Resuelve y valida los limites. Solo `undefined` cuenta como ausencia: un
 * `null` forzado en runtime se pasa al validador y se rechaza, en lugar de
 * activar silenciosamente el valor por defecto.
 */
export function resolveAgentLimits(overrides: AgentLimitsOverrides = {}): AgentLimits {
  const context = "resolveAgentLimits";

  const turns = assertBoundedInteger(
    overrides.turns === undefined ? DEFAULT_AGENT_LIMITS.turns : overrides.turns,
    AGENT_LIMIT_RANGES.turns.min,
    AGENT_LIMIT_RANGES.turns.max,
    context,
    "turns",
  );

  const outputTokens = assertBoundedInteger(
    overrides.outputTokens === undefined
      ? DEFAULT_AGENT_LIMITS.outputTokens
      : overrides.outputTokens,
    AGENT_LIMIT_RANGES.outputTokens.min,
    AGENT_LIMIT_RANGES.outputTokens.max,
    context,
    "outputTokens",
  );

  // El minimo de `totalTokens` es `outputTokens`: un total menor que la salida
  // es incoherente y cortaria la generacion antes de empezar.
  const totalTokens = assertBoundedInteger(
    overrides.totalTokens === undefined
      ? DEFAULT_AGENT_LIMITS.totalTokens
      : overrides.totalTokens,
    outputTokens,
    AGENT_LIMIT_RANGES.totalTokens.max,
    context,
    "totalTokens",
  );

  const timeoutMs = assertBoundedInteger(
    overrides.timeoutMs === undefined ? DEFAULT_AGENT_LIMITS.timeoutMs : overrides.timeoutMs,
    AGENT_LIMIT_RANGES.timeoutMs.min,
    AGENT_LIMIT_RANGES.timeoutMs.max,
    context,
    "timeoutMs",
  );

  return Object.freeze({ turns, outputTokens, totalTokens, timeoutMs });
}

/** Subconjunto que entiende `agent.invoke(..., { limits })`. */
export interface InvocationBudget {
  readonly turns: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Proyecta los limites al presupuesto de invocacion (sin `timeoutMs`). */
export function toInvocationBudget(limits: AgentLimits): InvocationBudget {
  return {
    turns: limits.turns,
    outputTokens: limits.outputTokens,
    totalTokens: limits.totalTokens,
  };
}

/**
 * Senal de cancelacion por tiempo. Se usa `AbortSignal.timeout` cuando existe
 * (Node >= 17.3); en un runtime que no lo exponga se devuelve `undefined` y la
 * invocacion queda acotada solo por `turns`/`totalTokens`, que es la degradacion
 * segura: no se simula un timeout con un temporizador sin limpiar.
 */
export function createTimeoutSignal(limits: AgentLimits): AbortSignal | undefined {
  const factory = AbortSignal.timeout;
  if (typeof factory !== "function") return undefined;
  return AbortSignal.timeout(limits.timeoutMs);
}
