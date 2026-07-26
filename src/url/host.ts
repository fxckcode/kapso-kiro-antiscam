import { classifyIp, stripBrackets } from "./net.js";
import type { IpClassification } from "./net.js";

/**
 * Normalizacion UNICA de hostname (PR04-02). Todo el resto del sistema (SSRF,
 * fetch seguro, allowlist) debe pasar por aqui para que no existan dos nociones
 * distintas de "host". Reglas:
 *
 *  1. minusculas;
 *  2. eliminar punto final (FQDN raiz: `ejemplo.com.` -> `ejemplo.com`);
 *  3. eliminar `[`/`]` solo cuando encierran un IPv6;
 *  4. rechazar hostname vacio;
 *  5. clasificar IP literal ANTES de cualquier DNS;
 *  6. bloquear `localhost` y cualquier subdominio de `.localhost`.
 *
 * Las formas IPv4 alternativas (`127.1`, `2130706433`, `0x7f000001`,
 * `0177.0.0.1`) las canonicaliza WHATWG `URL` a dotted-quad antes de llegar
 * aqui; si aun asi llegara una forma no canonica, `classifyIp` devuelve null y
 * el host se trata como NO resoluble a publico (fail-closed).
 */

export type HostNormalizationError = "empty_host" | "blocked_hostname";

export interface NormalizedHost {
  /** Hostname normalizado (minusculas, sin punto final, sin corchetes). */
  readonly hostname: string;
  /**
   * Clasificacion si el hostname es una IP literal; null si es un nombre DNS
   * que aun debe resolverse.
   */
  readonly literalIp: IpClassification | null;
}

export type HostNormalizationResult =
  | { readonly ok: true; readonly host: NormalizedHost }
  | { readonly ok: false; readonly reason: HostNormalizationError; readonly hostname: string };

/**
 * Hostnames siempre bloqueados sin importar el DNS. Se comprueba sobre el
 * hostname YA normalizado (minusculas y sin punto final), de modo que
 * `LOCALHOST.` y `foo.localhost.` tambien quedan bloqueados.
 */
function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** Aplica pasos 1-3 sin juzgar: minusculas, sin punto final, sin corchetes. */
export function canonicalizeHostname(raw: string): string {
  let h = stripBrackets(raw.trim()).toLowerCase();
  // Eliminar UN punto final (raiz DNS). Varios puntos finales son invalidos y
  // se dejan tal cual para que la validacion posterior los rechace.
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Normaliza y valida un hostname. No consulta DNS: solo decide si es una IP
 * literal (ya clasificada) o un nombre que habra que resolver.
 */
export function normalizeHost(raw: string): HostNormalizationResult {
  const hostname = canonicalizeHostname(raw);
  if (hostname === "") {
    return { ok: false, reason: "empty_host", hostname };
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: "blocked_hostname", hostname };
  }
  // Paso 5: IP literal se clasifica ANTES de DNS.
  const literalIp = classifyIp(hostname);
  return { ok: true, host: { hostname, literalIp } };
}

/**
 * Normaliza el hostname de una URL ya parseada. `URL.hostname` no incluye el
 * puerto, e IPv6 llega entre corchetes: ambos casos los cubre `normalizeHost`.
 */
export function normalizeUrlHost(url: URL): HostNormalizationResult {
  return normalizeHost(url.hostname);
}
