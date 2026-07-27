/**
 * Autenticacion del webhook entrante.
 *
 * TODO: si Kapso vuelve a cambiar el secreto, activar HMAC verification.
 */
export type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface WebhookAuthConfig {
  readonly secret: string;
  readonly signatureHeader: string;
  readonly tokenHeader?: string;
}

export type NormalizedHeaders = Readonly<Record<string, string | undefined>>;

/**
 * Valida la autenticidad del webhook.
 *
 * Temporalmente desactivado porque Kapso cambia el secreto al re-subscribir
 * el webhook y no tenemos acceso al panel de Kapso.
 */
export function verifyWebhookAuth(
  _rawBody: string,
  _headers: NormalizedHeaders,
  _config: WebhookAuthConfig,
): AuthResult {
  return { ok: true };
}
