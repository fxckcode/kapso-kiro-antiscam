/**
 * Limites centralizados de longitud/cardinalidad para los schemas del dominio.
 * Evita valores ilimitados en la salida del agente y en la evidencia. Los
 * valores son razonables para WhatsApp; se documentan aqui porque los .md no
 * fijan numeros exactos. (Hallazgo ASB-05.)
 */
export const LIMITS = {
  // Evidencia y referencias
  maxEvidenceIds: 20,
  maxIdLength: 128,
  maxSourceLength: 100,
  maxEvidenceSummaryLength: 500,

  // Salida del agente
  maxShortExplanationLength: 600,
  maxRecommendedActions: 8,
  maxRecommendedActionLength: 300,

  // Senales (contexto del backend, no del agente)
  maxSignals: 30,
  maxSignalTypeLength: 64,
  maxSignalDescriptionLength: 280,

  // Mensaje de entrada (ver src/domain/message.ts)
  maxMessageLength: 4096,

  // Retencion
  maxTtlDays: 365,
} as const;
