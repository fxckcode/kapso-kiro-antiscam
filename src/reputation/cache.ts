import type { UrlReputationResult } from "./provider.js";

/**
 * Cache de reputacion con TTL y reloj inyectado (PR04-05).
 *
 * Invariantes de privacidad:
 *  - almacena SOLO resultados NEUTRALES de reputacion, nunca `ToolEvidence`;
 *  - NUNCA almacena `executionId`, `evidenceId` ni la API key;
 *  - la clave es la URL de REPUTACION (sin query), nunca un `referenceId`
 *    (que es especifico de una ejecucion) ni la URL de navegacion;
 *  - copias defensivas al entrar y al salir;
 *  - la clave nunca se registra en logs.
 *
 * Un resultado expirado equivale a un miss. Los estados de error/cuota NO se
 * cachean aqui; una eventual politica de backoff es materia de otro PR.
 */

/** Reloj inyectable: milisegundos desde epoch. Sin timers reales en tests. */
export interface Clock {
  now(): number;
}

export interface ReputationCacheTtlConfig {
  /** TTL para `available` (resultado con datos). */
  readonly availableTtlMs: number;
  /** TTL para `no_data`, deliberadamente MENOR: la fuente puede poblarse luego. */
  readonly noDataTtlMs: number;
}

export const DEFAULT_REPUTATION_TTL: ReputationCacheTtlConfig = {
  availableTtlMs: 6 * 60 * 60 * 1000, // 6 h
  noDataTtlMs: 30 * 60 * 1000, // 30 min
};

/** Entrada interna: resultado neutral + momento de expiracion. */
interface CacheEntry {
  readonly value: UrlReputationResult;
  readonly expiresAt: number;
}

export interface ReputationCache {
  /** Devuelve undefined si no existe o si ya expiro. */
  get(reputationUrl: string): UrlReputationResult | undefined;
  /**
   * Guarda el resultado si su estado es cacheable. Devuelve true si se guardo.
   * Los estados no cacheables se ignoran silenciosamente (sin efecto).
   */
  set(reputationUrl: string, value: UrlReputationResult): boolean;
}

/** Estados con resultado estable y por tanto cacheables. */
const CACHEABLE_STATUSES: ReadonlySet<UrlReputationResult["status"]> = new Set([
  "available",
  "no_data",
]);

/** Copia profunda del resultado neutral (evita aliasing mutable). */
function clone(v: UrlReputationResult): UrlReputationResult {
  return {
    status: v.status,
    source: v.source,
    summary: v.summary,
    ...(v.stats ? { stats: { ...v.stats } } : {}),
  };
}

function ttlFor(
  status: UrlReputationResult["status"],
  ttl: ReputationCacheTtlConfig,
): number | null {
  if (status === "available") return ttl.availableTtlMs;
  if (status === "no_data") return ttl.noDataTtlMs;
  return null; // no cacheable
}

/**
 * Cache en memoria con TTL. Suficiente para el MVP y los tests; en produccion la
 * respalda DynamoDB (SITEMAP.md sec. 6, "Cache URL"). Sin estado global: cada
 * llamada crea su propio almacen.
 */
export function createInMemoryReputationCache(
  clock: Clock,
  ttl: ReputationCacheTtlConfig = DEFAULT_REPUTATION_TTL,
): ReputationCache {
  const store = new Map<string, CacheEntry>();

  return {
    get(reputationUrl) {
      const entry = store.get(reputationUrl);
      if (!entry) return undefined;
      // Expirado equivale a miss (y se limpia).
      if (clock.now() >= entry.expiresAt) {
        store.delete(reputationUrl);
        return undefined;
      }
      return clone(entry.value);
    },
    set(reputationUrl, value) {
      if (!CACHEABLE_STATUSES.has(value.status)) return false;
      const lifetime = ttlFor(value.status, ttl);
      if (lifetime === null) return false;
      store.set(reputationUrl, {
        value: clone(value),
        expiresAt: clock.now() + lifetime,
      });
      return true;
    },
  };
}

/** Reloj determinista para pruebas: avanza solo cuando se le indica. */
export function createFixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}
