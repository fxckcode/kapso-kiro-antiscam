import { classifyIp } from "./net.js";
import { normalizeHost } from "./host.js";
import type { IpClassification } from "./net.js";

/**
 * Validacion SSRF con resolver inyectado y PINNING de direccion (PR04-03).
 *
 * El punto critico: la validacion y la conexion NO pueden resolver por separado
 * (TOCTOU / DNS rebinding). Por eso `resolveAndPin` resuelve UNA sola vez por
 * hop, valida TODAS las direcciones devueltas y elige determinísticamente una IP
 * publica que se entrega al transporte como `connectIp`. El transporte no vuelve
 * a resolver.
 *
 * Un host se considera seguro solo si:
 *  - su esquema es http/https;
 *  - el hostname normaliza correctamente y no esta en la lista negra;
 *  - resuelve al menos a una IP, y
 *  - TODAS las IPs resueltas son publicas (mezcla publica/no publica => rechazo).
 *
 * Ver prompt maestro sec. 5.
 */

/** Resolver DNS inyectable: hostname -> lista de IPs (v4/v6 literales). */
export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export type SsrfRejectionReason =
  | "invalid_scheme"
  | "empty_host"
  | "blocked_hostname" // localhost / *.localhost
  | "dns_error"
  | "no_addresses"
  | "blocked_address" // todas las direcciones bloqueadas
  | "mixed_addresses"; // al menos una bloqueada junto a publicas

/**
 * Resultado de una validacion con pinning. `connectIp` es la direccion validada
 * a la que el transporte DEBE conectarse; `hostname` se preserva para el header
 * `Host` y para SNI/TLS.
 */
export interface PinnedTarget {
  readonly hostname: string;
  readonly connectIp: string;
  /** Todas las direcciones validadas en esta resolucion (orden del resolver). */
  readonly addresses: readonly string[];
  readonly classification: IpClassification;
}

export type SsrfCheckResult =
  | { readonly ok: true; readonly target: PinnedTarget }
  | {
      readonly ok: false;
      readonly host: string;
      readonly reason: SsrfRejectionReason;
      readonly blocked?: readonly string[];
    };

interface ClassifiedAddress {
  readonly ip: string;
  readonly classification: IpClassification | null;
}

/**
 * Resuelve (una sola vez) y fija una direccion validada para `url`.
 *
 * Si el hostname ya es una IP literal NO se consulta DNS: la propia IP es el
 * `connectIp` fijado.
 */
export async function resolveAndPin(
  url: URL,
  resolve: DnsResolver,
): Promise<SsrfCheckResult> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, host: url.hostname, reason: "invalid_scheme" };
  }

  const normalized = normalizeHost(url.hostname);
  if (!normalized.ok) {
    return { ok: false, host: normalized.hostname, reason: normalized.reason };
  }
  const { hostname, literalIp } = normalized.host;

  // Caso IP literal: sin DNS. La IP validada es el connectIp.
  if (literalIp) {
    return evaluate(hostname, [{ ip: hostname, classification: literalIp }]);
  }

  // UNA sola resolucion por hop.
  let resolved: readonly string[];
  try {
    resolved = await resolve(hostname);
  } catch {
    return { ok: false, host: hostname, reason: "dns_error" };
  }
  if (resolved.length === 0) {
    return { ok: false, host: hostname, reason: "no_addresses" };
  }

  const classified = resolved.map((ip) => ({ ip, classification: classifyIp(ip) }));
  return evaluate(hostname, classified);
}

/**
 * Valida el conjunto completo de direcciones y elige la IP fijada.
 * Seleccion DETERMINISTA: la primera direccion publica en el orden devuelto por
 * el resolver (estable para un mismo conjunto de respuestas).
 */
function evaluate(
  hostname: string,
  addrs: readonly ClassifiedAddress[],
): SsrfCheckResult {
  const blocked: string[] = [];
  const publicAddrs: ClassifiedAddress[] = [];

  for (const addr of addrs) {
    // Una entrada que no parsea como IP se trata como bloqueada (fail-closed).
    if (!addr.classification || !addr.classification.safe) {
      blocked.push(addr.ip);
    } else {
      publicAddrs.push(addr);
    }
  }

  if (blocked.length > 0) {
    // Mezcla publica/no publica, o todas bloqueadas: rechazar en ambos casos.
    const reason: SsrfRejectionReason =
      publicAddrs.length > 0 ? "mixed_addresses" : "blocked_address";
    return { ok: false, host: hostname, reason, blocked };
  }

  const chosen = publicAddrs[0];
  if (!chosen || !chosen.classification) {
    return { ok: false, host: hostname, reason: "no_addresses" };
  }

  return {
    ok: true,
    target: {
      hostname,
      connectIp: chosen.ip,
      addresses: addrs.map((a) => a.ip),
      classification: chosen.classification,
    },
  };
}

/**
 * Compatibilidad de lectura: valida un host expresado como string. Se conserva
 * para comprobaciones puntuales; el camino de red usa `resolveAndPin` con `URL`.
 */
export async function assertHostSafe(
  rawUrl: string,
  resolve: DnsResolver,
): Promise<SsrfCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, host: "", reason: "invalid_scheme" };
  }
  return resolveAndPin(url, resolve);
}
