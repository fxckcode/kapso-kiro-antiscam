import { safeUrlReferenceSchema } from "../domain/analysis-result.js";
import type { SafeUrlReference } from "../domain/analysis-result.js";
import { assertExecutionId } from "../shared/execution-id.js";
import { assertBoundedInteger } from "../shared/numeric-limits.js";
import { normalizeHost } from "./host.js";
import { URL_LIMITS } from "./limits.js";
import type { RuntimeUrlReference, SanitizedUrl } from "./types.js";

/**
 * Allowlist de URLs asociada a UNA ejecucion. El agente solo puede citar un
 * `referenceId`; NUNCA proporciona una URL. La resolucion exige coincidencia de
 * `executionId`, de modo que un id de otra ejecucion (o inexistente) se rechaza.
 *
 * Sin estado global mutable: cada allowlist es un objeto independiente. Todo lo
 * devuelto son COPIAS congeladas, de modo que un `as` deliberado tampoco pueda
 * mutar el estado interno (PR04-09).
 *
 * Dos constructores, con fronteras distintas (PR04-R01):
 *  - `createUrlAllowlist`: dentro de LambdaWebhook, a partir de las URLs
 *    extraidas; conserva `navigationUrl` en memoria para resolver redirects;
 *  - `rehydrateUrlAllowlist`: en LambdaProcessor, a partir de las
 *    `SafeUrlReference[]` que llegaron por SQS; NO restaura la query eliminada.
 *
 * Ver prompt maestro sec. 6 y UBIQUITOUS_LANGUAGE.md sec. 2 ("ReferenceId").
 */

export interface UrlAllowlistEntry {
  readonly executionId: string;
  readonly referenceId: string;
  /** Ver `SanitizedUrl.navigationUrl`: no se loguea ni se persiste. */
  readonly navigationUrl: string;
  /** Ver `SanitizedUrl.reputationUrl`: sin query; clave de cache/proveedor. */
  readonly reputationUrl: string;
}

export interface UrlAllowlist {
  readonly executionId: string;
  /** Copia congelada de las entradas (no expone el arreglo interno). */
  readonly entries: readonly UrlAllowlistEntry[];
  /**
   * Resuelve un `referenceId` SOLO dentro de esta ejecucion. Devuelve null si el
   * id no existe o el `executionId` no coincide.
   */
  resolve(referenceId: string, executionId: string): RuntimeUrlReference | null;
}

export interface UrlAllowlistOptions {
  /** Maximo de entradas admitidas. Por defecto `URL_LIMITS.maxUrlsPerMessage`. */
  readonly maxEntries?: number;
}

/**
 * `referenceId` opaco y estable dentro de la ejecucion. NO contiene la URL: es
 * un indice secuencial (`url-1`, `url-2`, ...).
 */
export function makeReferenceId(index: number): string {
  return `url-${index + 1}`;
}

/** Borrador de entrada, ya con su id asignado o conservado. */
interface EntryDraft {
  readonly referenceId: string;
  readonly navigationUrl: string;
  readonly reputationUrl: string;
}

/**
 * Ensambla la allowlist inmutable. No se exporta: es la unica via por la que se
 * construye el objeto, y ambos constructores publicos validan antes de llamarla.
 */
function assembleAllowlist(
  executionId: string,
  drafts: readonly EntryDraft[],
): UrlAllowlist {
  const entries: readonly UrlAllowlistEntry[] = Object.freeze(
    drafts.map((d) =>
      Object.freeze({
        executionId,
        referenceId: d.referenceId,
        navigationUrl: d.navigationUrl,
        reputationUrl: d.reputationUrl,
      }),
    ),
  );

  const byId = new Map<string, UrlAllowlistEntry>();
  for (const entry of entries) {
    byId.set(entry.referenceId, entry);
  }

  return Object.freeze({
    executionId,
    entries,
    resolve(referenceId: string, requestExecutionId: string): RuntimeUrlReference | null {
      if (requestExecutionId !== executionId) return null;
      const entry = byId.get(referenceId);
      if (!entry) return null;
      if (entry.executionId !== requestExecutionId) return null;
      // Copia defensiva congelada: no expone la entrada interna.
      return Object.freeze({
        referenceId: entry.referenceId,
        navigationUrl: entry.navigationUrl,
        reputationUrl: entry.reputationUrl,
      });
    },
  });
}

/**
 * Crea la allowlist de una ejecucion a partir de las URLs extraidas.
 *
 * - Valida `executionId` ANTES de cualquier otro trabajo (PR04-R04).
 * - Deduplica por `navigationUrl` normalizada: la misma URL produce UNA sola
 *   referencia.
 * - Rechaza mas de `maxEntries` entradas (limite exacto permitido, limite+1 no).
 * - No retiene referencia al arreglo de entrada (copia defensiva).
 */
export function createUrlAllowlist(
  executionId: string,
  urls: readonly SanitizedUrl[],
  options: UrlAllowlistOptions = {},
): UrlAllowlist {
  const execution = assertExecutionId(executionId, "createUrlAllowlist");
  const maxEntries = assertBoundedInteger(
    options.maxEntries === undefined ? URL_LIMITS.maxUrlsPerMessage : options.maxEntries,
    0,
    URL_LIMITS.maxUrlsPerMessage,
    "createUrlAllowlist",
    "maxEntries",
  );

  // Deduplicacion ANTES de aplicar el limite: duplicados no consumen cupo.
  const drafts: EntryDraft[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (seen.has(u.navigationUrl)) continue;
    seen.add(u.navigationUrl);
    drafts.push({
      referenceId: makeReferenceId(drafts.length),
      navigationUrl: u.navigationUrl,
      reputationUrl: u.reputationUrl,
    });
  }

  if (drafts.length > maxEntries) {
    throw new RangeError(
      `createUrlAllowlist: demasiadas URLs (${drafts.length} > ${maxEntries}).`,
    );
  }

  return assembleAllowlist(execution, drafts);
}

/**
 * Rechaza un destino que jamas debe existir en un evento legitimo, SIN consultar
 * DNS (PR04-F: endurecimiento de la frontera manipulada).
 *
 * Un evento SQS manipulado puede traer una `reputationUrl` perfectamente
 * canonica y aun asi apuntar al interior de la infraestructura
 * (`http://169.254.169.254/`). Aqui solo se aplican las comprobaciones que no
 * necesitan red: `localhost`, subdominios `.localhost` e IP literales no
 * publicas. Un hostname normal se sigue validando por DNS en el momento de
 * usarse, que es cuando la resolucion es significativa.
 */
function assertRoutableReputationUrl(reputationUrl: string, context: string): void {
  // `safeUrlReferenceSchema` ya garantizo que esto parsea y es http/https.
  const host = normalizeHost(new URL(reputationUrl).hostname);
  if (!host.ok) {
    throw new RangeError(`${context}: hostname no admitido (${host.reason}).`);
  }
  const literal = host.host.literalIp;
  if (literal !== null && !literal.safe) {
    throw new RangeError(
      `${context}: IP literal no enrutable publicamente (${literal.category}).`,
    );
  }
}

/**
 * Reconstruye la allowlist en OTRO PROCESO (LambdaProcessor) desde las
 * referencias que viajaron por SQS. No depende de la memoria de LambdaWebhook.
 *
 * Orden de proceso (PR04-F04): primero se valida el esquema de TODAS las
 * referencias y se registra `referenceId -> reputationUrl`; solo despues se
 * deduplica por URL. Deduplicar antes ocultaba conflictos: con
 * `url-1 -> A`, `url-2 -> A`, `url-2 -> B`, la segunda entrada se descartaba por
 * URL repetida y `url-2` nunca quedaba registrado, de modo que `url-2 -> B`
 * pasaba como si fuera nuevo y el mismo id acababa apuntando a dos destinos.
 *
 * - Valida `executionId`, `maxEntries` y cada `SafeUrlReference` con el esquema
 *   compartido: una `reputationUrl` con query, fragmento, esquema no http(s) o
 *   no canonica se RECHAZA.
 * - Rechaza destinos no enrutables aunque el esquema los acepte (evento
 *   manipulado), sin consultar DNS.
 * - Conserva los `referenceId` originales para que las citas del agente sigan
 *   resolviendo.
 * - Usa `reputationUrl` tambien como URL de navegacion: para el MVP se acepta
 *   perder redirects o recursos que dependan de query. La privacidad tiene
 *   prioridad (PR04-R01).
 * - Sin estado global: devuelve un objeto nuevo y congelado.
 */
export function rehydrateUrlAllowlist(
  executionId: string,
  references: readonly SafeUrlReference[],
  options: UrlAllowlistOptions = {},
): UrlAllowlist {
  const execution = assertExecutionId(executionId, "rehydrateUrlAllowlist");
  const maxEntries = assertBoundedInteger(
    // Solo `undefined` es ausencia; un `null` forzado en runtime se rechaza.
    options.maxEntries === undefined ? URL_LIMITS.maxUrlsPerMessage : options.maxEntries,
    0,
    URL_LIMITS.maxUrlsPerMessage,
    "rehydrateUrlAllowlist",
    "maxEntries",
  );

  // Fase 1: validar forma y destino, y resolver la identidad de CADA id. No se
  // descarta nada aqui, para que ningun conflicto de id quede sin observar.
  const byId = new Map<string, string>();
  const declared: SafeUrlReference[] = [];
  for (const raw of references) {
    const ref = safeUrlReferenceSchema.parse(raw);
    assertRoutableReputationUrl(ref.reputationUrl, "rehydrateUrlAllowlist");

    const existing = byId.get(ref.referenceId);
    if (existing !== undefined) {
      if (existing !== ref.reputationUrl) {
        throw new RangeError(
          `rehydrateUrlAllowlist: referenceId duplicado con URL distinta (${ref.referenceId}).`,
        );
      }
      continue; // duplicado exacto: idempotente
    }
    byId.set(ref.referenceId, ref.reputationUrl);
    declared.push(ref);
  }

  // Fase 2: deduplicar por URL. Dos ids distintos para la misma URL conservan el
  // PRIMER id; el segundo deja de resolver, que es la politica documentada.
  const drafts: EntryDraft[] = [];
  const seenUrls = new Set<string>();
  for (const ref of declared) {
    if (seenUrls.has(ref.reputationUrl)) continue;
    seenUrls.add(ref.reputationUrl);
    drafts.push({
      referenceId: ref.referenceId,
      // MVP: sin query, la URL de reputacion es tambien la de navegacion.
      navigationUrl: ref.reputationUrl,
      reputationUrl: ref.reputationUrl,
    });
  }

  if (drafts.length > maxEntries) {
    throw new RangeError(
      `rehydrateUrlAllowlist: demasiadas referencias (${drafts.length} > ${maxEntries}).`,
    );
  }

  return assembleAllowlist(execution, drafts);
}
