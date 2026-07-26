import { safeUrlReferenceSchema } from "../domain/analysis-result.js";
import type { SafeUrlReference } from "../domain/analysis-result.js";
import { redact } from "../domain/redaction.js";
import type { RedactedText } from "../domain/redaction.js";
import { assertBoundedInteger } from "../shared/numeric-limits.js";
import { makeReferenceId } from "./allowlist.js";
import { URL_LIMITS } from "./limits.js";
import type { SanitizedUrl } from "./types.js";

/**
 * Frontera de proceso: preparacion del evento que LambdaWebhook publica en SQS
 * (PR04-R01).
 *
 * Dos superficies distintas pueden filtrar una query sensible:
 *
 *  1. la lista de referencias URL del evento;
 *  2. el TEXTO redactado del mensaje, que sigue conteniendo la URL tal como la
 *     escribio el usuario (`redact()` no toca `?token=secreto`, porque el valor
 *     no es un digito ni encaja en ninguna regla de PII).
 *
 * Las dos se limpian aqui. Ambas funciones son PURAS: no mutan sus entradas, no
 * consultan red y no mantienen estado global.
 */

/** Detecta cualquier token con esquema explicito `esquema://...`. */
const SCHEME_TOKEN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+/g;

/** Puntuacion de cierre que suele quedar pegada a una URL en prosa. */
const TRAILING_PUNCT = /[.,;:!?)\]}>"'»]+$/;

/**
 * Marcador que sustituye por completo un token URL inseguro (PR04-F01/F02).
 * No lleva esquema ni autoridad, asi que ningun cliente lo convierte en enlace
 * y ninguna pasada posterior lo vuelve a tocar (`SCHEME_TOKEN` no lo encuentra):
 * la sustitucion es idempotente.
 */
export const URL_REDACTED_MARKER = "[URL_REDACTED]";

/**
 * Delimitadores sensibles en forma PORCENTUAL: `?`, `=`, `#`, `@`.
 *
 * Un token como `https://example.com/%3Ftoken%3Dsecret` no tiene query para
 * WHATWG `URL` (todo vive en el path), de modo que eliminar `search` y `hash` no
 * quita nada y el secreto cruzaria SQS intacto. Peor: la referencia resultante
 * pasaria el esquema serializable, porque el string no contiene `?` ni `#`.
 */
const ENCODED_DELIMITERS = /%(?:3f|3d|23|40)/i;

/** Rondas de decodificacion permitidas SOLO para inspeccion (nunca para navegar). */
const MAX_DECODE_ROUNDS = 2;

/**
 * true si el token esconde un delimitador sensible codificado, incluso bajo una
 * capa extra de codificacion (`%253F` -> `%3F` -> `?`).
 *
 * Se inspecciona el token ORIGINAL en cada nivel de decodificacion, hasta dos
 * rondas. El valor decodificado NO se usa para navegar ni para reconstruir una
 * URL: solo se mira. Si la decodificacion falla (escape malformado), se
 * responde de forma conservadora en cuanto haya un `%`: un escape roto en una
 * URL de mensaje no tiene uso legitimo y la sobrerredaccion es aceptable
 * (privacidad primero).
 *
 * Solo se buscan las formas CODIFICADAS. Los delimitadores literales (`?a=1`)
 * los resuelve la limpieza normal de query, que conserva la URL util.
 */
function hasEncodedDelimiter(token: string): boolean {
  let current = token;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (ENCODED_DELIMITERS.test(current)) return true;
    if (round === MAX_DECODE_ROUNDS) break;
    if (!current.includes("%")) break; // nada que decodificar
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return true; // escape malformado con `%`: se redacta el token entero
    }
    if (next === current) break; // punto fijo: no hay mas capas
    current = next;
  }
  return false;
}

/**
 * true si el token lleva credenciales embebidas (`user:pass@host`, `user@host`).
 *
 * Se mira SOLO el componente de autoridad (entre `://` y el primer `/`, `?` o
 * `#`), de modo que un `@` en el path (`/path@foo`) no cuente. Se comprueba
 * ademas con `URL` cuando el token es parseable, porque WHATWG normaliza formas
 * que la inspeccion textual no cubre.
 */
function hasEmbeddedCredentials(token: string): boolean {
  const schemeEnd = token.indexOf("://");
  if (schemeEnd !== -1) {
    const afterScheme = token.slice(schemeEnd + 3);
    const authorityEnd = afterScheme.search(/[/?#]/);
    const authority =
      authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
    if (authority.includes("@")) return true;
  }
  try {
    const parsed = new URL(token);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

/**
 * true si el token NO puede cruzar la frontera de ninguna forma parcial y debe
 * sustituirse entero por el marcador.
 *
 * Vaciar `username`/`password` no basta: produce una URL distinta de la
 * original y de aspecto confiable (`https://example.com/path` a partir de
 * `https://user:pass@evil.example.com/path` si el atacante juega con la
 * autoridad), y puede conservar informacion parcial. Se descarta el token.
 */
function mustRedactToken(token: string): boolean {
  return hasEmbeddedCredentials(token) || hasEncodedDelimiter(token);
}

export interface PrepareUrlsOptions {
  /** Maximo de referencias en el evento. Por defecto `URL_LIMITS.maxUrlsPerMessage`. */
  readonly maxReferences?: number;
}

/**
 * Proyecta las URLs extraidas al contrato SERIALIZABLE.
 *
 * - valida `maxReferences` ANTES de recorrer nada (PR04-F03);
 * - descarta por completo las URLs con credenciales embebidas o con
 *   delimitadores sensibles codificados: no producen `SafeUrlReference`
 *   (PR04-F01/F02);
 * - asigna `referenceId` deterministas dentro del mensaje (`url-1`, `url-2`...);
 * - usa UNICAMENTE `reputationUrl`; `navigationUrl` no se conserva ni se copia;
 * - deduplica por `reputationUrl`: dos URLs que solo difieren en la query
 *   colapsan en UNA referencia (consecuencia deliberada de eliminar la query);
 * - respeta el limite;
 * - valida cada referencia con el esquema compartido antes de devolverla;
 * - devuelve copias congeladas.
 */
export function prepareUrlsForQueue(
  urls: readonly SanitizedUrl[],
  options: PrepareUrlsOptions = {},
): readonly SafeUrlReference[] {
  const maxReferences = assertBoundedInteger(
    // Solo `undefined` significa "no especificado". Un `null` forzado en runtime
    // es un valor invalido, no una ausencia: se rechaza.
    options.maxReferences === undefined
      ? URL_LIMITS.maxUrlsPerMessage
      : options.maxReferences,
    0,
    URL_LIMITS.maxUrlsPerMessage,
    "prepareUrlsForQueue",
    "maxReferences",
  );

  const seen = new Set<string>();
  const references: SafeUrlReference[] = [];

  for (const url of urls) {
    // Un token inseguro no genera referencia: no hay version "limpiable" de una
    // URL con credenciales o con un delimitador escondido tras el encoding.
    if (mustRedactToken(url.reputationUrl) || mustRedactToken(url.navigationUrl)) {
      continue;
    }
    if (seen.has(url.reputationUrl)) continue;
    seen.add(url.reputationUrl);
    if (references.length >= maxReferences) break; // limite duro, sin excepcion
    // El esquema es la barrera: si la `reputationUrl` trajera query, fragmento o
    // un esquema no http(s), la construccion del evento falla aqui y no en SQS.
    const parsed = safeUrlReferenceSchema.parse({
      referenceId: makeReferenceId(references.length),
      reputationUrl: url.reputationUrl,
    });
    references.push(Object.freeze({ ...parsed }));
  }

  return Object.freeze(references);
}

/**
 * Sustituye en el texto la parte de query/fragmento de CADA token con esquema.
 * No solo de las URLs aceptadas: una URL rechazada por la extraccion
 * (`http://localhost/reset?token=secreto`, credenciales embebidas, esquema raro)
 * tambien llevaria el secreto a la cola.
 *
 * Estrategia por token, de mas defensiva a mas precisa:
 *  0. si lleva credenciales embebidas o un delimitador sensible codificado, se
 *     sustituye ENTERO por `[URL_REDACTED]` (PR04-F01/F02);
 *  1. si coincide con una URL extraida, se usa su `reputationUrl`;
 *  2. si es http/https parseable, se elimina `search` y `hash`;
 *  3. en cualquier otro caso se corta el texto en el primer `?` o `#`.
 */
function stripQueriesFromText(
  text: string,
  extracted: readonly SanitizedUrl[],
): string {
  const byNavigation = new Map<string, string>();
  for (const u of extracted) {
    byNavigation.set(u.navigationUrl, u.reputationUrl);
  }

  return text.replace(SCHEME_TOKEN, (token) => {
    const trailing = TRAILING_PUNCT.exec(token)?.[0] ?? "";
    const raw = trailing === "" ? token : token.slice(0, token.length - trailing.length);
    if (raw === "") return token;

    // Paso 0: nada de este token sobrevive. Se conserva la puntuacion de cierre
    // para no alterar la prosa que rodea a la URL.
    if (mustRedactToken(raw)) return `${URL_REDACTED_MARKER}${trailing}`;

    let replacement: string | null = null;

    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }

    if (parsed !== null) {
      const mapped = byNavigation.get(parsed.toString());
      if (mapped !== undefined) {
        replacement = mapped;
      } else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const clean = new URL(parsed.toString());
        clean.search = "";
        clean.hash = "";
        replacement = clean.toString();
      }
    }

    if (replacement === null) {
      // Corte textual: sirve para esquemas no http y para URLs no parseables.
      const cut = raw.search(/[?#]/);
      replacement = cut === -1 ? raw : raw.slice(0, cut);
    }

    return `${replacement}${trailing}`;
  });
}

/**
 * Produce el texto destinado a la cola: el mensaje ya redactado con toda query y
 * todo fragmento eliminados de sus URLs.
 *
 * El resultado sigue siendo `RedactedText` por una via CONTROLADA: se vuelve a
 * pasar por `redact()`, el unico productor legitimo de la marca. No hay ningun
 * cast. Ademas la segunda pasada es una defensa real: si la reescritura dejara
 * al descubierto un patron de PII, se redacta antes de salir.
 *
 * `redact()` es idempotente, asi que un texto ya limpio no cambia.
 */
export function sanitizeMessageUrlsForQueue(
  redactedMessage: RedactedText,
  extractedUrls: readonly SanitizedUrl[],
): RedactedText {
  // `String(...)` no muta nada: los strings son inmutables.
  const stripped = stripQueriesFromText(String(redactedMessage), extractedUrls);
  return redact(stripped).text;
}
