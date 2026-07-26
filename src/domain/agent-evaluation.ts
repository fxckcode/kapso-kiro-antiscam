import { z } from "zod";
import { LIMITS } from "./limits.js";

/**
 * Categorias de fraude aprobadas. Ver UBIQUITOUS_LANGUAGE.md seccion 4.
 * El agente puede devolver `null` cuando no hay categoria clara.
 */
export const FRAUD_CATEGORIES = [
  "phishing_bancario",
  "premio_falso",
  "suplantacion",
  "inversion_falsa",
  "familiar_en_apuros",
  "otro",
] as const;

export const fraudCategorySchema = z.enum(FRAUD_CATEGORIES);
export type FraudCategory = z.infer<typeof fraudCategorySchema>;

/**
 * Evaluacion estructurada producida por el agente (Strands + Bedrock).
 *
 * INVARIANTES (prompt maestro secciones 6, 9, 10):
 *  - NO contiene `verdict` (lo deriva el backend desde `risk_score`).
 *  - NO contiene `signals` (las calcula el backend y las pasa como contexto).
 *  - `evidence_ids` son solo REFERENCIAS a `ToolEvidence` reales de la
 *    invocacion; el backend descarta cualquier id sin procedencia.
 *  - Esquema estricto (`.strict()`): se rechazan campos desconocidos.
 *  - Sin coercion: `risk_score`/`confidence` deben venir como numeros; una
 *    cadena "82" se rechaza. Un `evidence_id` repetido se acepta a nivel de
 *    schema y la deduplicacion la garantiza `resolveVerifiedEvidence` (ASB-05).
 */
export const agentEvaluationSchema = z
  .object({
    risk_score: z.number().finite().int().min(0).max(100),
    confidence: z.number().finite().min(0).max(1),
    category: fraudCategorySchema.nullable(),
    evidence_ids: z
      .array(z.string().min(1).max(LIMITS.maxIdLength))
      .max(LIMITS.maxEvidenceIds)
      .default([]),
    recommended_actions: z
      .array(z.string().min(1).max(LIMITS.maxRecommendedActionLength))
      .min(1)
      .max(LIMITS.maxRecommendedActions),
    short_explanation: z.string().min(1).max(LIMITS.maxShortExplanationLength),
    needs_more_information: z.boolean(),
  })
  .strict();

export type AgentEvaluation = z.infer<typeof agentEvaluationSchema>;

/**
 * Valida de forma segura una evaluacion candidata del agente. Devuelve un
 * resultado discriminado en lugar de lanzar, para que el backend pueda producir
 * una respuesta prudente cuando la salida es invalida (prompt maestro sec. 11).
 */
export type AgentEvaluationParseResult =
  | { readonly ok: true; readonly value: AgentEvaluation }
  | { readonly ok: false; readonly error: z.ZodError };

export function parseAgentEvaluation(input: unknown): AgentEvaluationParseResult {
  const result = agentEvaluationSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, error: result.error };
}
