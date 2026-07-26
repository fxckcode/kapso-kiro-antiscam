/**
 * Contrato del evento que la LambdaWebhook publica en SQS y que la
 * LambdaProcessor consume. Es la FUENTE DE VERDAD compartida entre ambos lados.
 *
 * Invariantes (PRD §6, §10 y UBIQUITOUS_LANGUAGE):
 * - Solo viaja contenido REDACTADO. Nunca texto crudo ni datos sensibles.
 * - El telefono nunca aparece: se usa `userId` seudonimizado (HMAC-SHA256).
 * - Las URLs viajan ya sanitizadas como referencias de allowlist.
 * - No incluye `verdict` ni `signals`: los deriva/calcula el backend.
 */

export const ANALYSIS_EVENT_SCHEMA_VERSION = '1.0' as const;

export type MessageContentType = 'text' | 'image';

/** Referencia de URL sanitizada extraida del mensaje redactado. */
export interface UrlReference {
  /** Identificador estable dentro del mensaje (ej. "url-0"). */
  readonly referenceId: string;
  /** URL ya validada/normalizada (HTTP/HTTPS, sin SSRF). */
  readonly sanitizedUrl: string;
  /** Dominio extraido, util para reglas y logging seguro. */
  readonly domain: string;
}

/** Referencia a media (imagen). Stretch: apunta a S3, nunca el binario. */
export interface MediaReference {
  readonly referenceId: string;
  readonly mimeType: string;
  /** Clave/URI en S3 donde quedo el binario temporal. */
  readonly storageKey: string;
  readonly sha256?: string;
}

export interface AnalysisMessagePayload {
  readonly type: MessageContentType;
  readonly locale: string;
  /** Unica forma del texto que cruza a SQS. Datos sensibles ya redactados. */
  readonly redactedText: string;
  readonly urlReferences: readonly UrlReference[];
  readonly media: readonly MediaReference[];
}

export interface AnalysisEventMeta {
  /** ID de conversacion opaco del proveedor, si existe. */
  readonly kapsoConversationId?: string;
  /** Bandera para metricas; nunca el dato sensible en si. */
  readonly hadSensitiveData: boolean;
}

/** Evento publicado en SQS: solicitud de analisis de un mensaje. */
export interface AnalysisRequestedEvent {
  readonly schemaVersion: typeof ANALYSIS_EVENT_SCHEMA_VERSION;
  /** ID de mensaje del proveedor. Clave de idempotencia. */
  readonly messageId: string;
  /** Usuario seudonimizado (HMAC-SHA256 del telefono). */
  readonly userId: string;
  readonly provider: 'kapso';
  readonly channel: 'whatsapp';
  /** ISO-8601 UTC. */
  readonly receivedAt: string;
  readonly message: AnalysisMessagePayload;
  readonly meta: AnalysisEventMeta;
  /**
   * Token de enrutado cifrado (KMS) opcional. Feature desactivada por defecto
   * (ENABLE_ROUTING_TOKEN=false). Cuando esta presente, el processor lo descifra
   * para obtener el destino de la respuesta; nunca contiene el telefono en claro.
   */
  readonly encryptedRoutingToken?: string;
}

/**
 * Validador de esquema en runtime. Lo usan tanto el publisher (antes de enviar)
 * como el processor (al recibir), para no confiar ciegamente en la forma.
 * Devuelve la lista de problemas; vacia = valido.
 */
export function validateAnalysisEvent(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['event is not an object'];
  }
  const e = value as Record<string, unknown>;

  if (e['schemaVersion'] !== ANALYSIS_EVENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${ANALYSIS_EVENT_SCHEMA_VERSION}"`);
  }
  if (!isNonEmptyString(e['messageId'])) errors.push('messageId must be a non-empty string');
  if (!isNonEmptyString(e['userId'])) errors.push('userId must be a non-empty string');
  if (e['provider'] !== 'kapso') errors.push('provider must be "kapso"');
  if (e['channel'] !== 'whatsapp') errors.push('channel must be "whatsapp"');
  if (!isIsoDate(e['receivedAt'])) errors.push('receivedAt must be an ISO-8601 string');

  const message = e['message'];
  if (typeof message !== 'object' || message === null) {
    errors.push('message must be an object');
  } else {
    const m = message as Record<string, unknown>;
    if (m['type'] !== 'text' && m['type'] !== 'image') {
      errors.push('message.type must be "text" or "image"');
    }
    if (!isNonEmptyString(m['locale'])) errors.push('message.locale must be a non-empty string');
    if (typeof m['redactedText'] !== 'string') errors.push('message.redactedText must be a string');
    if (!Array.isArray(m['urlReferences'])) errors.push('message.urlReferences must be an array');
    if (!Array.isArray(m['media'])) errors.push('message.media must be an array');
  }

  const meta = e['meta'];
  if (typeof meta !== 'object' || meta === null) {
    errors.push('meta must be an object');
  } else if (typeof (meta as Record<string, unknown>)['hadSensitiveData'] !== 'boolean') {
    errors.push('meta.hadSensitiveData must be a boolean');
  }

  if (e['encryptedRoutingToken'] !== undefined && typeof e['encryptedRoutingToken'] !== 'string') {
    errors.push('encryptedRoutingToken must be a string when present');
  }

  return errors;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}
