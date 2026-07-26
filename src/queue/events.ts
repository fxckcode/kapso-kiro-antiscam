/**
 * Contrato minimo y canonico del evento que cruza SQS.
 *
 * No contiene telefono, texto crudo, query strings ni representaciones de URL
 * aptas para navegacion. El processor solo recibe texto ya redactado y URLs de
 * reputacion. Mantener este archivo pequeno evita que el adaptador Kapso
 * duplique contratos del dominio de AntiScamBot.
 */

export const ANALYSIS_EVENT_SCHEMA_VERSION = 1 as const;
export const ANALYSIS_EVENT_TYPE = 'analysis_requested' as const;

export interface SafeUrlReference {
  readonly referenceId: string;
  readonly reputationUrl: string;
}

export interface AnalysisRequestedEvent {
  readonly eventType: typeof ANALYSIS_EVENT_TYPE;
  readonly schemaVersion: typeof ANALYSIS_EVENT_SCHEMA_VERSION;
  readonly executionId: string;
  readonly messageId: string;
  readonly userId: string;
  /** Identificador opaco de conversacion; nunca telefono en claro. */
  readonly routingToken: string;
  readonly redactedText: string;
  readonly urlReferences: readonly SafeUrlReference[];
  readonly receivedAt: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_URLS = 10;

/**
 * Validacion de frontera para publisher y processor. Es deliberadamente estricta:
 * rechaza campos extras y URLs que puedan llevar secretos a logs, DLQ o cache.
 */
export function validateAnalysisEvent(value: unknown): readonly string[] {
  if (!isRecord(value)) return ['event is not an object'];

  const allowed = new Set([
    'eventType',
    'schemaVersion',
    'executionId',
    'messageId',
    'userId',
    'routingToken',
    'redactedText',
    'urlReferences',
    'receivedAt',
  ]);
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (value['eventType'] !== ANALYSIS_EVENT_TYPE) errors.push('eventType must be "analysis_requested"');
  if (value['schemaVersion'] !== ANALYSIS_EVENT_SCHEMA_VERSION) errors.push('schemaVersion must be 1');
  for (const key of ['executionId', 'messageId', 'userId', 'routingToken'] as const) {
    if (!isId(value[key])) errors.push(`${key} must be a bounded opaque id`);
  }
  if (typeof value['routingToken'] === 'string' && /^\+?\d{7,15}$/.test(value['routingToken'])) {
    errors.push('routingToken must not be a phone number');
  }
  if (typeof value['redactedText'] !== 'string' || Array.from(value['redactedText']).length > MAX_TEXT_LENGTH) {
    errors.push('redactedText must be a bounded string');
  }
  if (!isUtcTimestamp(value['receivedAt'])) errors.push('receivedAt must be an ISO-8601 UTC string');

  const refs = value['urlReferences'];
  if (!Array.isArray(refs) || refs.length > MAX_URLS) {
    errors.push('urlReferences must be an array within the limit');
  } else {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const ref of refs) {
      if (!isRecord(ref) || Object.keys(ref).length !== 2 || !isId(ref['referenceId'])) {
        errors.push('urlReference must contain a valid referenceId only');
        continue;
      }
      const url = ref['reputationUrl'];
      if (!isReputationUrl(url)) {
        errors.push('urlReference must contain a canonical reputationUrl without credentials, query or fragment');
        continue;
      }
      if (ids.has(ref['referenceId'] as string) || urls.has(url)) {
        errors.push('urlReferences must not contain duplicate ids or URLs');
      }
      ids.add(ref['referenceId'] as string);
      urls.add(url);
    }
  }

  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isReputationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.hostname.length > 0 &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}
