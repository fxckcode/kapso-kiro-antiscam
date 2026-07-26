/**
 * Seudonimizacion del usuario.
 *
 * Regla (PRD §10): nunca se guarda ni loguea el telefono en claro. El `userId`
 * es HMAC-SHA256(telefono, secreto), con el secreto gestionado por Secrets
 * Manager/SSM. Este es el UNICO modulo que toca el telefono para derivar el id.
 */
import { createHmac } from 'node:crypto';

/**
 * Deriva el usuario seudonimizado a partir del telefono en E.164.
 *
 * @param rawPhone Telefono del remitente (dato sensible).
 * @param secret   Secreto HMAC gestionado (no versionar en codigo).
 * @returns Hash hex de 64 chars, estable para el mismo telefono+secreto.
 */
export function pseudonymizePhone(rawPhone: string, secret: string): string {
  if (secret.length === 0) {
    throw new Error('HMAC secret is required to pseudonymize the phone number');
  }
  const normalized = normalizePhone(rawPhone);
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

/** Normaliza el telefono para que el hash sea estable (solo digitos, con +). */
function normalizePhone(rawPhone: string): string {
  const digits = rawPhone.replace(/[^\d]/g, '');
  return `+${digits}`;
}
