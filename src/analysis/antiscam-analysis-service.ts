/**
 * Adaptador entre el evento Kapso ya sanitizado y el nucleo aprobado de
 * AntiScamBot (reglas + PR-06). No contiene logica de agente ni transporte HTTP
 * de reputacion: ambas responsabilidades permanecen en los modulos copiados.
 */
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
import type { UrlReputationProvider, UrlReputationResult } from "../reputation/provider.js";
import { rehydrateUrlAllowlist } from "../url/allowlist.js";
import type { SafeUrlReference as QueueSafeUrlReference } from "../queue/events";

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
  assertVirusTotalIsDisabled();

  const now = options.now ?? (() => new Date().toISOString());
  const model = createBedrockProvider(buildBedrockProviderConfig());
  const provider = createDisabledReputationProvider();
  const cache = createInMemoryReputationCache({ now: () => Date.now() });

  // El argumento de tipo explicito es necesario: sin el, `Object.freeze` no
  // propaga el contexto de `AnalysisService` al literal y `input` queda `any`.
  return Object.freeze<AnalysisService>({
    async analyze(input) {
      // Redactar otra vez es intencionalmente idempotente: el texto ya llega
      // sanitizado desde SQS, pero esta frontera no confia en una marca de tipo.
      const redactedText = redact(input.redactedText).text;
      const urlReferences = toDomainReferences(input.urlReferences);

      // Validacion explicita antes de crear el agente: un evento SQS alterado
      // nunca llega a DNS, cache, proveedor ni modelo con una URL no enrutable.
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
          ...(options.agentTimeoutMs === undefined
            ? {}
            : { limitsOverrides: { timeoutMs: options.agentTimeoutMs } }),
        },
      );
    },
  });
}

/** Copia estructural sin cast entre el contrato SQS y el contrato de dominio. */
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

/**
 * El transporte productivo de VirusTotal no forma parte de esta integracion.
 * El estado degradado permite que el agente use reglas y casos conocidos sin
 * declarar que una URL es segura ni generar evidencia ficticia.
 */
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

/**
 * No existe un adaptador HTTP seguro para VirusTotal en este repositorio. Si
 * alguien habilita la variable antes de implementarlo, fallar al iniciar es
 * preferible a enviar URLs a un transporte incompleto o simulado.
 */
function assertVirusTotalIsDisabled(): void {
  const configured = process.env["VIRUSTOTAL_ENABLED"];
  if (configured !== undefined && configured !== "false") {
    throw new Error("VIRUSTOTAL_ENABLED requiere un transporte de produccion auditado.");
  }
}
