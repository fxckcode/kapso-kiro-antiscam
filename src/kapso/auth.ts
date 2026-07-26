/**
 * Autenticacion del webhook entrante.
 *
 * PENDIENTE (PRD §13): el mecanismo exacto de Kapso debe confirmarse. Se
 * soportan dos esquemas comunes de la WhatsApp Cloud API / proveedores:
 *   1. Firma HMAC-SHA256 del cuerpo crudo en un header (ej. `x-hub-signature-256`
 *      con formato `sha256=<hex>`).
 *   2. Token compartido en un header (ej. `x-kapso-token`).
 *
 * Se valida SIEMPRE contra el cuerpo crudo (string exacto recibido), antes de
 * parsear. La comparacion es en tiempo constante para evitar timing attacks.
 * Nunca se loguea el secreto ni la firma.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface WebhookAuthConfig {
  /** Secreto compartido para firma HMAC y/o token. */
  readonly secret: string;
  /** Nombre del header de firma HMAC. */
  readonly signatureHeader: string;
  /** Nombre del header de token compartido (opcional). */
  readonly tokenHeader?: string;
}

/** Headers normalizados a minusculas. */
export type NormalizedHeaders = Readonly<Record<string, string | undefined>>;

/**
 * Valida la autenticidad del webhook.
 *
 * @param rawBody Cuerpo crudo exacto (sin re-serializar), necesario para HMAC.
 * @param headers Headers de la request (se normalizan a minusculas).
 * @param config  Secreto y nombres de header.
 */
export function verifyWebhookAuth(
  rawBody: string,
  headers: NormalizedHeaders,
  config: WebhookAuthConfig,
): AuthResult {
  if (config.secret.length === 0) {
    return { ok: false, reason: 'missing_secret' };
  }

  const lower = lowercaseKeys(headers);

  // Esquema 1: firma HMAC del cuerpo crudo.
  const signature = lower[config.signatureHeader.toLowerCase()];
  if (typeof signature === 'string' && signature.length > 0) {
    return verifyHmacSignature(rawBody, signature, config.secret);
  }

  // Esquema 2: token compartido.
  if (config.tokenHeader) {
    const token = lower[config.tokenHeader.toLowerCase()];
    if (typeof token === 'string' && token.length > 0) {
      return safeEqual(token, config.secret)
        ? { ok: true }
        : { ok: false, reason: 'token_mismatch' };
    }
  }

  return { ok: false, reason: 'missing_signature' };
}

function verifyHmacSignature(rawBody: string, provided: string, secret: string): AuthResult {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Acepta con o sin prefijo "sha256=".
  const providedHex = provided.startsWith('sha256=') ? provided.slice('sha256='.length) : provided;
  return safeEqual(providedHex, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

/** Comparacion en tiempo constante de dos strings (evita timing attacks). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function lowercaseKeys(headers: NormalizedHeaders): NormalizedHeaders {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(headers)) {
    out[key.toLowerCase()] = headers[key];
  }
  return out;
}
