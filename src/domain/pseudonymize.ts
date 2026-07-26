import { createHmac } from "node:crypto";

/**
 * Seudonimizacion del numero de telefono. Se usa HMAC-SHA256 con un secreto
 * gestionado, NUNCA SHA-256 simple: un hash sin clave sobre un espacio pequeno
 * y conocido (numeros telefonicos) es trivialmente reversible por fuerza bruta.
 *
 * Ver PRD.md sec. 10, UBIQUITOUS_LANGUAGE.md sec. 2 ("Usuario seudonimizado")
 * y TASKS.md sec. 4.1.
 */

/** Normaliza el telefono a E.164-ish: solo digitos, con `+` opcional inicial. */
function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Deriva el identificador seudonimizado (hex) del telefono.
 * @throws {Error} si `secret` esta vacio: nunca debe caerse a un hash sin clave.
 */
export function pseudonymizeUser(phone: string, secret: string): string {
  if (!secret) {
    throw new Error("USER_HASH_SECRET requerido para seudonimizar; no se permite hash sin clave.");
  }
  const normalized = normalizePhone(phone);
  if (!normalized || normalized === "+") {
    throw new Error("Telefono invalido para seudonimizar.");
  }
  return createHmac("sha256", secret).update(normalized).digest("hex");
}
