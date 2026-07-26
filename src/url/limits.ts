import { URL_REFERENCE_LIMITS } from "../domain/analysis-result.js";

/**
 * Limites de la capa de URLs (extraccion, SSRF y fetch seguro). Se centralizan
 * aqui porque los .md fijan las reglas cualitativas (HTTP/HTTPS, 3 redirects,
 * timeout, tamano maximo) pero no numeros exactos. (Prompt maestro sec. 4/5/7.)
 *
 * `maxUrlLength` se toma del contrato compartido para que una URL aceptada en la
 * extraccion nunca sea rechazada despues por el esquema serializable (PR04-R01).
 * Los maximos de `maxRedirects`, `maxTimeoutMs` y `maxResponseBytes` son el
 * techo que un llamador NO puede elevar (PR04-R02).
 */
export const URL_LIMITS = {
  /** Numero maximo de URLs distintas que se procesan por mensaje. */
  maxUrlsPerMessage: 10,
  /** Longitud maxima de una URL individual (en caracteres). */
  maxUrlLength: URL_REFERENCE_LIMITS.maxReputationUrlLength,
  /** Maximo de redirects que sigue el fetch seguro. Techo absoluto. */
  maxRedirects: 3,
  /** Timeout por intento de red (ms). Valor por defecto. */
  timeoutMs: 3000,
  /** Timeout maximo admitido (ms). Techo absoluto. */
  maxTimeoutMs: 10000,
  /** Tamano maximo del cuerpo aceptado (bytes). Techo absoluto. */
  maxResponseBytes: 65536,
  /** Tamano maximo de una respuesta JSON de reputacion (bytes). */
  maxReputationResponseBytes: 262144,
} as const;
