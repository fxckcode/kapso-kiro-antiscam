/**
 * Puerto de sanitizacion de URLs.
 *
 * La implementacion real vive (o vivira) en src/url, que NO se edita desde este
 * frente. La LambdaWebhook extrae URLs candidatas del mensaje redactado y las
 * pasa por este puerto; solo las URLs que superan la validacion (HTTP/HTTPS,
 * sin loopback / rangos privados / metadata de AWS) cruzan a SQS.
 *
 * Si el modulo real no existe todavia, se usa el fallback local de
 * src/messaging/url-fallback.ts.
 */
export interface SanitizedUrl {
  /** URL normalizada y validada. */
  readonly sanitizedUrl: string;
  /** Dominio (host) extraido. */
  readonly domain: string;
}

export interface UrlSanitizer {
  /**
   * Valida y normaliza una URL candidata.
   * Devuelve null si la URL debe descartarse (invalida o insegura).
   */
  sanitize(candidate: string): SanitizedUrl | null;
}
