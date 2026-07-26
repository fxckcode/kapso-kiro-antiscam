import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { fraudCategorySchema } from "../../domain/agent-evaluation.js";
import { registerEvidence, requireExecutionContext } from "../analysis-execution-context.js";
import { retrieveKnownCases } from "../../known-cases/retrieve-known-cases.js";
import type { KnownCasesQuery } from "../../known-cases/retrieve-known-cases.js";

/**
 * Herramienta `retrieveKnownCases` (PR-06 sec. 10).
 *
 * La busqueda es CERRADA: el modelo solo puede pasar una `category` opcional.
 * Las senales del backend y el texto redactado provienen del contexto de
 * ejecucion (via `invocationState`), no de los argumentos del modelo.
 *
 * Vista para el modelo (sin keywords internas ni detalles de evasion):
 *  - `status: "available"` + `evidenceId` + `cases[{category, summary}]`
 *  - `status: "no_matches"` (sin evidenceId)
 */

type KnownCasesToolView =
  | {
      readonly status: "available";
      readonly evidenceId: string;
      readonly cases: ReadonlyArray<{ readonly category: string; readonly summary: string }>;
    }
  | { readonly status: "no_matches" };

const inputSchema = z
  .object({
    category: fraudCategorySchema.optional(),
  })
  .strict();

export interface RetrieveKnownCasesToolDeps {
  readonly now: () => string;
}

export function createRetrieveKnownCasesTool(deps: RetrieveKnownCasesToolDeps) {
  return tool<typeof inputSchema, KnownCasesToolView>({
    name: "retrieveKnownCases",
    description:
      "Recupera patrones de fraude conocidos relevantes al mensaje analizado. " +
      "Opcionalmente filtra por categoria. Devuelve un evidenceId cuando hay coincidencias.",
    inputSchema,
    callback: async ({ category }, context): Promise<KnownCasesToolView> => {
      const execCtx = requireExecutionContext(
        context?.invocationState,
        "retrieveKnownCases",
      );

      // exactOptionalPropertyTypes: solo incluir `category` si esta definida.
      const query: KnownCasesQuery =
        category !== undefined
          ? {
              category,
              signals: execCtx.signals,
              redactedText: execCtx.redactedText,
            }
          : {
              signals: execCtx.signals,
              redactedText: execCtx.redactedText,
            };

      const outcome = retrieveKnownCases(query, execCtx.executionId, deps.now);

      if (outcome.kind === "no_matches") {
        return { status: "no_matches" };
      }

      const registered = registerEvidence(execCtx, outcome.evidence);

      return {
        status: "available",
        evidenceId: registered.evidenceId,
        cases: outcome.cases,
      };
    },
  });
}
