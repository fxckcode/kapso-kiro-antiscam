import { createHash } from "node:crypto";
import { LIMITS } from "../domain/limits.js";
import { assertExecutionId, assertReferenceId } from "../shared/execution-id.js";

/**
 * Generacion determinista de `evidenceId` (PR04-11).
 *
 * Se elimina la dependencia de un callback arbitrario (que podia devolver ids
 * repetidos): el id se DERIVA de la ejecucion y la referencia mediante SHA-256,
 * con separadores NUL para que los campos no puedan solaparse:
 *
 *   sha256(executionId + "\0" + referenceId + "\0url-reputation")
 *
 * Propiedades:
 *  - misma ejecucion + misma referencia -> mismo id (dos consultas cacheadas
 *    producen el mismo id, no duplicados espurios);
 *  - otra ejecucion -> otro id (aislamiento entre invocaciones);
 *  - otra referencia -> otro id;
 *  - NO revela la URL: solo entra el `referenceId` opaco, jamas la URL;
 *  - sin estado global ni contadores;
 *  - longitud acotada y compatible con `LIMITS.maxIdLength` de PR-01.
 */

/** Dominio de la derivacion. Evita colisiones con otros tipos de evidencia. */
const EVIDENCE_DOMAIN = "url-reputation";

/** Prefijo legible del id. */
const PREFIX = "ev_";

/**
 * Bytes de hash usados (32 hex chars = 128 bits). Suficiente para unicidad
 * practica y muy por debajo de `maxIdLength`.
 */
const HEX_LENGTH = 32;

/**
 * Deriva el `evidenceId` de una consulta de reputacion.
 *
 * @param executionId ejecucion del agente en curso (aislamiento por invocacion).
 * @param referenceId referencia opaca de la allowlist (nunca una URL).
 */
export function deriveUrlReputationEvidenceId(
  executionId: string,
  referenceId: string,
): string {
  // Validacion centralizada (PR04-R04): tipo, vacio, blancos, caracteres de
  // control y `LIMITS.maxIdLength`. No basta con comprobar la cadena vacia.
  assertExecutionId(executionId, "deriveUrlReputationEvidenceId");
  assertReferenceId(referenceId, "deriveUrlReputationEvidenceId");

  const digest = createHash("sha256")
    .update(executionId, "utf8")
    .update("\0", "utf8")
    .update(referenceId, "utf8")
    .update("\0", "utf8")
    .update(EVIDENCE_DOMAIN, "utf8")
    .digest("hex")
    .slice(0, HEX_LENGTH);

  const id = `${PREFIX}${digest}`;
  // Invariante defensiva: nunca exceder el limite de PR-01.
  if (id.length > LIMITS.maxIdLength) {
    throw new Error("deriveUrlReputationEvidenceId: id excede maxIdLength.");
  }
  return id;
}
