import { URL_LIMITS } from "./limits.js";
import { normalizeUrlHost } from "./host.js";
import type { SanitizedUrl, UrlRejectionReason } from "./types.js";

/**
 * Extraccion y normalizacion de URLs desde contenido redactado. Codigo
 * determinista y SIN red: NO sigue redirects ni resuelve DNS (eso ocurre en la
 * validacion SSRF y el fetch seguro). Ver prompt maestro sec. 4 y PR04-06.
 *
 * Reglas:
 *  - solo se aceptan `http:` y `https:`;
 *  - el hostname se normaliza con `normalizeHost` (minusculas, sin punto final,
 *    sin corchetes) y se bloquea `localhost`/`*.localhost`;
 *  - se elimina el fragmento;
 *  - se rechazan credenciales embebidas;
 *  - se controlan URLs malformadas;
 *  - se deduplican por `reputationUrl` + query de navegacion equivalente;
 *  - se limita el numero de URLs por mensaje y la longitud por URL;
 *  - se derivan DOS representaciones: `navigationUrl` (con query) y
 *    `reputationUrl` (sin query ni fragmento).
 */

export interface UrlExtractionRejection {
  readonly raw: string;
  readonly reason: UrlRejectionReason;
}

export interface UrlExtractionResult {
  readonly urls: readonly SanitizedUrl[];
  readonly rejected: readonly UrlExtractionRejection[];
  /** true si se descartaron URLs validas por exceder `maxUrlsPerMessage`. */
  readonly truncated: boolean;
}

export interface UrlExtractionOptions {
  readonly maxUrls?: number;
  readonly maxUrlLength?: number;
}

/** Detecta cualquier token con esquema explicito `esquema://...`. */
const SCHEME_TOKEN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+/g;

/** Puntuacion de cierre que suele quedar pegada a una URL en prosa. */
const TRAILING_PUNCT = /[.,;:!?)\]}>"'»]+$/;

type ParseOutcome =
  | { readonly ok: true; readonly value: SanitizedUrl }
  | { readonly ok: false; readonly reason: UrlRejectionReason };

/**
 * Deriva la URL de reputacion: misma origin+path, SIN query ni fragmento.
 * No se hace ninguna decodificacion adicional (se evita doble decodificacion):
 * se usa el serializado de WHATWG `URL` tal cual.
 */
function toReputationUrl(url: URL): string {
  const rep = new URL(url.toString());
  rep.hash = "";
  rep.search = ""; // elimina TODA la query, no una denylist parcial
  return rep.toString();
}

function parseCandidate(raw: string, maxUrlLength: number): ParseOutcome {
  if (raw.length > maxUrlLength) {
    return { ok: false, reason: "too_long" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid_scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "embedded_credentials" };
  }

  // Normalizacion unica del hostname (incluye bloqueo de localhost).
  const host = normalizeUrlHost(url);
  if (!host.ok) {
    return {
      ok: false,
      reason: host.reason === "empty_host" ? "malformed" : "blocked_hostname",
    };
  }

  // Reescribe el hostname normalizado (p. ej. quita el punto final) conservando
  // puerto, path y query.
  if (url.hostname !== host.host.hostname) {
    try {
      url.hostname = host.host.hostname;
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }

  url.hash = "";
  return {
    ok: true,
    value: {
      navigationUrl: url.toString(),
      reputationUrl: toReputationUrl(url),
      host: host.host.hostname,
    },
  };
}

export function extractUrls(
  text: string,
  options: UrlExtractionOptions = {},
): UrlExtractionResult {
  const maxUrls = options.maxUrls ?? URL_LIMITS.maxUrlsPerMessage;
  const maxUrlLength = options.maxUrlLength ?? URL_LIMITS.maxUrlLength;

  const accepted: SanitizedUrl[] = [];
  const rejected: UrlExtractionRejection[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const matches = text.match(SCHEME_TOKEN) ?? [];
  for (const token of matches) {
    const raw = token.replace(TRAILING_PUNCT, "");
    if (raw === "") continue;

    const outcome = parseCandidate(raw, maxUrlLength);
    if (!outcome.ok) {
      rejected.push({ raw, reason: outcome.reason });
      continue;
    }

    // Deduplicacion por URL de navegacion normalizada (URLs equivalentes
    // colapsan; dos URLs que solo difieren en query siguen siendo distintas
    // para navegacion aunque compartan `reputationUrl`).
    if (seen.has(outcome.value.navigationUrl)) continue;
    seen.add(outcome.value.navigationUrl);

    if (accepted.length >= maxUrls) {
      truncated = true;
      continue; // se descartan URLs validas adicionales (documentado)
    }
    accepted.push(outcome.value);
  }

  return { urls: accepted, rejected, truncated };
}
