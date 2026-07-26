import { LIMITS } from "./limits.js";

/**
 * Contrato del mensaje de entrada (validacion pura). Modulo sin efectos: NO se
 * integra todavia con LambdaWebhook. (Hallazgo ASB-02.)
 *
 * La longitud se mide en PUNTOS DE CODIGO Unicode (`Array.from(text).length`),
 * no en unidades UTF-16 ni en grafemas. Un emoji fuera del BMP cuenta como 1;
 * una secuencia de caracteres combinados (ej. base + diacritico) cuenta cada
 * punto de codigo por separado (documentado, no es un bug).
 */
export const MAX_MESSAGE_LENGTH = LIMITS.maxMessageLength; // 4096

export type MessageValidationError =
  | "not_a_string"
  | "empty"
  | "whitespace_only"
  | "too_long";

export type MessageValidationResult =
  | { readonly ok: true; readonly value: string; readonly length: number }
  | { readonly ok: false; readonly error: MessageValidationError; readonly length: number };

/** Cuenta puntos de codigo Unicode. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Valida el texto de un mensaje sin mutarlo ni truncarlo. Devuelve un resultado
 * explicito; no lanza ante entradas normales invalidas.
 *
 *  - rechaza no-strings;
 *  - rechaza cadena vacia;
 *  - rechaza solo-espacios (incluye saltos de linea/tabs);
 *  - acepta exactamente `MAX_MESSAGE_LENGTH` puntos de codigo;
 *  - rechaza `MAX_MESSAGE_LENGTH + 1`.
 */
export function validateMessage(input: unknown): MessageValidationResult {
  if (typeof input !== "string") {
    return { ok: false, error: "not_a_string", length: 0 };
  }
  const length = codePointLength(input);
  if (input.length === 0) {
    return { ok: false, error: "empty", length };
  }
  if (input.trim().length === 0) {
    return { ok: false, error: "whitespace_only", length };
  }
  if (length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: "too_long", length };
  }
  return { ok: true, value: input, length };
}
