import { z } from "zod";
import { LIMITS } from "./limits.js";

/**
 * Nombres de las herramientas cerradas de solo lectura disponibles para el
 * agente. Ver SITEMAP.md seccion 5 y PRD.md seccion 5.
 */
export const TOOL_NAMES = ["checkUrlReputation", "retrieveKnownCases"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Registro de procedencia de una invocacion de herramienta durante una unica
 * ejecucion del agente. Es la fuente de verdad de la evidencia: el agente solo
 * puede REFERENCIAR estos registros por `evidenceId`, nunca inventarlos.
 *
 * `executionId` aisla la evidencia por ejecucion: la validacion de procedencia
 * exige que cada evidencia citada pertenezca a la ejecucion en curso, de modo
 * que no se pueda "arrastrar" evidencia de otra invocacion. (Hallazgo ASB-01.)
 *
 * Ver el prompt maestro seccion 9 ("Procedencia de evidencia").
 */
export const toolEvidenceSchema = z
  .object({
    /** Id opaco valido solo dentro de la invocacion. */
    evidenceId: z.string().min(1).max(LIMITS.maxIdLength),
    /** Id de la ejecucion del agente a la que pertenece esta evidencia. */
    executionId: z.string().min(1).max(LIMITS.maxIdLength),
    toolName: z.enum(TOOL_NAMES),
    /** Referencia de allowlist asociada, cuando aplica (checkUrlReputation). */
    referenceId: z.string().min(1).max(LIMITS.maxIdLength).optional(),
    /** Fuente de la evidencia, ej. "virustotal", "known_cases". */
    source: z.string().min(1).max(LIMITS.maxSourceLength),
    /** Resumen legible del resultado real de la herramienta. */
    summary: z.string().min(1).max(LIMITS.maxEvidenceSummaryLength),
    /** Momento de observacion en ISO 8601. */
    observedAt: z.string().datetime(),
  })
  .strict();

export type ToolEvidence = z.infer<typeof toolEvidenceSchema>;

/**
 * Evidencia externa tal como se persiste y se muestra al usuario. Nunca contiene
 * enlaces sospechosos clicables; `reference` es un dominio ofuscado o referencia
 * segura. Ver PRD.md seccion 8 y seccion 10.
 */
export const externalEvidenceSchema = z
  .object({
    source: z.string().min(1).max(LIMITS.maxSourceLength),
    summary: z.string().min(1).max(LIMITS.maxEvidenceSummaryLength),
    /** Referencia segura/ofuscada, nunca una URL clicable. */
    reference: z.string().min(1).max(LIMITS.maxIdLength).optional(),
  })
  .strict();

export type ExternalEvidence = z.infer<typeof externalEvidenceSchema>;

/**
 * Proyecta un registro de procedencia verificado a la evidencia externa que se
 * conserva en el resultado final. Devuelve un objeto nuevo (sin alias mutable).
 * Solo debe usarse con evidencia cuya procedencia ya fue confirmada
 * (ver `resolveVerifiedEvidence`).
 */
export function toExternalEvidence(evidence: ToolEvidence): ExternalEvidence {
  const external: ExternalEvidence = {
    source: evidence.source,
    summary: evidence.summary,
  };
  if (evidence.referenceId !== undefined) {
    external.reference = evidence.referenceId;
  }
  return external;
}
