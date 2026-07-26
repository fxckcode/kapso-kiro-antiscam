/**
 * Contratos de la capa de URLs. Ver prompt maestro sec. 4/6 y
 * UBIQUITOUS_LANGUAGE.md sec. 2 ("Referencia URL sanitizada", "ReferenceId").
 *
 * PR04-06: se separan DOS representaciones de la misma URL porque tienen
 * requisitos de privacidad distintos. Esta especializacion vive dentro de PR-04;
 * NO modifica ningun contrato compartido de PR-01.
 */

/**
 * URL ya extraida, validada sintacticamente y normalizada, ANTES de asignar un
 * `referenceId`. No implica todavia validacion SSRF.
 */
export interface SanitizedUrl {
  /**
   * URL de NAVEGACION: conserva la query necesaria para resolver redirects.
   * Solo existe en memoria y en la allowlist de la ejecucion. NUNCA se registra
   * en logs ni aparece en evidencia, y no se usa como clave de cache.
   */
  readonly navigationUrl: string;
  /**
   * URL de REPUTACION: derivada de la normalizada, SIN fragmento y SIN query.
   * Es la unica que se envia al proveedor y la unica que se usa como clave de
   * cache. Para el MVP se prefiere privacidad frente a precision por URL exacta:
   * dominio + path son suficientes.
   */
  readonly reputationUrl: string;
  /** Host normalizado (minusculas, sin punto final, sin corchetes). */
  readonly host: string;
}

/**
 * Referencia RUNTIME a una URL sanitizada, viva solo dentro de una ejecucion y
 * de un proceso. NO es serializable: incluye `navigationUrl`, que conserva la
 * query y por tanto nunca puede cruzar SQS ni aparecer en logs.
 *
 * El contrato SERIALIZABLE es `SafeUrlReference` de `src/domain/analysis-result.ts`
 * y solo lleva `{ referenceId, reputationUrl }`. Los dos tipos tienen nombres
 * distintos a proposito: un cast entre ambos seria un error de seguridad.
 * (Hallazgo PR04-R01.)
 */
export interface RuntimeUrlReference {
  readonly referenceId: string;
  /** Ver `SanitizedUrl.navigationUrl`: nunca se loguea ni se persiste. */
  readonly navigationUrl: string;
  /** Ver `SanitizedUrl.reputationUrl`: sin query, apta para cache/proveedor. */
  readonly reputationUrl: string;
}

/** Motivos por los que una URL candidata se descarta en la extraccion. */
export type UrlRejectionReason =
  | "invalid_scheme"
  | "malformed"
  | "embedded_credentials"
  | "too_long"
  | "blocked_hostname";
