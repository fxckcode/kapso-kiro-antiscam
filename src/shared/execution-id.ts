import { LIMITS } from "../domain/limits.js";

/**
 * Validacion CENTRALIZADA de identificadores de ejecucion y de referencia
 * (PR04-R04). Antes, un `executionId` invalido (vacio, espacios, demasiado
 * largo, con caracteres de control) recorria todo el flujo y fallaba tarde
 * dentro de `toolEvidenceSchema`, despues de haber consultado DNS, cache y
 * proveedor externo. Eso es un fallo caro y ruidoso: se valida en la frontera.
 *
 * Reglas (mismo limite que PR-01, `LIMITS.maxIdLength`):
 *  - debe ser string;
 *  - no vacio;
 *  - no solo espacios;
 *  - sin espacios al inicio o al final (evita que `"exec "` y `"exec"` sean
 *    dos claves distintas para la misma ejecucion);
 *  - sin caracteres de control (romperian logs, JSON y claves de cache);
 *  - sin NINGUN whitespace, tampoco interno (PR04-F05): un id es un token
 *    opaco. `"exec id"` no es un identificador: parece dos, se parte al
 *    tokenizar cualquier log y admite colisiones deliberadas con espacios
 *    Unicode anchos que se ven iguales a un espacio normal;
 *  - longitud <= `LIMITS.maxIdLength`.
 */

/** Caracteres de control C0 y DEL. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type IdRejectionReason =
  | "not_a_string"
  | "empty"
  | "blank"
  | "untrimmed"
  | "control_character"
  | "whitespace"
  | "too_long";

export interface IdValidation {
  readonly ok: boolean;
  readonly reason?: IdRejectionReason;
}

/**
 * Cualquier whitespace Unicode, en cualquier posicion. Se comprueba DESPUES de
 * los controles para que `\t` y `\n` conserven el motivo mas especifico
 * (`control_character`); esta regla captura el resto: espacio, NBSP y los
 * espacios anchos de U+2000..U+200A.
 */
const ANY_WHITESPACE = /\s/u;

/** Valida un identificador opaco sin lanzar. */
export function validateId(value: unknown): IdValidation {
  if (typeof value !== "string") return { ok: false, reason: "not_a_string" };
  if (value === "") return { ok: false, reason: "empty" };
  if (value.trim() === "") return { ok: false, reason: "blank" };
  if (value.trim() !== value) return { ok: false, reason: "untrimmed" };
  if (CONTROL_CHARS.test(value)) return { ok: false, reason: "control_character" };
  if (ANY_WHITESPACE.test(value)) return { ok: false, reason: "whitespace" };
  if (value.length > LIMITS.maxIdLength) return { ok: false, reason: "too_long" };
  return { ok: true };
}

export function isValidExecutionId(value: unknown): value is string {
  return validateId(value).ok;
}

/**
 * Devuelve el `executionId` validado o lanza. Se invoca ANTES de crear la
 * allowlist, consultar la cache, consultar el proveedor o derivar un
 * `evidenceId`, de modo que un id invalido no produzca ningun efecto externo.
 */
export function assertExecutionId(value: unknown, context: string): string {
  const check = validateId(value);
  if (!check.ok) {
    throw new RangeError(
      `${context}: executionId invalido (${check.reason ?? "unknown"}); ` +
        `debe ser un string no vacio, sin whitespace ni controles, de hasta ${LIMITS.maxIdLength} caracteres.`,
    );
  }
  return value as string;
}

/** Igual que `assertExecutionId`, para identificadores de referencia. */
export function assertReferenceId(value: unknown, context: string): string {
  const check = validateId(value);
  if (!check.ok) {
    throw new RangeError(
      `${context}: referenceId invalido (${check.reason ?? "unknown"}); ` +
        `debe ser un string no vacio, sin whitespace ni controles, de hasta ${LIMITS.maxIdLength} caracteres.`,
    );
  }
  return value as string;
}
