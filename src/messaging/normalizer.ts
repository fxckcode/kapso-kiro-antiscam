/**
 * Normalizacion del mensaje entrante.
 *
 * Convierte un `KapsoInboundMessage` (crudo) en un `NormalizedInboundMessage`
 * interno. NO redacta ni sanitiza (eso lo hacen los puertos en el webhook).
 * El texto crudo resultante vive solo en memoria de la LambdaWebhook.
 */
import type { KapsoInboundMessage, KapsoMetadata } from '../kapso/types';
import type { MediaReference } from '../queue/events';
import type { NormalizedInboundMessage, NormalizedContentType } from './types';

const DEFAULT_LOCALE = 'es';

/** Extrae URLs http/https del texto. Regex conservadora, corta en espacios. */
const URL_REGEX = /https?:\/\/[^\s<>()"']+/gi;

export interface NormalizeOptions {
  /** Momento de recepcion en ISO-8601; por defecto ahora. */
  readonly receivedAt?: string;
  readonly locale?: string;
}

export function normalizeInbound(
  message: KapsoInboundMessage,
  _metadata: KapsoMetadata,
  conversationId: string | undefined,
  options: NormalizeOptions = {},
): NormalizedInboundMessage {
  const type: NormalizedContentType = message.type === 'image' ? 'image' : 'text';
  const receivedAt = options.receivedAt ?? toIso(message.timestamp) ?? new Date().toISOString();
  const locale = options.locale ?? DEFAULT_LOCALE;

  const rawText = extractRawText(message);
  const urlCandidates = extractUrls(rawText);
  const media = extractMedia(message);

  return {
    messageId: message.id,
    rawPhone: message.from,
    type,
    rawText,
    urlCandidates,
    media,
    ...(conversationId !== undefined ? { conversationId } : {}),
    receivedAt,
    locale,
  };
}

function extractRawText(message: KapsoInboundMessage): string {
  if (message.type === 'text') {
    return message.text?.body ?? '';
  }
  if (message.type === 'image') {
    return message.image?.caption ?? '';
  }
  return '';
}

/** Devuelve URLs unicas preservando el orden de aparicion. */
export function extractUrls(text: string): readonly string[] {
  const matches = text.match(URL_REGEX);
  if (matches === null) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const cleaned = stripTrailingPunctuation(raw);
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

/** Quita puntuacion final que suele pegarse a la URL en texto libre. */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}>'"]+$/, '');
}

/**
 * Referencia de media entrante. El binario NO se descarga aca; el `storageKey`
 * queda pendiente hasta que infra habilite S3 (stretch de imagenes).
 */
function extractMedia(message: KapsoInboundMessage): readonly MediaReference[] {
  if (message.type !== 'image' || message.image === undefined) {
    return [];
  }
  const media: MediaReference = {
    referenceId: `img-0`,
    mimeType: message.image.mime_type ?? 'application/octet-stream',
    // Placeholder: infra define el bucket/clave real al descargar el binario.
    storageKey: `kapso-media/${message.image.id}`,
    ...(message.image.sha256 !== undefined ? { sha256: message.image.sha256 } : {}),
  };
  return [media];
}

function toIso(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const asNumber = Number(timestamp);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    // WhatsApp envia epoch en segundos.
    return new Date(asNumber * 1000).toISOString();
  }
  return undefined;
}
