/**
 * Derivacion determinista del veredicto. El modelo NUNCA produce el veredicto;
 * el backend lo deriva exclusivamente desde `risk_score`.
 *
 * Escala aprobada (PRD.md sec. 8/11, SITEMAP.md sec. 4, UBIQUITOUS_LANGUAGE.md sec. 4):
 *   80-100 -> scam
 *   55-79  -> suspicious
 *   30-54  -> insufficient_information
 *    0-29  -> likely_legitimate
 */
export const VERDICTS = [
  "scam",
  "suspicious",
  "insufficient_information",
  "likely_legitimate",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Umbral inferior (inclusivo) de cada banda. */
export const VERDICT_THRESHOLDS = {
  scam: 80,
  suspicious: 55,
  insufficient_information: 30,
  likely_legitimate: 0,
} as const;

/**
 * Deriva el veredicto desde un `riskScore`. Lanza `RangeError` si el puntaje no
 * es un entero valido en [0, 100]: la validacion del rango es responsabilidad
 * previa del backend (esquema del agente), y un valor fuera de rango indica un
 * error de programacion, no una entrada del usuario.
 */
export function deriveVerdict(riskScore: number): Verdict {
  if (!Number.isInteger(riskScore) || riskScore < 0 || riskScore > 100) {
    throw new RangeError(
      `riskScore debe ser un entero entre 0 y 100, recibido: ${riskScore}`,
    );
  }
  if (riskScore >= VERDICT_THRESHOLDS.scam) return "scam";
  if (riskScore >= VERDICT_THRESHOLDS.suspicious) return "suspicious";
  if (riskScore >= VERDICT_THRESHOLDS.insufficient_information) {
    return "insufficient_information";
  }
  return "likely_legitimate";
}
