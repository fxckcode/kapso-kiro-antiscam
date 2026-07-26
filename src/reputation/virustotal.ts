import type {
  UrlReputationProvider,
  UrlReputationResult,
  UrlReputationStatus,
} from "./provider.js";

/**
 * Adaptador de VirusTotal para el puerto `UrlReputationProvider`.
 *
 * Seguridad (prompt maestro sec. 7 + PR04-07/08):
 *  - recibe SOLO la `reputationUrl` resuelta desde la allowlist (sin query);
 *  - usa timeout y limite de bytes, ambos propagados al transporte;
 *  - un cuerpo sobredimensionado se rechaza ANTES de parsear el JSON, midiendo
 *    BYTES UTF-8 y no unidades UTF-16 (PR04-R03);
 *  - JSON invalido produce un error controlado, sin incluir el body crudo;
 *  - los conteos se validan estrictamente (enteros finitos >= 0), sin
 *    normalizar silenciosamente un negativo a cero;
 *  - mapea 401/403/429/5xx a estados diferenciados;
 *  - NUNCA registra la API key ni la URL completa;
 *  - una sola deteccion no se convierte en `scam` (eso lo decide el backend).
 *
 * El transporte HTTP se inyecta: este modulo no usa `fetch` global, por lo que
 * los tests corren sin red.
 */

export interface VirusTotalTransportRequest {
  /** URL de reputacion (sin query). El transporte no debe registrarla. */
  readonly url: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** El transporte DEBE abortar la lectura al superar este limite. */
  readonly maxBytes: number;
}

export interface VirusTotalTransportResponse {
  readonly status: number;
  /** Cuerpo crudo como texto. Se valida su tamano antes de parsearlo. */
  readonly body: string;
  /** Bytes leidos del socket. */
  readonly bytesRead: number;
  /** true si el transporte corto la lectura por exceder `maxBytes`. */
  readonly truncated: boolean;
}

/** Lanzada por el transporte cuando se agota el timeout. */
export class VirusTotalTimeoutError extends Error {}

/** Lanzada por el transporte cuando aborta por exceso de bytes. */
export class VirusTotalAbortedError extends Error {}

export type VirusTotalTransport = (
  req: VirusTotalTransportRequest,
) => Promise<VirusTotalTransportResponse>;

export interface VirusTotalConfig {
  readonly apiKey: string;
  readonly transport: VirusTotalTransport;
  readonly timeoutMs: number;
  /** Limite de bytes de la respuesta JSON. */
  readonly maxBytes: number;
}

const SOURCE = "virustotal";

export interface ReputationStats {
  readonly malicious: number;
  readonly suspicious: number;
  readonly harmless: number;
}

function result(
  status: UrlReputationStatus,
  summary: string,
  stats?: ReputationStats,
): UrlReputationResult {
  return { status, source: SOURCE, summary, ...(stats ? { stats } : {}) };
}

/**
 * Valida un conteo: debe ser number finito, ENTERO y >= 0 (PR04-08).
 * Un negativo, decimal, NaN, Infinity o string se RECHAZA; nunca se normaliza
 * silenciosamente a cero.
 */
function validCount(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null; // NaN, Infinity, -Infinity
  if (!Number.isInteger(v)) return null; // decimal
  if (v < 0) return null; // negativo
  return v;
}

type StatsOutcome =
  | { readonly kind: "ok"; readonly stats: ReputationStats }
  | { readonly kind: "absent" } // no hay bloque de estadisticas -> sin datos
  | { readonly kind: "invalid" }; // presente pero con valores no validos

/**
 * Lee `data.attributes.last_analysis_stats` de forma defensiva y estricta.
 * `malicious`, `suspicious` y `harmless` son OBLIGATORIOS cuando el bloque
 * existe: si falta o es invalido alguno, el payload se considera invalido.
 * Campos inesperados adicionales se ignoran (no invalidan la respuesta).
 */
function readStats(json: unknown): StatsOutcome {
  if (typeof json !== "object" || json === null) return { kind: "absent" };
  const data = (json as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return { kind: "absent" };
  const attributes = (data as { attributes?: unknown }).attributes;
  if (typeof attributes !== "object" || attributes === null) return { kind: "absent" };
  const raw = (attributes as { last_analysis_stats?: unknown }).last_analysis_stats;
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "object") return { kind: "invalid" };

  const s = raw as Record<string, unknown>;
  const malicious = validCount(s["malicious"]);
  const suspicious = validCount(s["suspicious"]);
  const harmless = validCount(s["harmless"]);
  if (malicious === null || suspicious === null || harmless === null) {
    return { kind: "invalid" };
  }
  return { kind: "ok", stats: { malicious, suspicious, harmless } };
}

export function createVirusTotalProvider(
  config: VirusTotalConfig,
): UrlReputationProvider {
  return {
    async check(url: string): Promise<UrlReputationResult> {
      let response: VirusTotalTransportResponse;
      try {
        response = await config.transport({
          url,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
          maxBytes: config.maxBytes,
        });
      } catch (err) {
        if (err instanceof VirusTotalTimeoutError) {
          return result("temporary_error", "Consulta de reputacion agoto el tiempo de espera.");
        }
        if (err instanceof VirusTotalAbortedError) {
          return result("temporary_error", "Respuesta de reputacion excedio el tamano permitido.");
        }
        // El error original NUNCA se propaga: podria contener URL o API key.
        return result("temporary_error", "Error transitorio al consultar la reputacion.");
      }

      const { status } = response;

      // Estados sin cuerpo relevante: se resuelven antes de tocar el JSON.
      if (status === 404) {
        return result("no_data", "La fuente no tiene datos de reputacion para el enlace.");
      }
      if (status === 401 || status === 403) {
        return result("permanent_error", "Acceso no autorizado a la fuente de reputacion.");
      }
      if (status === 429) {
        return result("quota_exceeded", "Cuota de la fuente de reputacion agotada.");
      }
      if (status >= 500) {
        return result("temporary_error", "La fuente de reputacion no esta disponible.");
      }
      if (status !== 200) {
        return result("permanent_error", "Respuesta inesperada de la fuente de reputacion.");
      }

      // --- status 200: validar tamano ANTES de parsear ---
      //
      // `body` es texto, no bytes. `body.length` cuenta UNIDADES UTF-16, no
      // bytes: "€".length === 1 pero ocupa 3 bytes en UTF-8, y un emoji cuenta 2
      // unidades y ocupa 4 bytes. Usar `length` como cantidad de bytes permitiria
      // que una respuesta de hasta ~3x el limite pasara la comprobacion y llegara
      // a `JSON.parse`. Se mide con `Buffer.byteLength(..., "utf8")`, la misma
      // unidad en que estan expresados `maxBytes` y `bytesRead`. (PR04-R03.)
      if (response.truncated) {
        return result("temporary_error", "Respuesta de reputacion truncada por tamano.");
      }
      if (!Number.isInteger(response.bytesRead) || response.bytesRead < 0) {
        return result("temporary_error", "Respuesta de reputacion inconsistente.");
      }
      if (response.bytesRead > config.maxBytes) {
        return result("temporary_error", "Respuesta de reputacion excedio el tamano permitido.");
      }
      const utf8Bytes = Buffer.byteLength(response.body, "utf8");
      if (utf8Bytes > config.maxBytes) {
        return result("temporary_error", "Respuesta de reputacion excedio el tamano permitido.");
      }
      // Coherencia: el texto decodificado no puede pesar mas que lo leido del
      // socket si la lectura no se trunco.
      if (utf8Bytes > response.bytesRead) {
        return result("temporary_error", "Respuesta de reputacion inconsistente.");
      }

      let json: unknown;
      try {
        json = JSON.parse(response.body);
      } catch {
        // Nunca se incluye el body crudo en el mensaje de error.
        return result("permanent_error", "Respuesta de reputacion con formato invalido.");
      }

      const stats = readStats(json);
      if (stats.kind === "invalid") {
        return result("permanent_error", "Conteos de reputacion invalidos en la respuesta.");
      }
      if (stats.kind === "absent") {
        return result("no_data", "La fuente no tiene datos de reputacion para el enlace.");
      }

      const { malicious, suspicious } = stats.stats;
      const summary =
        malicious > 0 || suspicious > 0
          ? `Reputacion negativa: ${malicious} motores marcan malicioso y ${suspicious} sospechoso.`
          : "Sin detecciones negativas de reputacion.";
      return result("available", summary, stats.stats);
    },
  };
}
