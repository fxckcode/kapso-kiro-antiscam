import { isBoundedInteger } from "../shared/numeric-limits.js";
import { URL_LIMITS } from "./limits.js";
import { resolveAndPin } from "./ssrf.js";
import type { DnsResolver, PinnedTarget } from "./ssrf.js";

/**
 * Fetch seguro con transporte y resolver inyectados. NUNCA usa Internet por si
 * mismo. Defensas (prompt maestro sec. 5/7 + PR04-03/04/07):
 *
 *  - solo http/https;
 *  - UNA resolucion DNS por hop, con la direccion FIJADA (`connectIp`) que se
 *    entrega al transporte: la validacion y la conexion no pueden divergir;
 *  - `redirect: "manual"` obligatorio: el transporte nunca sigue redirects;
 *  - maximo `maxRedirects` (3) sin off-by-one; ciclos detectados;
 *  - SSRF se valida ANTES de comprobar downgrade https->http;
 *  - timeout y limite de bytes propagados al transporte y REVALIDADOS aqui;
 *  - no ejecuta JavaScript ni renderiza HTML (solo bytes/estado).
 */

/**
 * Peticion con direccion fijada. El transporte DEBE conectarse a `connectIp` y
 * usar `hostname` para el header `Host` y `serverName` para SNI/TLS. Un
 * adaptador real usara un `lookup`/dispatcher controlado que devuelva
 * exactamente `connectIp`; volver a resolver libremente viola este contrato.
 */
export interface PinnedTransportRequest {
  readonly url: URL;
  /** IP publica ya validada. Unico destino de conexion permitido. */
  readonly connectIp: string;
  /** Hostname original, para el header `Host`. */
  readonly hostname: string;
  /** Hostname original, para SNI/TLS. */
  readonly serverName: string;
  /** El transporte nunca sigue redirects por su cuenta. */
  readonly redirect: "manual";
  readonly timeoutMs: number;
  /** El transporte DEBE abortar/cancelar la lectura al superar este limite. */
  readonly maxBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Bytes efectivamente leidos del socket antes de cortar. */
  readonly bytesRead: number;
  /** true si el transporte corto la lectura por exceder `maxBytes`. */
  readonly truncated: boolean;
}

/**
 * Transporte inyectable. Contrato obligatorio para el adaptador real:
 *  - conectarse SOLO a `req.connectIp` (no resolver el hostname de nuevo);
 *  - enviar `Host: req.hostname` y usar `req.serverName` como SNI;
 *  - no seguir redirects (`redirect: "manual"`);
 *  - aplicar `timeoutMs`;
 *  - ABORTAR la lectura en cuanto se superen `maxBytes` y reportar
 *    `truncated: true` con `bytesRead <= maxBytes`.
 */
export type Transport = (req: PinnedTransportRequest) => Promise<TransportResponse>;

/**
 * Ajustes OPCIONALES del llamador. Cada campo, si se provee, debe ser un entero
 * dentro de la politica aprobada; no hay forma de desactivar un limite (ver
 * `validateOptions`).
 */
export interface SafeFetchOptions {
  /** Entero en `[0, URL_LIMITS.maxRedirects]`. */
  readonly maxRedirects?: number;
  /** Entero en `[1, URL_LIMITS.maxTimeoutMs]`. */
  readonly timeoutMs?: number;
  /** Entero en `[1, URL_LIMITS.maxResponseBytes]`. */
  readonly maxBytes?: number;
}

export type SafeFetchError =
  | "invalid_options"
  | "invalid_scheme"
  | "ssrf_blocked"
  | "too_many_redirects"
  | "redirect_loop"
  | "insecure_redirect_downgrade"
  | "missing_redirect_location"
  | "invalid_redirect_location"
  | "timeout"
  | "transport_error"
  | "response_too_large"
  | "inconsistent_response"
  | "response_truncated";

export type SafeFetchResult =
  | {
      readonly ok: true;
      readonly finalUrl: string;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly bytesRead: number;
      readonly redirects: number;
      /** Direcciones fijadas usadas en cada hop, en orden. */
      readonly pinnedIps: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: SafeFetchError;
      readonly atUrl: string;
      readonly redirects: number;
    };

/** Marca de timeout que el transporte puede lanzar. */
export class TransportTimeoutError extends Error {}

/** Marca de cancelacion/abort por exceso de bytes. */
export class TransportAbortedError extends Error {}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Busca un header sin distinguir mayusculas/minusculas. */
function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Valida defensivamente los limites de tamano reportados por el transporte.
 * `safeFetch` no confia en que el transporte haya cumplido su contrato.
 */
function checkSizeLimits(
  res: TransportResponse,
  maxBytes: number,
): SafeFetchError | null {
  if (!Number.isInteger(res.bytesRead) || res.bytesRead < 0) return "inconsistent_response";
  if (res.bytesRead > maxBytes) return "response_too_large";
  if (res.body.byteLength > maxBytes) return "response_too_large";
  // El cuerpo entregado no puede ser mayor que lo leido del socket.
  if (res.body.byteLength > res.bytesRead) return "inconsistent_response";
  // Si no se trunco, el cuerpo debe coincidir con lo leido.
  if (!res.truncated && res.body.byteLength !== res.bytesRead) {
    return "inconsistent_response";
  }
  return null;
}

/** Clave de ciclo: hop identificado por su URL normalizada. */
function loopKey(url: URL): string {
  return url.toString();
}

/**
 * Politica de limites en runtime (PR04-R02).
 *
 * Un campo ausente toma el valor por defecto. Un campo PRESENTE debe ser un
 * entero dentro del rango aprobado: se rechazan `NaN`, `Infinity`, `-Infinity`,
 * negativos, decimales, valores por encima del techo y cualquier cosa que no sea
 * `number`. NUNCA se normaliza en silencio un valor inseguro (un `maxBytes` de
 * 10 GB no se recorta al techo: se rechaza la llamada), porque un recorte
 * silencioso oculta un bug del llamador y da la falsa impresion de haberse
 * respetado. `maxRedirects: 0` si es valido (significa "sin redirects").
 */
function inRange(value: number, min: number, max: number): boolean {
  return isBoundedInteger(value, min, max);
}

function validateOptions(options: SafeFetchOptions): boolean {
  if (options.maxRedirects !== undefined) {
    if (typeof options.maxRedirects !== "number") return false;
    if (!inRange(options.maxRedirects, 0, URL_LIMITS.maxRedirects)) return false;
  }
  if (options.timeoutMs !== undefined) {
    if (typeof options.timeoutMs !== "number") return false;
    if (!inRange(options.timeoutMs, 1, URL_LIMITS.maxTimeoutMs)) return false;
  }
  if (options.maxBytes !== undefined) {
    if (typeof options.maxBytes !== "number") return false;
    if (!inRange(options.maxBytes, 1, URL_LIMITS.maxResponseBytes)) return false;
  }
  return true;
}

export async function safeFetch(
  initialUrl: string | URL,
  deps: { readonly resolve: DnsResolver; readonly transport: Transport },
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  // ANTES de parsear la URL, resolver DNS, consultar caches o llamar al
  // transporte: si las opciones son invalidas no se produce ningun efecto
  // externo observable.
  if (!validateOptions(options)) {
    return {
      ok: false,
      error: "invalid_options",
      atUrl: String(initialUrl),
      redirects: 0,
    };
  }

  const maxRedirects = options.maxRedirects ?? URL_LIMITS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? URL_LIMITS.timeoutMs;
  const maxBytes = options.maxBytes ?? URL_LIMITS.maxResponseBytes;

  let current: URL;
  try {
    current = initialUrl instanceof URL ? new URL(initialUrl.toString()) : new URL(initialUrl);
  } catch {
    return { ok: false, error: "invalid_scheme", atUrl: String(initialUrl), redirects: 0 };
  }

  let redirects = 0;
  let previousScheme: string | null = null;
  const visited = new Set<string>([loopKey(current)]);
  const pinnedIps: string[] = [];

  for (;;) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return { ok: false, error: "invalid_scheme", atUrl: current.toString(), redirects };
    }

    // 1) SSRF PRIMERO: una resolucion por hop, todas las IPs validadas, IP fijada.
    const pinned = await resolveAndPin(current, deps.resolve);
    if (!pinned.ok) {
      return { ok: false, error: "ssrf_blocked", atUrl: current.toString(), redirects };
    }
    const target: PinnedTarget = pinned.target;

    // 2) Downgrade DESPUES de la validacion SSRF (orden exigido).
    if (previousScheme === "https:" && current.protocol === "http:") {
      return {
        ok: false,
        error: "insecure_redirect_downgrade",
        atUrl: current.toString(),
        redirects,
      };
    }

    pinnedIps.push(target.connectIp);

    let response: TransportResponse;
    try {
      response = await deps.transport({
        url: new URL(current.toString()), // copia defensiva
        connectIp: target.connectIp,
        hostname: target.hostname,
        serverName: target.hostname,
        redirect: "manual",
        timeoutMs,
        maxBytes,
      });
    } catch (err) {
      if (err instanceof TransportTimeoutError) {
        return { ok: false, error: "timeout", atUrl: current.toString(), redirects };
      }
      if (err instanceof TransportAbortedError) {
        return {
          ok: false,
          error: "response_too_large",
          atUrl: current.toString(),
          redirects,
        };
      }
      return { ok: false, error: "transport_error", atUrl: current.toString(), redirects };
    }

    // 3) Revalidacion defensiva de limites de tamano.
    const sizeError = checkSizeLimits(response, maxBytes);
    if (sizeError) {
      return { ok: false, error: sizeError, atUrl: current.toString(), redirects };
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      // Un cuerpo truncado es un estado controlado, no un exito silencioso.
      if (response.truncated) {
        return {
          ok: false,
          error: "response_truncated",
          atUrl: current.toString(),
          redirects,
        };
      }
      return {
        ok: true,
        finalUrl: current.toString(),
        status: response.status,
        headers: { ...response.headers },
        body: response.body.slice(),
        bytesRead: response.bytesRead,
        redirects,
        pinnedIps: [...pinnedIps],
      };
    }

    // --- Manejo MANUAL del redirect ---
    if (redirects >= maxRedirects) {
      return {
        ok: false,
        error: "too_many_redirects",
        atUrl: current.toString(),
        redirects,
      };
    }

    const location = header(response.headers, "location");
    if (location === undefined || location.trim() === "") {
      return {
        ok: false,
        error: "missing_redirect_location",
        atUrl: current.toString(),
        redirects,
      };
    }

    let next: URL;
    try {
      // Soporta Location relativa resolviendola contra el hop actual.
      next = new URL(location, current);
    } catch {
      return {
        ok: false,
        error: "invalid_redirect_location",
        atUrl: current.toString(),
        redirects,
      };
    }
    // Fragmento irrelevante para la peticion.
    next.hash = "";

    // Ciclo de redirects (A->B->A).
    const key = loopKey(next);
    if (visited.has(key)) {
      return { ok: false, error: "redirect_loop", atUrl: next.toString(), redirects };
    }
    visited.add(key);

    previousScheme = current.protocol;
    redirects += 1;
    current = next;
  }
}
