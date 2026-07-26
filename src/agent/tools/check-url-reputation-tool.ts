import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { LIMITS } from "../../domain/limits.js";
import { checkUrlReputation } from "../../reputation/check-url-reputation.js";
import type { CheckUrlReputationDeps } from "../../reputation/check-url-reputation.js";
import { registerEvidence, requireExecutionContext } from "../analysis-execution-context.js";

/**
 * Herramienta `checkUrlReputation` (PR-06 sec. 9).
 *
 * Contrato de argumento: SOLO acepta `referenceId` (opaco). Jamas acepta:
 *  - una URL (evitar que el modelo controle a que host se consulta);
 *  - `executionId` (lo fija el backend via `invocationState`);
 *  - campos adicionales (`.strict()` los rechaza).
 *
 * Contrato de devolucion: el modelo recibe SOLO lo necesario para citar evidencia.
 * Nunca recibe: URL, API key, cuerpo del proveedor, `executionId`, datos de
 * cache, errores internos de AWS.
 *
 * Vista segura:
 *  - `available`: resultado real con malicia; devuelve `evidenceId` + `summary`.
 *  - `no_data`: URL revisada, sin datos; `evidenceId` NOT presente en la vista
 *    (el modelo no debe inferir "limpia"; solo "sin datos"), pero SI se registra
 *    internamente para trazabilidad de procedencia.
 *  - `degraded`: proveedor no disponible.
 *  - `unknown_reference`: id no valido en esta ejecucion.
 *
 * Idempotencia: registrar dos veces la misma evidencia (acierto de cache) no
 * duplica el registro ni lanza.
 */

type ReputationToolView =
  | { readonly status: "available"; readonly evidenceId: string; readonly summary: string }
  | { readonly status: "no_data" }
  | { readonly status: "degraded" }
  | { readonly status: "unknown_reference" };

const inputSchema = z
  .object({
    referenceId: z.string().min(1).max(LIMITS.maxIdLength),
  })
  .strict();

/**
 * Dependencias de la herramienta. Las neutrales (proveedor, cache, reloj) se
 * pueden compartir entre ejecuciones; el contexto especifico viaja por
 * `invocationState`, no por closure.
 */
export function createCheckUrlReputationTool(deps: CheckUrlReputationDeps) {
  return tool<typeof inputSchema, ReputationToolView>({
    name: "checkUrlReputation",
    description:
      "Consulta la reputacion de una URL por su referenceId. " +
      "Devuelve un evidenceId cuando hay datos de reputacion disponibles.",
    inputSchema,
    callback: async ({ referenceId }, context): Promise<ReputationToolView> => {
      const execCtx = requireExecutionContext(
        context?.invocationState,
        "checkUrlReputation",
      );

      const outcome = await checkUrlReputation(
        referenceId,
        execCtx.executionId,
        {
          allowlist: execCtx.allowlist,
          provider: deps.provider,
          cache: deps.cache,
          now: deps.now,
        },
      );

      if (outcome.kind === "unknown_reference") {
        return { status: "unknown_reference" };
      }

      if (outcome.kind === "degraded") {
        return { status: "degraded" };
      }

      // outcome.kind === "evidence": tanto "available" como "no_data" llegan aqui.
      // Para distinguirlos consultamos la cache DESPUES de que el servicio la
      // poblo (la cache acepta ambos estados). Esto es necesario porque
      // `CheckUrlReputationOutcome["evidence"]` no expone el status original.
      const reference = execCtx.allowlist.resolve(referenceId, execCtx.executionId);
      const cached = reference !== null ? deps.cache.get(reference.reputationUrl) : null;

      // Registrar siempre, incluyendo no_data, para trazabilidad de procedencia.
      const registered = registerEvidence(execCtx, outcome.evidence);

      if (cached?.status === "no_data") {
        // Sin evidenceId en la vista: el modelo no puede inferir que la URL es
        // segura solo porque no hay datos de malicia.
        return { status: "no_data" };
      }

      // "available" o cache miss (no deberia ocurrir tras el servicio, pero se
      // trata como "available" como degradacion segura).
      return {
        status: "available",
        evidenceId: registered.evidenceId,
        summary: registered.summary,
      };
    },
  });
}
