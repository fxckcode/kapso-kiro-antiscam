import { z } from "zod";
import type { AgentEvaluation, FraudCategory } from "./agent-evaluation.js";
import { toExternalEvidence } from "./evidence.js";
import type { ExternalEvidence, ToolEvidence } from "./evidence.js";
import { LIMITS } from "./limits.js";
import { resolveVerifiedEvidence } from "./provenance.js";
import { redact } from "./redaction.js";
import type { RedactedText } from "./redaction.js";
import { signalSchema } from "./signal.js";
import type { Signal } from "./signal.js";
import { deriveVerdict } from "./verdict.js";
import type { Verdict } from "./verdict.js";

/** Limites del contrato compartido de URL (PR04-R01). */
export const URL_REFERENCE_LIMITS = {
  /** Longitud maxima de una `reputationUrl` serializable. */
  maxReputationUrlLength: 2048,
} as const;

/** Caracteres de control: nunca admisibles en un id ni en una URL serializada. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * UNICA referencia a URL que cruza la frontera de proceso (LambdaWebhook -> SQS
 * -> LambdaProcessor) y unica entrada aceptada por `checkUrlReputation`.
 *
 * Solo transporta la URL de REPUTACION: sin query y sin fragmento. La URL de
 * navegacion (con query) es un detalle RUNTIME de la allowlist de PR-04 y NO
 * puede serializarse: un `token`, `code` o `session` en la query cruzaria la
 * cola y quedaria en logs, DLQ y metricas. (Hallazgo PR04-R01.)
 */
export interface SafeUrlReference {
  /** Id opaco valido solo durante la invocacion. No contiene la URL. */
  readonly referenceId: string;
  /**
   * URL normalizada http/https, SIN query ni fragmento. Apta para caches,
   * proveedores de reputacion y serializacion en SQS.
   */
  readonly reputationUrl: string;
}

/**
 * true si `value` es una URL de reputacion serializable: http/https, sin
 * credenciales, sin query, sin fragmento, con host en minusculas y sin punto
 * final, y en la forma CANONICA de WHATWG `URL` (para que dos representaciones
 * de la misma URL no produzcan dos claves de cache distintas).
 */
function isCanonicalReputationUrl(value: string): boolean {
  if (CONTROL_CHARS.test(value)) return false;
  // Cualquier `?`/`#` textual queda descartado antes de parsear.
  if (value.includes("?") || value.includes("#")) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  if (url.hostname === "") return false;
  if (url.hostname !== url.hostname.toLowerCase()) return false;
  if (url.hostname.endsWith(".")) return false;
  return url.toString() === value;
}

/** Id opaco: sin `/`, `?`, espacios ni caracteres de control. */
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Validacion runtime del contrato serializable. Se aplica en la frontera (al
 * preparar el evento y al rehidratar la allowlist en otro proceso), de modo que
 * ni un mensaje corrupto ni un cast deliberado introduzcan una URL con query.
 */
export const safeUrlReferenceSchema = z
  .object({
    referenceId: z
      .string()
      .min(1)
      .max(LIMITS.maxIdLength)
      .regex(REFERENCE_ID_PATTERN, "referenceId debe ser un id opaco sin URL."),
    reputationUrl: z
      .string()
      .min(1)
      .max(URL_REFERENCE_LIMITS.maxReputationUrlLength)
      .refine(
        isCanonicalReputationUrl,
        "reputationUrl debe ser http/https normalizada, sin query ni fragmento.",
      ),
  })
  .strict();

/**
 * Evento minimizado que sale de LambdaWebhook hacia SQS. NUNCA contiene
 * contenido crudo: solo texto redactado, referencias URL sanitizadas y
 * metadatos minimos. `userId` es el usuario seudonimizado (HMAC-SHA256).
 */
export interface InboundMessage {
  readonly messageId: string;
  readonly userId: string;
  readonly redactedText: RedactedText;
  readonly urlReferences: readonly SafeUrlReference[];
  /** ISO 8601 UTC. */
  readonly receivedAt: string;
}

/**
 * Resultado de analisis final que agrega la evaluacion del agente con el
 * `Signal[]` del backend, la evidencia verificada y el veredicto derivado.
 */
export interface AnalysisResult {
  readonly messageId: string;
  readonly userId: string;
  /** ISO 8601 UTC normalizado. */
  readonly createdAt: string;
  readonly riskScore: number;
  readonly confidence: number;
  readonly category: FraudCategory | null;
  readonly verdict: Verdict;
  readonly signals: readonly Signal[];
  readonly evidence: readonly ExternalEvidence[];
  readonly recommendedActions: readonly string[];
  readonly shortExplanation: string;
  readonly needsMoreInformation: boolean;
  readonly analysisMethod: string;
}

/**
 * Normaliza un timestamp exigiendo ISO/RFC3339 en UTC (`Z`). Rechaza fechas sin
 * hora, sin zona o invalidas. Devuelve la forma canonica de `toISOString()`.
 * (Hallazgo ASB-06.)
 */
export function normalizeUtcTimestamp(value: string): string {
  // Debe declarar zona UTC explicita con `Z` y contener parte de hora (`T`).
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(
    value,
  );
  if (!match) {
    throw new RangeError(
      `Timestamp debe ser ISO 8601 UTC con 'Z' y hora, recibido: ${value}`,
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Timestamp invalido: ${value}`);
  }
  const date = new Date(ms);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new RangeError(`Timestamp invalido: ${value}`);
  }
  return date.toISOString();
}

/** Copia profunda de una senal (objeto plano de primitivos), tras validar forma. */
function cloneSignal(signal: Signal): Signal {
  return signalSchema.parse({ ...signal });
}

/** Valida cardinalidad y clona senales sin retener aliases del input. */
function cloneSignals(signals: readonly Signal[]): Signal[] {
  if (signals.length > LIMITS.maxSignals) {
    throw new RangeError(`signals no puede superar ${LIMITS.maxSignals} elementos.`);
  }
  return signals.map(cloneSignal);
}

export interface BuildAnalysisResultInput {
  readonly messageId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly evaluation: AgentEvaluation;
  /** Senales calculadas por el backend (no por el agente). */
  readonly signals: readonly Signal[];
  /** Registro real de herramientas de la invocacion, para verificar procedencia. */
  readonly toolEvidence: readonly ToolEvidence[];
  /** Id de la ejecucion en curso, para aislar la evidencia. */
  readonly executionId: string;
}

/**
 * Construye el resultado final a partir de una evaluacion valida del agente:
 *  - normaliza `createdAt` a UTC canonico;
 *  - deriva el veredicto desde `risk_score`;
 *  - descarta la evidencia citada sin procedencia o de otra ejecucion;
 *  - adjunta COPIAS del `Signal[]` del backend (sin alias mutable).
 */
export function buildAnalysisResult(input: BuildAnalysisResultInput): AnalysisResult {
  const { evaluation } = input;
  const verified = resolveVerifiedEvidence(
    evaluation.evidence_ids,
    input.toolEvidence,
    input.executionId,
  );

  return {
    messageId: input.messageId,
    userId: input.userId,
    createdAt: normalizeUtcTimestamp(input.createdAt),
    riskScore: evaluation.risk_score,
    confidence: evaluation.confidence,
    category: evaluation.category,
    verdict: deriveVerdict(evaluation.risk_score),
    signals: cloneSignals(input.signals),
    evidence: verified.map(toExternalEvidence),
    recommendedActions: [...evaluation.recommended_actions],
    shortExplanation: evaluation.short_explanation,
    needsMoreInformation: evaluation.needs_more_information,
    analysisMethod: "agent; verdict derived by backend",
  };
}

export interface BuildCautiousResultInput {
  readonly messageId: string;
  readonly userId: string;
  readonly createdAt: string;
  /** Senales del backend, si se alcanzaron a calcular. */
  readonly signals?: readonly Signal[];
  readonly shortExplanation?: string;
}

/**
 * Respuesta prudente cuando la evaluacion del agente es invalida, incompleta o
 * no puede verificarse. NO declara que el contenido es seguro: usa
 * `insufficient_information` (riesgo 30) con confianza baja y no inventa
 * evidencia. (Prompt maestro sec. 11; hallazgo ASB-08 verificado en PR-01.)
 */
export function buildCautiousResult(input: BuildCautiousResultInput): AnalysisResult {
  const riskScore = 30; // banda insufficient_information
  return {
    messageId: input.messageId,
    userId: input.userId,
    createdAt: normalizeUtcTimestamp(input.createdAt),
    riskScore,
    confidence: 0.2,
    category: null,
    verdict: deriveVerdict(riskScore),
    signals: cloneSignals(input.signals ?? []),
    evidence: [],
    recommendedActions: [
      "No abras enlaces ni entregues datos hasta confirmarlo por un canal oficial.",
      "Vuelve a enviar el mensaje o pide 'mas info' para reintentar el analisis.",
    ],
    shortExplanation:
      input.shortExplanation ??
      "No pudimos completar el analisis con seguridad. Trata el mensaje con precaucion.",
    needsMoreInformation: true,
    analysisMethod: "cautious fallback; verdict derived by backend",
  };
}

/**
 * Registro de analisis tal como se persiste en DynamoDB. La infraestructura la
 * implementa Persona C; aqui se define el contrato de forma. Ver SITEMAP.md sec. 6.
 */
export interface StoredAnalysis {
  readonly PK: string; // MSG#<messageId>
  readonly SK: "ANALYSIS";
  readonly GSI1PK: string; // USER#<hmac>
  readonly GSI1SK: string; // <createdAt> UTC canonico
  readonly messageId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly redactedMessage: RedactedText;
  readonly riskScore: number;
  readonly confidence: number;
  readonly verdict: Verdict;
  readonly category: FraudCategory | null;
  readonly signals: readonly Signal[];
  readonly evidence: readonly ExternalEvidence[];
  readonly analysisMethod: string;
  /** Epoch en SEGUNDOS enteros para expiracion por TTL de DynamoDB. */
  readonly ttl: number;
}

const SECONDS_PER_DAY = 86_400;

export interface BuildStoredAnalysisInput {
  readonly result: AnalysisResult;
  /**
   * Texto redactado del mensaje (unica version persistible). Exige `RedactedText`:
   * el unico productor legitimo es `redact()`. (Hallazgo ASB-03.)
   */
  readonly redactedMessage: RedactedText;
  /** Retencion en dias; por defecto 7 (PRD.md sec. 10). Entero en [1, 365]. */
  readonly ttlDays?: number;
}

/**
 * Proyecta un `AnalysisResult` al item persistible.
 *
 * Comprobacion defensiva (ASB-03): re-redacta `redactedMessage`; si el contenido
 * cambia, significa que quedo PII sin redactar (o el valor fue forzado con un
 * cast indebido) y se RECHAZA la construccion. La `createdAt` ya viene
 * normalizada desde los builders; `GSI1SK` reutiliza esa forma canonica.
 */
export function buildStoredAnalysis(input: BuildStoredAnalysisInput): StoredAnalysis {
  const { result } = input;

  // Guarda de idempotencia: el texto debe ser estable ante una segunda redaccion.
  const reRedacted = redact(input.redactedMessage);
  if (reRedacted.text !== input.redactedMessage) {
    throw new Error(
      "redactedMessage no es estable al re-redactar: contiene contenido sin redactar.",
    );
  }

  const ttlDays = input.ttlDays ?? 7;
  if (!Number.isInteger(ttlDays) || ttlDays <= 0 || ttlDays > LIMITS.maxTtlDays) {
    throw new RangeError(
      `ttlDays debe ser un entero en [1, ${LIMITS.maxTtlDays}], recibido: ${ttlDays}`,
    );
  }

  const createdAt = normalizeUtcTimestamp(result.createdAt);
  const ttlSeconds = Math.floor(Date.parse(createdAt) / 1000) + ttlDays * SECONDS_PER_DAY;

  return {
    PK: `MSG#${result.messageId}`,
    SK: "ANALYSIS",
    GSI1PK: `USER#${result.userId}`,
    GSI1SK: createdAt,
    messageId: result.messageId,
    userId: result.userId,
    createdAt,
    redactedMessage: input.redactedMessage,
    riskScore: result.riskScore,
    confidence: result.confidence,
    verdict: result.verdict,
    category: result.category,
    signals: result.signals.map(cloneSignal),
    evidence: result.evidence.map((e) => ({ ...e })),
    analysisMethod: result.analysisMethod,
    ttl: ttlSeconds,
  };
}
