import { z } from "zod";
import { LIMITS } from "./limits.js";

/**
 * Una senal es un indicador interno producido por una regla determinista o por
 * el analisis de una URL. Una senal NO es un veredicto: aporta contexto con un
 * peso relativo. El veredicto lo deriva el backend a partir del `risk_score`.
 *
 * Ver UBIQUITOUS_LANGUAGE.md seccion 3 ("Senal") y PRD.md seccion 7.
 */
export const signalSchema = z
  .object({
    /** Identificador estable del tipo de senal, ej. "otp_request". */
    type: z.string().min(1).max(LIMITS.maxSignalTypeLength),
    /** Explicacion corta y legible de la senal. */
    description: z.string().min(1).max(LIMITS.maxSignalDescriptionLength),
    /** Peso relativo de la senal. No es un puntaje de riesgo final. */
    weight: z.number().min(0).max(100),
  })
  .strict();

export type Signal = z.infer<typeof signalSchema>;
