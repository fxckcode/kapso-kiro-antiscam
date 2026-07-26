/**
 * Puerto de reputacion de URLs. Es la abstraccion que consume el servicio
 * `checkUrlReputation`; el adaptador de VirusTotal la implementa. Mantener el
 * puerto libre de detalles del proveedor permite probar el servicio sin red.
 *
 * Ver prompt maestro sec. 7 y SITEMAP.md sec. 5.
 */

/**
 * Estados diferenciados de una consulta de reputacion. El servicio decide si
 * producen evidencia (`available`/`no_data`) o modo degradado (el resto).
 */
export type UrlReputationStatus =
  | "available" // hay veredicto de reputacion
  | "no_data" // la fuente no tiene datos de esta URL
  | "quota_exceeded" // cuota agotada (429)
  | "temporary_error" // error transitorio (5xx, timeout, red)
  | "permanent_error"; // error permanente (401/403, contrato roto)

export interface UrlReputationResult {
  readonly status: UrlReputationStatus;
  /** Fuente de la reputacion, ej. "virustotal". */
  readonly source: string;
  /** Resumen legible y SEGURO (sin URL completa ni secretos). */
  readonly summary: string;
  /** Conteos cuando `status === "available"`. */
  readonly stats?: {
    readonly malicious: number;
    readonly suspicious: number;
    readonly harmless: number;
  };
}

export interface UrlReputationProvider {
  check(url: string): Promise<UrlReputationResult>;
}
