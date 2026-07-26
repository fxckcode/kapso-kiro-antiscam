import { toolEvidenceSchema } from "./evidence.js";
import type { ToolEvidence } from "./evidence.js";

/**
 * Filtra los `evidenceIds` citados por el agente conservando solo los que:
 *  - existen en el registro real de herramientas, y
 *  - pertenecen a la ejecucion en curso (`executionId === currentExecutionId`).
 *
 * Descarta ids inventados, ids de otra ejecucion e ids repetidos (conservando
 * el primer orden de aparicion). Devuelve COPIAS de los registros, nunca
 * referencias mutables del `registry`, para que el llamador no pueda alterar la
 * fuente de verdad.
 *
 * Determinismo ante duplicados en el registro: si el `registry` contiene varios
 * registros con el mismo `evidenceId`, gana el PRIMERO en el orden del arreglo
 * (comportamiento documentado y cubierto por prueba).
 *
 * Prompt maestro sec. 9; invariantes PRD.md sec. 12 y UBIQUITOUS_LANGUAGE.md
 * sec. 7. (Hallazgo ASB-01.)
 */
export function resolveVerifiedEvidence(
  evidenceIds: readonly string[],
  registry: readonly ToolEvidence[],
  currentExecutionId: string,
): ToolEvidence[] {
  // Indexa por evidenceId; conserva la PRIMERA aparicion ante duplicados.
  const byId = new Map<string, ToolEvidence>();
  for (const evidence of registry) {
    if (!byId.has(evidence.evidenceId)) {
      byId.set(evidence.evidenceId, evidence);
    }
  }

  const verified: ToolEvidence[] = [];
  const seen = new Set<string>();

  for (const id of evidenceIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const match = byId.get(id);
    if (!match) continue; // id inventado o inexistente
    if (match.executionId !== currentExecutionId) continue; // otra ejecucion

    // Copia defensiva: no exponer la referencia mutable del registro.
    verified.push(cloneEvidence(match));
  }

  return verified;
}

/** Copia superficial suficiente: `ToolEvidence` solo contiene primitivos. */
function cloneEvidence(evidence: ToolEvidence): ToolEvidence {
  return toolEvidenceSchema.parse({ ...evidence });
}
