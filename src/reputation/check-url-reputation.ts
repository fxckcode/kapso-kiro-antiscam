import { toolEvidenceSchema } from "../domain/evidence.js";
import type { ToolEvidence } from "../domain/evidence.js";
import { isValidExecutionId } from "../shared/execution-id.js";
import type { UrlAllowlist } from "../url/allowlist.js";
import type { ReputationCache } from "./cache.js";
import { deriveUrlReputationEvidenceId } from "./evidence-id.js";
import type { UrlReputationProvider, UrlReputationResult } from "./provider.js";

/**
 * Servicio `checkUrlReputation(referenceId)`, INDEPENDIENTE de Strands. Es la
 * unica via por la que se consulta reputacion, y solo acepta un `referenceId`
 * existente en la allowlist de la invocacion. El agente nunca proporciona una
 * URL. Ver prompt maestro sec. 7/8 y SITEMAP.md sec. 5.
 *
 * Flujo:
 *   referenceId
 *     -> resolver allowlist de executionId
 *     -> consultar cache (clave = reputationUrl, sin query)
 *     -> si miss, consultar proveedor con la reputationUrl
 *     -> guardar resultado permitido (estable) en cache
 *     -> devolver ToolEvidence (cuando hay resultado real) o estado degradado
 *
 * Privacidad (PR04-06): al proveedor y a la cache SOLO viaja `reputationUrl`
 * (sin query). La `navigationUrl` no sale de la allowlist: no se loguea, no se
 * cachea y no aparece en la evidencia.
 *
 * Modo degradado: si el proveedor falla o agota cuota, NO se lanza un veredicto,
 * NO se inventa evidencia; se devuelve un estado degradado controlado para que
 * el analisis continue posteriormente.
 *
 * Unicidad de evidencia (PR04-11): el `evidenceId` se DERIVA de
 * (executionId, referenceId); no depende de un callback que pueda repetirlo.
 */

export type CheckUrlReputationOutcome =
  | { readonly kind: "evidence"; readonly evidence: ToolEvidence }
  | {
      readonly kind: "unknown_reference"; // referenceId no valido en esta ejecucion
    }
  | {
      readonly kind: "degraded";
      readonly status: UrlReputationResult["status"];
      readonly summary: string;
    };

export interface CheckUrlReputationDeps {
  readonly allowlist: UrlAllowlist;
  readonly provider: UrlReputationProvider;
  readonly cache: ReputationCache;
  /** Reloj inyectable: devuelve un ISO-8601 con `Z`. Mantiene tests deterministas. */
  readonly now: () => string;
}

/** Estados que representan un resultado real de herramienta (producen evidencia). */
const PRODUCES_EVIDENCE: ReadonlySet<UrlReputationResult["status"]> = new Set([
  "available",
  "no_data",
]);

export async function checkUrlReputation(
  referenceId: string,
  executionId: string,
  deps: CheckUrlReputationDeps,
): Promise<CheckUrlReputationOutcome> {
  // 0. Validar identificadores ANTES de cualquier efecto: sin allowlist, sin
  // cache, sin proveedor, sin derivar evidencia. Un executionId invalido no
  // puede "colarse" hasta `toolEvidenceSchema` y fallar tarde, cuando ya se
  // habria consultado la red. Se responde `unknown_reference` porque una
  // referencia no puede ser valida en una ejecucion que no existe, y asi el
  // agente no obtiene informacion sobre la forma de los ids. (PR04-R04.)
  if (!isValidExecutionId(executionId)) {
    return { kind: "unknown_reference" };
  }
  if (!isValidExecutionId(referenceId)) {
    return { kind: "unknown_reference" };
  }

  // 1. Resolver la allowlist DENTRO de la ejecucion.
  const reference = deps.allowlist.resolve(referenceId, executionId);
  if (!reference) {
    return { kind: "unknown_reference" };
  }

  // 2/3. Cache -> proveedor. La clave es la URL de reputacion (sin query) y
  // nunca se registra. La cache es neutral: no conoce executionId ni evidencia.
  const cacheKey = reference.reputationUrl;
  let reputation = deps.cache.get(cacheKey);
  if (!reputation) {
    reputation = await deps.provider.check(reference.reputationUrl);
    // 4. La cache decide por si misma que estados son cacheables.
    deps.cache.set(cacheKey, reputation);
  }

  // 5. Modo degradado: no se inventa evidencia ni se lanza un veredicto.
  if (!PRODUCES_EVIDENCE.has(reputation.status)) {
    return { kind: "degraded", status: reputation.status, summary: reputation.summary };
  }

  // 6. Producir ToolEvidence verificada, con el executionId aprobado en PR-01.
  // El id es determinista por (executionId, referenceId): dos consultas
  // cacheadas de la misma referencia producen el mismo evidenceId.
  const evidence: ToolEvidence = toolEvidenceSchema.parse({
    evidenceId: deriveUrlReputationEvidenceId(executionId, referenceId),
    executionId,
    toolName: "checkUrlReputation",
    referenceId,
    source: reputation.source,
    summary: reputation.summary,
    observedAt: deps.now(),
  });

  return { kind: "evidence", evidence };
}
