import { toolEvidenceSchema } from "../domain/evidence.js";
import type { ToolEvidence } from "../domain/evidence.js";
import type { InvocationState } from "@strands-agents/sdk";
import type { RedactedText } from "../domain/redaction.js";
import type { Signal } from "../domain/signal.js";
import { assertExecutionId } from "../shared/execution-id.js";
import { rehydrateUrlAllowlist } from "../url/allowlist.js";
import type { UrlAllowlist } from "../url/allowlist.js";
import type { ValidatedAgentInput } from "./analysis-agent-input.js";
import { ToolContractError } from "./errors.js";

/**
 * Contexto de UNA ejecucion del agente (PR-06 sec. 6).
 *
 * Motivacion: en una Lambda caliente dos analisis pueden solaparse en el mismo
 * proceso. Cualquier estado de modulo mutable (un `Map` global de evidencia, un
 * agente singleton con conversacion, una allowlist compartida) haria que el
 * analisis A pudiera citar evidencia de B, o resolver una URL que nunca estuvo
 * en su propio mensaje. Por eso NO existe estado de modulo aqui: cada analisis
 * construye su propio contexto y su propio `Agent`.
 *
 * Lo unico que puede compartirse entre ejecuciones son objetos NEUTRALES y sin
 * identidad de ejecucion: la configuracion del modelo, el cliente de reputacion
 * y la cache de reputacion (cuya clave es la URL, nunca un `referenceId`).
 *
 * El contexto viaja a las herramientas por `invocationState`, no por closure ni
 * por variable de modulo, para que sea imposible que una herramienta creada en
 * una ejecucion vea el contexto de otra.
 */
export interface AnalysisExecutionContext {
  /** Identidad de la ejecucion. La fija el backend; el modelo nunca la controla. */
  readonly executionId: string;
  /** Allowlist propia: resuelve `referenceId` -> URL solo dentro de esta ejecucion. */
  readonly allowlist: UrlAllowlist;
  /** Registro de procedencia: `evidenceId` -> `ToolEvidence` de ESTA ejecucion. */
  readonly evidenceRegistry: Map<string, ToolEvidence>;
  /**
   * Texto redactado del mensaje analizado. Las herramientas lo usan como
   * contexto de busqueda (retrieve-known-cases). El modelo no lo controla:
   * viene de la entrada validada, no de los argumentos de la herramienta.
   */
  readonly redactedText: RedactedText;
  /**
   * Senales deterministas del backend. Las herramientas las usan como filtro
   * de busqueda. El modelo no las produce ni las altera.
   */
  readonly signals: readonly Signal[];
}

/**
 * Clave reservada de `invocationState`. El prefijo evita colisiones con las
 * claves que documentan otros puentes de transporte de Strands.
 */
export const EXECUTION_CONTEXT_KEY = "antiscam.analysisExecutionContext";

/**
 * Crea el contexto de una ejecucion a partir de la entrada YA validada.
 *
 * La allowlist se rehidrata desde las `SafeUrlReference`: es el mismo camino que
 * usa LambdaProcessor tras SQS, de modo que aqui no puede aparecer una URL con
 * query aunque el llamador estuviera en el mismo proceso que la extrajo.
 */
export function createAnalysisExecutionContext(
  input: ValidatedAgentInput,
): AnalysisExecutionContext {
  const executionId = assertExecutionId(
    input.executionId,
    "createAnalysisExecutionContext",
  );
  return {
    executionId,
    allowlist: rehydrateUrlAllowlist(executionId, input.urlReferences),
    // Registro NUEVO por ejecucion. Nunca se reutiliza ni se comparte.
    evidenceRegistry: new Map<string, ToolEvidence>(),
    // Copias del input validado para que las herramientas puedan leerlas sin
    // necesitar acceso a la entrada original.
    redactedText: input.redactedText,
    signals: input.signals,
  };
}

/**
 * Registra una evidencia producida por una herramienta.
 *
 * Politica (PR-06 sec. 9):
 *  - se valida la forma con el esquema de PR-01 antes de guardar nada;
 *  - la evidencia debe pertenecer a ESTA ejecucion; una evidencia con otro
 *    `executionId` es un fallo de contrato, no un dato a ignorar;
 *  - idempotente: registrar dos veces la MISMA evidencia (el caso normal de un
 *    acierto de cache, que deriva el mismo `evidenceId`) no duplica ni falla;
 *  - falla CERRADO ante conflicto: el mismo `evidenceId` con contenido distinto
 *    significa que la derivacion determinista se rompio o que algo intenta
 *    sustituir evidencia ya citada. No se sobrescribe.
 *
 * Devuelve la evidencia efectivamente registrada (la primera, ante duplicado).
 */
export function registerEvidence(
  context: AnalysisExecutionContext,
  candidate: ToolEvidence,
): ToolEvidence {
  const parsed = toolEvidenceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ToolContractError("registerEvidence: evidencia con forma invalida.");
  }
  const evidence = parsed.data;

  if (evidence.executionId !== context.executionId) {
    throw new ToolContractError(
      "registerEvidence: la evidencia pertenece a otra ejecucion.",
    );
  }

  const existing = context.evidenceRegistry.get(evidence.evidenceId);
  if (existing !== undefined) {
    if (!sameEvidence(existing, evidence)) {
      throw new ToolContractError(
        `registerEvidence: conflicto de evidencia para ${evidence.evidenceId}.`,
      );
    }
    return existing; // idempotente
  }

  context.evidenceRegistry.set(evidence.evidenceId, evidence);
  return evidence;
}

/** Igualdad campo a campo. `ToolEvidence` solo contiene primitivos. */
function sameEvidence(a: ToolEvidence, b: ToolEvidence): boolean {
  return (
    a.evidenceId === b.evidenceId &&
    a.executionId === b.executionId &&
    a.toolName === b.toolName &&
    a.referenceId === b.referenceId &&
    a.source === b.source &&
    a.summary === b.summary &&
    a.observedAt === b.observedAt
  );
}

/**
 * Snapshot DEFENSIVO del registro al terminar la ejecucion.
 *
 * Se toma antes de construir el resultado y se pasa a `buildAnalysisResult`, de
 * modo que la verificacion de procedencia opere sobre una foto inmutable: si
 * algo (una herramienta lenta, un hook) escribiera en el registro despues, no
 * podria alterar la evidencia que ya se resolvio. Cada elemento es una copia
 * revalidada, no una referencia al registro vivo.
 */
export function snapshotEvidence(
  context: AnalysisExecutionContext,
): readonly ToolEvidence[] {
  return Object.freeze(
    [...context.evidenceRegistry.values()].map((evidence) =>
      Object.freeze(toolEvidenceSchema.parse({ ...evidence })),
    ),
  );
}

/** Empaqueta el contexto en el `invocationState` que consumen las herramientas. */
export function toInvocationState(context: AnalysisExecutionContext): InvocationState {
  return { [EXECUTION_CONTEXT_KEY]: context };
}

/** Guard estructural: valida la forma en runtime sin `as any`. */
function isAnalysisExecutionContext(value: unknown): value is AnalysisExecutionContext {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c["executionId"] === "string" &&
    c["executionId"] !== "" &&
    typeof c["allowlist"] === "object" &&
    c["allowlist"] !== null &&
    typeof (c["allowlist"] as Record<string, unknown>)["resolve"] === "function" &&
    c["evidenceRegistry"] instanceof Map &&
    typeof c["redactedText"] === "string" &&
    Array.isArray(c["signals"])
  );
}

/**
 * Recupera el contexto desde `invocationState`.
 *
 * `InvocationState` es `Record<string, unknown>`: el tipo no garantiza nada en
 * runtime, asi que se valida con un guard en lugar de castear. Si el contexto
 * falta o esta deformado, la herramienta NO puede saber a que ejecucion
 * pertenece y por tanto no puede registrar evidencia con procedencia: se falla
 * cerrado con un error de contrato, que el clasificador degrada a respuesta
 * prudente.
 */
export function requireExecutionContext(
  state: InvocationState | undefined,
  toolName: string,
): AnalysisExecutionContext {
  if (state === undefined) {
    throw new ToolContractError(`${toolName}: falta el contexto de ejecucion.`);
  }
  const candidate = state[EXECUTION_CONTEXT_KEY];
  if (!isAnalysisExecutionContext(candidate)) {
    throw new ToolContractError(`${toolName}: contexto de ejecucion invalido.`);
  }
  return candidate;
}
