/**
 * Herramienta `analyzeScam` para el agente conversacional.
 *
 * La herramienta ejecuta las reglas deterministas de deteccion (evaluateRules)
 * sobre el texto sospechoso y devuelve un analisis estructurado que el agente
 * conversacional puede compartir con el usuario.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { evaluateRules } from "../../detection/rules.js";
import { redact } from "../../domain/redaction.js";

const inputSchema = z
  .object({
    /** Texto sospechoso a analizar (ya redactado, sin datos sensibles). */
    messageText: z.string().min(1).max(10000),
  })
  .strict();

interface AnalyzeScamView {
  readonly riskScore: number;
  readonly verdict: string;
  readonly explanation: string;
  readonly signalsFound: readonly string[];
  readonly recommendedActions: readonly string[];
}

/** Calcula puntaje agregado: suma de pesos, con tope en 100. */
function totalRiskScore(signalWeights: readonly number[]): number {
  let sum = 0;
  for (const w of signalWeights) sum += w;
  return sum > 100 ? 100 : sum;
}

export function createAnalyzeScamTool() {
  return tool<typeof inputSchema, AnalyzeScamView>({
    name: "analyzeScam",
    description:
      "Analiza un mensaje en busca de senales de estafa o fraude. " +
      "Devuelve un puntaje de riesgo y acciones recomendadas. " +
      "Usa cuando el usuario pida verificar un mensaje sospechoso.",
    inputSchema,
    callback: async ({ messageText }): Promise<AnalyzeScamView> => {
      const redacted = redact(messageText).text;
      const signals = evaluateRules(redacted);

      if (signals.length === 0) {
        return {
          riskScore: 0,
          verdict: "✅ Sin riesgo detectado",
          explanation:
            "El mensaje no activo ninguna regla de deteccion automatica.",
          signalsFound: [],
          recommendedActions: [
            "Siempre verifica la identidad del remitente por otro canal.",
          ],
        };
      }

      const riskScore = totalRiskScore(signals.map((s) => s.weight));

      const verdictLabel =
        riskScore >= 80
          ? "🚨 ALTO RIESGO: Parece una estafa"
          : riskScore >= 55
            ? "⚠️ CUIDADO: Hay senales sospechosas"
            : "ℹ️ Algunas senales detectadas";

      return {
        riskScore,
        verdict: verdictLabel,
        explanation: `Se detectaron ${signals.length} senal(es) de riesgo. Puntaje: ${riskScore}/100.`,
        signalsFound: signals.map((s) => s.description),
        recommendedActions: [
          "No compartas codigos ni datos personales.",
          "Verifica por un canal oficial.",
          "Si hay enlace, no hagas clic sin verificar.",
        ],
      };
    },
  });
}
