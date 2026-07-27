import { analyzeWithAgent } from "../agent/analyze-with-agent.js";
import {
  buildBedrockProviderConfig,
  createBedrockProvider,
} from "../agent/model/bedrock-provider.js";
import { evaluateRules } from "../detection/rules.js";
import type { SafeUrlReference as DomainSafeUrlReference } from "../domain/analysis-result.js";
import { redact } from "../domain/redaction.js";
import type { AnalysisService } from "../ports/analysis";
import { createInMemoryReputationCache } from "../reputation/cache.js";
import { createVirusTotalProvider } from "../reputation/virustotal.js";
import type { UrlReputationProvider, UrlReputationResult } from "../reputation/provider.js";
import { rehydrateUrlAllowlist } from "../url/allowlist.js";
import type { SafeUrlReference as QueueSafeUrlReference } from "../queue/events";

/** Saludos simples en espanol que no requieren analisis con IA. */
const GREETINGS = [
  /^(hola|ola|alo|aló|buenas?|hey|ey|he?y\b)\s*[.!]*$/i,
  /^(buenos?\s+d[ií]as|buenas?\s+tardes|buenas?\s+noches)\s*[.!]*$/i,
  /^(qu[eé] (tal|hay|cuenta|c pasa| paso)|cómo\s+(est[áa]s|van\s*l[oa]s|and[aá]s)|como\s+estas)\s*[.!?]*$/i,
  /^(q[uo]e\s+dice[s]?|q[uo]e\s+se\s+dice[s]?)\s*[.!?]*$/i,
];

export interface AntiScamAnalysisServiceOptions {
  /** Reloj inyectable para pruebas; nunca almacena estado por ejecucion. */
  readonly now?: () => string;
  /** Limite validado por la configuracion de LambdaProcessor. */
  readonly agentTimeoutMs?: number;
}

/**
 * Crea el servicio de analisis real. El modelo y la cache son neutrales y se
 * reutilizan solo dentro de la Lambda caliente; `analyzeWithAgent` crea un
 * contexto, allowlist y registro de evidencia nuevos por invocacion.
 */
export function createAntiScamAnalysisService(
  options: AntiScamAnalysisServiceOptions = {},
): AnalysisService {
  const vtEnabled = process.env["VIRUSTOTAL_ENABLED"] === "true";

  const now = options.now ?? (() => new Date().toISOString());
  const model = createBedrockProvider(buildBedrockProviderConfig());
  const provider: UrlReputationProvider = vtEnabled && process.env["VIRUSTOTAL_API_KEY"]
    ? createVirusTotalProvider({
        apiKey: process.env["VIRUSTOTAL_API_KEY"],
        transport: async (req) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), req.timeoutMs);
          try {
            const resp = await fetch(`https://www.virustotal.com/api/v3/urls`, {
              method: "POST",
              headers: {
                "x-apikey": req.apiKey,
                "content-type": "application/x-www-form-urlencoded",
              },
              body: `url=${encodeURIComponent(req.url)}`,
              signal: controller.signal,
            });
            const body = await resp.text();
            const bytesRead = Buffer.byteLength(body, "utf8");
            clearTimeout(timer);
            return {
              status: resp.status,
              body,
              bytesRead,
              truncated: bytesRead > req.maxBytes,
            };
          } catch (err) {
            clearTimeout(timer);
            throw err;
          }
        },
        timeoutMs: 5000,
        maxBytes: 65536,
      })
    : createDisabledReputationProvider();
  const cache = createInMemoryReputationCache({ now: () => Date.now() });

  return Object.freeze<AnalysisService>({
    async analyze(input) {
      const redactedText = redact(input.redactedText).text;
      const urlReferences = toDomainReferences(input.urlReferences);

      const lower = redactedText.toLowerCase().trim();
      if (GREETINGS.some((re) => re.test(lower)) && urlReferences.length === 0) {
        return {
          status: "success" as const,
          result: {
            messageId: input.messageId,
            userId: input.userId,
            createdAt: now(),
            riskScore: 0,
            confidence: 100,
            category: null,
            verdict: "likely_legitimate" as const,
            signals: [],
            evidence: [],
            recommendedActions: [],
            shortExplanation: "Mensaje de saludo sin contenido sospechoso.",
            needsMoreInformation: false,
            analysisMethod: "rule",
          },
        };
      }

      const allowlist = rehydrateUrlAllowlist(input.executionId, urlReferences);
      const signals = evaluateRules(redactedText);

      return analyzeWithAgent(
        {
          executionId: input.executionId,
          redactedText,
          signals,
          urlReferences,
        },
        {
          model,
          reputationDeps: { allowlist, provider, cache, now },
          now,
        },
        {
          messageId: input.messageId,
          userId: input.userId,
          inputSignals: signals,
          ...(options.agentTimeoutMs === undefined
            ? {}
            : { limitsOverrides: { timeoutMs: options.agentTimeoutMs } }),
        },
      );
    },
  });
}

function toDomainReferences(
  references: readonly QueueSafeUrlReference[],
): readonly DomainSafeUrlReference[] {
  const copied: DomainSafeUrlReference[] = [];
  for (const reference of references) {
    copied.push(
      Object.freeze({
        referenceId: reference.referenceId,
        reputationUrl: reference.reputationUrl,
      }),
    );
  }
  return Object.freeze(copied);
}

function createDisabledReputationProvider(): UrlReputationProvider {
  return Object.freeze({
    async check(_reputationUrl: string): Promise<UrlReputationResult> {
      return {
        status: "temporary_error",
        source: "virustotal",
        summary: "La reputacion de URL no esta disponible en esta ejecucion.",
      };
    },
  });
}
