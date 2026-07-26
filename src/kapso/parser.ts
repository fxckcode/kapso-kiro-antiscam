/**
 * Parseo defensivo del payload crudo de Kapso.
 *
 * No confia en la forma del JSON. Distingue entre:
 *   - `message`   : hay un mensaje de texto/imagen analizable.
 *   - `ignorable` : payload valido pero no procesable (status, sin mensajes,
 *                   tipo no soportado) -> el webhook responde 200 rapido.
 *   - `invalid`   : payload malformado -> el webhook responde 400.
 *
 * Solo procesa el PRIMER mensaje relevante del payload (MVP 1:1). Nunca loguea
 * el contenido.
 */
import type {
  KapsoInboundMessage,
  KapsoMetadata,
  KapsoNativeEvent,
  KapsoNativeMessage,
  KapsoValueChange,
  ParsedWebhook,
} from './types';

const SUPPORTED_TYPES = new Set<string>(['text', 'image']);

/**
 * Parsea el cuerpo del webhook, autodetectando el formato:
 *  - Nativo de Kapso (kind "kapso"): tiene `message`/`conversation`/`phone_number_id`.
 *  - Meta (kind "meta"): tiene `entry[]`.
 * `eventName` es el header X-Webhook-Event (opcional, ayuda a decidir).
 */
export function parseWebhookBody(rawBody: string, eventName?: string): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { kind: 'invalid', reason: 'body_is_not_json' };
  }

  if (!isRecord(json)) {
    return { kind: 'invalid', reason: 'body_is_not_object' };
  }

  // Formato nativo de Kapso: no trae `entry`, pero si `message`/`conversation`
  // o `phone_number_id` al tope (o el header de evento lo indica).
  const looksNative =
    !Array.isArray(json['entry']) &&
    (isRecord(json['message']) ||
      isRecord(json['conversation']) ||
      typeof json['phone_number_id'] === 'string' ||
      (typeof eventName === 'string' && eventName.startsWith('whatsapp.')));

  if (looksNative) {
    return parseKapsoNative(json as unknown as KapsoNativeEvent);
  }

  return parseMetaBody(json);
}

/** Parseo del formato Meta (entry -> changes -> value.messages). */
function parseMetaBody(json: Record<string, unknown>): ParsedWebhook {
  const entry = json['entry'];
  if (!Array.isArray(entry)) {
    return { kind: 'invalid', reason: 'missing_entry_array' };
  }
  if (entry.length === 0) {
    return { kind: 'ignorable', reason: 'empty_entry' };
  }

  let sawStatus = false;
  let sawUnsupported = false;

  for (const entryItem of entry) {
    if (!isRecord(entryItem)) continue;
    const changes = entryItem['changes'];
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!isRecord(change)) continue;
      const value = change['value'];
      if (!isRecord(value)) continue;

      const v = value as unknown as KapsoValueChange;

      if (Array.isArray(v.statuses) && v.statuses.length > 0) {
        sawStatus = true;
      }

      const messages = v.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        continue;
      }

      for (const raw of messages) {
        const validated = validateMessage(raw);
        if (validated === 'unsupported') {
          sawUnsupported = true;
          continue;
        }
        if (validated !== null) {
          return {
            kind: 'message',
            message: validated,
            metadata: (v.metadata ?? {}) as KapsoMetadata,
            conversationId:
              typeof v.conversation_id === 'string'
                ? v.conversation_id
                : validated.from,
          };
        }
      }
    }
  }

  if (sawUnsupported) {
    return { kind: 'ignorable', reason: 'unsupported_message_type' };
  }
  if (sawStatus) {
    return { kind: 'ignorable', reason: 'status_event' };
  }
  return { kind: 'ignorable', reason: 'no_messages' };
}

/** Parseo del formato nativo de Kapso (evento whatsapp.message.received). */
function parseKapsoNative(event: KapsoNativeEvent): ParsedWebhook {
  // Envelope de buffering: procesamos el primer item del batch. (Mantener
  // buffering OFF en el MVP para no recibir varios mensajes por request.)
  if (event.batch === true) {
    if (!Array.isArray(event.data) || event.data.length === 0) {
      return { kind: 'ignorable', reason: 'no_messages' };
    }
    const first = event.data[0];
    if (!isRecord(first)) {
      return { kind: 'invalid', reason: 'batch_item_not_object' };
    }
    return parseKapsoNative(first as unknown as KapsoNativeEvent);
  }

  const message = event.message;
  if (!isRecord(message)) {
    // Eventos sin mensaje (conversation.*, etc.) -> no procesables.
    return { kind: 'ignorable', reason: 'no_messages' };
  }

  const m = message as unknown as KapsoNativeMessage;

  // Solo mensajes entrantes. Los eventos de salida (sent/delivered/...) traen
  // direction "outbound".
  if (m.kapso?.direction === 'outbound') {
    return { kind: 'ignorable', reason: 'not_inbound' };
  }

  if (typeof m.id !== 'string' || m.id.length === 0) {
    return { kind: 'invalid', reason: 'missing_message_id' };
  }
  if (typeof m.type !== 'string') {
    return { kind: 'invalid', reason: 'missing_message_type' };
  }
  if (!SUPPORTED_TYPES.has(m.type)) {
    return { kind: 'ignorable', reason: 'unsupported_message_type' };
  }

  // El remitente puede venir en message.from o en conversation.phone_number.
  const from = m.from ?? event.conversation?.phone_number;
  if (typeof from !== 'string' || from.length === 0) {
    return { kind: 'ignorable', reason: 'missing_sender' };
  }

  const timestamp = typeof m.timestamp === 'string' ? m.timestamp : undefined;

  let inbound: KapsoInboundMessage;
  if (m.type === 'text') {
    const textRaw = m.text;
    if (!isRecord(textRaw) || typeof textRaw['body'] !== 'string') {
      return { kind: 'ignorable', reason: 'no_messages' };
    }
    inbound = {
      id: m.id,
      from,
      type: 'text',
      ...(timestamp !== undefined ? { timestamp } : {}),
      text: { body: textRaw['body'] },
    };
  } else {
    // image
    const imageRaw = m.image;
    if (!isRecord(imageRaw) || typeof imageRaw['id'] !== 'string') {
      return { kind: 'ignorable', reason: 'unsupported_message_type' };
    }
    inbound = {
      id: m.id,
      from,
      type: 'image',
      ...(timestamp !== undefined ? { timestamp } : {}),
      image: {
        id: imageRaw['id'],
        ...(typeof imageRaw['mime_type'] === 'string' ? { mime_type: imageRaw['mime_type'] } : {}),
        ...(typeof imageRaw['sha256'] === 'string' ? { sha256: imageRaw['sha256'] } : {}),
        ...(typeof imageRaw['caption'] === 'string' ? { caption: imageRaw['caption'] } : {}),
      },
    };
  }

  const phoneNumberId = event.phone_number_id ?? event.conversation?.phone_number_id;
  const metadata: KapsoMetadata = phoneNumberId !== undefined ? { phone_number_id: phoneNumberId } : {};
  const conversationId = event.conversation?.id;

  return {
    kind: 'message',
    message: inbound,
    metadata,
    ...(typeof conversationId === 'string' ? { conversationId } : {}),
  };
}

/**
 * Valida un mensaje individual (formato Meta).
 * @returns el mensaje tipado, `'unsupported'` si el tipo no aplica, o null si
 *          faltan campos esenciales.
 */
function validateMessage(raw: unknown): KapsoInboundMessage | 'unsupported' | null {
  if (!isRecord(raw)) return null;

  const id = raw['id'];
  const from = raw['from'];
  const type = raw['type'];

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof from !== 'string' || from.length === 0) return null;
  if (typeof type !== 'string') return null;

  if (!SUPPORTED_TYPES.has(type)) {
    return 'unsupported';
  }

  const timestamp = typeof raw['timestamp'] === 'string' ? raw['timestamp'] : undefined;

  if (type === 'text') {
    const textRaw = raw['text'];
    if (!isRecord(textRaw) || typeof textRaw['body'] !== 'string') {
      return null; // texto sin cuerpo, no analizable
    }
    return {
      id,
      from,
      type,
      ...(timestamp !== undefined ? { timestamp } : {}),
      text: { body: textRaw['body'] },
    };
  }

  // type === 'image'
  const imageRaw = raw['image'];
  if (!isRecord(imageRaw) || typeof imageRaw['id'] !== 'string') {
    return null; // imagen sin id, no analizable
  }
  return {
    id,
    from,
    type,
    ...(timestamp !== undefined ? { timestamp } : {}),
    image: {
      id: imageRaw['id'],
      ...(typeof imageRaw['mime_type'] === 'string' ? { mime_type: imageRaw['mime_type'] } : {}),
      ...(typeof imageRaw['sha256'] === 'string' ? { sha256: imageRaw['sha256'] } : {}),
      ...(typeof imageRaw['caption'] === 'string' ? { caption: imageRaw['caption'] } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
