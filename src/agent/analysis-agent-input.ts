import { safeUrlReferenceSchema } from "../domain/analysis-result.js";
import type { SafeUrlReference } from "../domain/analysis-result.js";
import { LIMITS } from "../domain/limits.js";
import { redact } from "../domain/redaction.js";
import type { RedactedText } from "../domain/redaction.js";
import { signalSchema } from "../domain/signal.js";
import type { Signal } from "../domain/signal.js";
import { assertExecutionId } from "../shared/execution-id.js";
import { URL_LIMITS } from "../url/limits.js";

/**
 * Entrada del analisis con agente (PR-06 sec. 5).
 *
 * Es la UNICA forma admitida por `analyzeWithAgent`. Todo lo que el modelo
 * llegara a ver se deriva de aqui, asi que la frontera se valida completa antes
 * de crear el `Agent`: un dato invalido no debe descubrirse a mitad del bucle,
 * cuando ya se pago una llamada al modelo.
 *
 * Lo que el modelo SI recibe: `redactedText`, las `Signal[]` del backend y la
 * lista de `referenceId`.
 *
 * Lo que el modelo NUNCA recibe: numero telefonico, contenido crudo, API keys,
 * credenciales AWS, `reputationUrl`, secretos, acceso a persistencia o cliente
 * de mensajeria. Las URLs se quedan en la allowlist del contexto de ejecucion
 * (`AnalysisExecutionContext`), que vive fuera del prompt.
 */
export interface AnalysisAgentInput {
  /** Id de la invocacion en curso. Lo fija el backend; el modelo no lo controla. */
  readonly executionId: string;
  /** Texto ya redactado. El unico productor legitimo del tipo es `redact()`. */
  readonly redactedText: RedactedText;
  /** Senales deterministas del backend. El agente no las produce ni las altera. */
  readonly signals: readonly Signal[];
  /** Referencias serializables de URL. Solo el `referenceId` llega al prompt. */
  readonly urlReferences: readonly SafeUrlReference[];
}

/** Entrada validada y CONGELADA, con copias propias de arreglos y objetos. */
export interface ValidatedAgentInput {
  readonly executionId: string;
  readonly redactedText: RedactedText;
  readonly signals: readonly Signal[];
  readonly urlReferences: readonly SafeUrlReference[];
}

/** Error de frontera. El mensaje nombra el campo, nunca el contenido del usuario. */
export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}

/**
 * Verifica que el texto sea realmente redactado, sin confiar en la marca de
 * tipo: `RedactedText` evita errores accidentales, pero un `as` deliberado (o un
 * evento manipulado que cruzo SQS) la burla. `redact()` es idempotente, asi que
 * un texto ya redactado es estable ante una segunda redaccion; si cambia,
 * quedaba PII sin redactar y se RECHAZA. Misma guarda que `buildStoredAnalysis`.
 */
function assertRedacted(value: unknown): RedactedText {
  if (typeof value !== "string") {
    throw new AgentInputError("redactedText debe ser un string redactado.");
  }
  if (value.length === 0) {
    throw new AgentInputError("redactedText no puede estar vacio.");
  }
  if (value.trim().length === 0) {
    throw new AgentInputError("redactedText no puede ser solo espacios.");
  }
  if (value.length > LIMITS.maxMessageLength) {
    throw new AgentInputError(
      `redactedText excede ${LIMITS.maxMessageLength} caracteres.`,
    );
  }
  if (redact(value).text !== value) {
    throw new AgentInputError(
      "redactedText no es estable al re-redactar: contiene contenido sin redactar.",
    );
  }
  return value as RedactedText;
}

/** Valida cardinalidad y forma de las senales, devolviendo copias propias. */
function validateSignals(value: unknown): readonly Signal[] {
  if (!Array.isArray(value)) {
    throw new AgentInputError("signals debe ser un arreglo.");
  }
  if (value.length > LIMITS.maxSignals) {
    throw new AgentInputError(`signals no puede superar ${LIMITS.maxSignals} elementos.`);
  }
  const signals: Signal[] = [];
  for (const raw of value) {
    const parsed = signalSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentInputError("signals contiene una senal con forma invalida.");
    }
    signals.push(parsed.data);
  }
  return Object.freeze(signals);
}

/**
 * Valida las referencias de URL con el esquema compartido de PR-04 y rechaza
 * conflictos de identidad.
 *
 * Dos ids iguales con URLs distintas es un evento manipulado o un bug de
 * serializacion: se falla cerrado en lugar de elegir uno. Un duplicado EXACTO
 * (mismo id, misma URL) se acepta como idempotente y se conserva una sola vez,
 * porque no introduce ambiguedad.
 */
function validateUrlReferences(value: unknown): readonly SafeUrlReference[] {
  if (!Array.isArray(value)) {
    throw new AgentInputError("urlReferences debe ser un arreglo.");
  }

  const byId = new Map<string, string>();
  const references: SafeUrlReference[] = [];
  for (const raw of value) {
    const parsed = safeUrlReferenceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentInputError("urlReferences contiene una referencia invalida.");
    }
    const ref = parsed.data;
    const existing = byId.get(ref.referenceId);
    if (existing !== undefined) {
      if (existing !== ref.reputationUrl) {
        throw new AgentInputError(
          `urlReferences: referenceId duplicado con URL distinta (${ref.referenceId}).`,
        );
      }
      continue; // duplicado exacto: idempotente
    }
    byId.set(ref.referenceId, ref.reputationUrl);
    references.push(Object.freeze({ ...ref }));
  }

  // El limite se aplica DESPUES de deduplicar: un duplicado exacto no consume
  // cupo, igual que en `createUrlAllowlist`.
  if (references.length > URL_LIMITS.maxUrlsPerMessage) {
    throw new AgentInputError(
      `urlReferences no puede superar ${URL_LIMITS.maxUrlsPerMessage} referencias.`,
    );
  }

  return Object.freeze(references);
}

/**
 * Valida la entrada completa ANTES de crear el agente o el contexto. Devuelve
 * una copia congelada: el llamador no conserva un alias mutable hacia lo que el
 * agente va a usar.
 */
export function validateAnalysisAgentInput(input: AnalysisAgentInput): ValidatedAgentInput {
  if (typeof input !== "object" || input === null) {
    throw new AgentInputError("input debe ser un objeto.");
  }

  // El `executionId` primero: sin identidad de ejecucion no hay aislamiento de
  // evidencia ni de allowlist, y nada mas tiene sentido validar.
  const executionId = assertExecutionId(input.executionId, "validateAnalysisAgentInput");

  return Object.freeze({
    executionId,
    redactedText: assertRedacted(input.redactedText),
    signals: validateSignals(input.signals),
    urlReferences: validateUrlReferences(input.urlReferences),
  });
}
