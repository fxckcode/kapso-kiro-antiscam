import { createHash } from "node:crypto";
import type { FraudCategory } from "../domain/agent-evaluation.js";
import { toolEvidenceSchema } from "../domain/evidence.js";
import type { ToolEvidence } from "../domain/evidence.js";
import { LIMITS } from "../domain/limits.js";
import type { RedactedText } from "../domain/redaction.js";
import type { Signal } from "../domain/signal.js";
import { assertExecutionId } from "../shared/execution-id.js";
import { CASES_VERSION, KNOWN_CASES } from "./cases.js";
import type { KnownCase } from "./cases.js";

/**
 * Recuperacion de casos conocidos de fraude (PR-06 sec. 10).
 *
 * INVARIANTES:
 *  - Busqueda CERRADA: categoria opcional + senales del backend + palabras del
 *    texto redactado. El modelo NO puede pasar texto libre ni nuevas keywords.
 *  - Sin hash del texto del usuario, estado global, embeddings, filesystem ni red.
 *  - Maximo 3 casos por invocacion.
 *  - `evidenceId` DETERMINISTA: sha256(executionId, version, caseIds en orden
 *    de catalogo). Mismos inputs siempre producen el mismo id.
 *  - El modelo solo recibe `{ category, summary }` de cada caso; sin keywords
 *    internas ni detalles que faciliten abuso.
 */

const MAX_CASES = 3;
const KNOWN_CASES_PREFIX = "ev_kc_";
const KNOWN_CASES_DOMAIN = "known-cases";
const HEX_LENGTH = 32;

/**
 * Parametros de busqueda (provienen del BACKEND, no del modelo).
 * `category` filtra por categoria exacta; `signals` y `redactedText` amplian
 * la puntuacion de relevancia sin que el modelo pueda controlar la query.
 */
export interface KnownCasesQuery {
  readonly category?: FraudCategory;
  readonly signals: readonly Signal[];
  readonly redactedText: RedactedText;
}

/** Vista segura de un caso: solo lo que el modelo necesita. Sin keywords. */
export interface KnownCaseView {
  readonly category: FraudCategory;
  readonly summary: string;
}

export type RetrieveKnownCasesOutcome =
  | {
      readonly kind: "matches";
      readonly cases: readonly KnownCaseView[];
      readonly evidence: ToolEvidence;
    }
  | { readonly kind: "no_matches" };

/**
 * Deriva un `evidenceId` determinista para un resultado de casos conocidos.
 * Formula: sha256(executionId NUL version NUL caseId0 NUL ... NUL domain)
 * Los caseIds van en el ORDEN ESTABLE del catalogo para que el id sea reproducible.
 */
function deriveKnownCasesEvidenceId(
  executionId: string,
  version: string,
  caseIds: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(executionId, "utf8");
  hash.update("\0", "utf8");
  hash.update(version, "utf8");
  for (const id of caseIds) {
    hash.update("\0", "utf8");
    hash.update(id, "utf8");
  }
  hash.update("\0", "utf8");
  hash.update(KNOWN_CASES_DOMAIN, "utf8");
  const id = `${KNOWN_CASES_PREFIX}${hash.digest("hex").slice(0, HEX_LENGTH)}`;
  if (id.length > LIMITS.maxIdLength) {
    throw new Error("deriveKnownCasesEvidenceId: id excede maxIdLength.");
  }
  return id;
}

/**
 * Extrae tokens de 3+ caracteres del texto redactado (minusculas).
 * No hash, no embeddings, solo palabras individuales para correlacion con
 * el catalogo. La funcion es pura y determinista.
 */
function tokenizeRedacted(redactedText: RedactedText): ReadonlySet<string> {
  const lower = (redactedText as string).toLowerCase();
  const tokens = lower.split(/[^a-z0-9áéíóúüñ]+/).filter((w) => w.length >= 3);
  return new Set(tokens);
}

/**
 * Puntua un caso respecto a la consulta. Devuelve -1 si el filtro duro
 * de categoria no se cumple (descarta inmediatamente).
 */
function scoreCase(
  c: KnownCase,
  categoryFilter: FraudCategory | undefined,
  signalTypeSet: ReadonlySet<string>,
  tokens: ReadonlySet<string>,
  lowerText: string,
): number {
  if (categoryFilter !== undefined && c.category !== categoryFilter) return -1;

  let score = 0;

  // Senales del backend: peso alto (son evidencia computada, no texto libre).
  for (const st of c.signalTypes) {
    if (signalTypeSet.has(st)) score += 3;
  }

  // Keywords del catalogo en el texto redactado: peso moderado.
  // Se comprueba tanto por token exacto como por substring (keywords de varias
  // palabras como "servicio al cliente" no aparecen como token unico).
  for (const kw of c.keywords) {
    if (tokens.has(kw) || lowerText.includes(kw)) {
      score += 1;
    }
  }

  return score;
}

/**
 * Recupera hasta tres casos ordenados por relevancia.
 *
 * El timestamp proviene de `now`, no de `Date.now()` directamente, para que
 * los tests sean deterministas sin `vi.useFakeTimers`. La funcion es pura
 * salvo por `assertExecutionId` (que puede lanzar) y `createHash` (determinista).
 */
export function retrieveKnownCases(
  query: KnownCasesQuery,
  executionId: string,
  now: () => string,
): RetrieveKnownCasesOutcome {
  const cleanExecutionId = assertExecutionId(executionId, "retrieveKnownCases");

  const signalTypeSet: ReadonlySet<string> = new Set(query.signals.map((s) => s.type));
  const lowerText = (query.redactedText as string).toLowerCase();
  const tokens = tokenizeRedacted(query.redactedText);

  // Puntuar y filtrar: se ordenan por score descendente; empates mantienen el
  // orden estable del catalogo (sort de JS no es estable en Node < 11, pero en
  // Node 24 si lo es; documentado).
  const scored = KNOWN_CASES.map((c) => ({
    caseId: c.caseId,
    score: scoreCase(c, query.category, signalTypeSet, tokens, lowerText),
    case: c,
  }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CASES);

  if (scored.length === 0) {
    return { kind: "no_matches" };
  }

  // Ordenar los caseIds por posicion en el catalogo para que el evidenceId sea
  // reproducible independientemente del orden de los resultados.
  const catalogOrder = new Map(KNOWN_CASES.map((c, i) => [c.caseId, i]));
  const sortedCaseIds = scored
    .map((e) => e.caseId)
    .sort((a, b) => (catalogOrder.get(a) ?? 0) - (catalogOrder.get(b) ?? 0));

  const evidenceId = deriveKnownCasesEvidenceId(cleanExecutionId, CASES_VERSION, sortedCaseIds);

  const summary = `${scored.length} caso(s) conocido(s) de fraude encontrado(s) en el catalogo v${CASES_VERSION}.`;

  const evidence: ToolEvidence = toolEvidenceSchema.parse({
    evidenceId,
    executionId: cleanExecutionId,
    toolName: "retrieveKnownCases",
    source: "known_cases",
    summary,
    observedAt: now(),
  });

  const cases: readonly KnownCaseView[] = scored.map((e) => ({
    category: e.case.category,
    summary: e.case.summary,
  }));

  return { kind: "matches", cases, evidence };
}
