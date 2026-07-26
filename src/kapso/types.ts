/**
 * Tipos del contrato de Kapso (proveedor de WhatsApp).
 *
 * IMPORTANTE: Kapso expone la WhatsApp Cloud API oficial, por lo que estos
 * tipos modelan esa forma. El contrato real (firma del webhook, nombres de
 * campos, IDs y reintentos) es un PENDIENTE del PRD (§13) y debe confirmarse
 * contra la documentacion de Kapso antes de desplegar.
 *
 * Estos tipos describen SOLO la forma cruda entrante/saliente de Kapso.
 * No representan el modelo interno (ver src/messaging/types.ts).
 */

/** Tipos de mensaje que soporta el MVP. Audio queda fuera; imagen es stretch. */
export type KapsoMessageType = 'text' | 'image' | 'unsupported';

/** Cuerpo de un mensaje de texto entrante. */
export interface KapsoTextBody {
  readonly body: string;
}

/** Referencia a media (imagen) entrante. El binario se descarga aparte. */
export interface KapsoMediaBody {
  /** ID opaco de media en Kapso/WhatsApp para descargar el binario. */
  readonly id: string;
  readonly mime_type?: string;
  readonly sha256?: string;
  readonly caption?: string;
}

/** Un mensaje individual dentro del payload entrante. */
export interface KapsoInboundMessage {
  /** ID unico del mensaje (idempotencia). Ej. WhatsApp `wamid.*`. */
  readonly id: string;
  /** Telefono del remitente en formato E.164 (dato sensible, no se propaga). */
  readonly from: string;
  /** Epoch en segundos como string, tal como lo envia WhatsApp. */
  readonly timestamp?: string;
  readonly type: string;
  readonly text?: KapsoTextBody;
  readonly image?: KapsoMediaBody;
}

/** Evento de estado (entregado, leido, etc.). No es un mensaje analizable. */
export interface KapsoStatusEvent {
  readonly id: string;
  readonly status: string;
  readonly recipient_id?: string;
  readonly timestamp?: string;
}

/** Metadatos del numero que recibe (numero compartido del bot). */
export interface KapsoMetadata {
  readonly display_phone_number?: string;
  readonly phone_number_id?: string;
}

/** Contenido de un cambio dentro del webhook. */
export interface KapsoValueChange {
  readonly messaging_product?: string;
  readonly metadata?: KapsoMetadata;
  readonly messages?: readonly KapsoInboundMessage[];
  readonly statuses?: readonly KapsoStatusEvent[];
  /** ID de conversacion opaco si Kapso lo provee. */
  readonly conversation_id?: string;
}

export interface KapsoChange {
  readonly field?: string;
  readonly value: KapsoValueChange;
}

export interface KapsoEntry {
  readonly id?: string;
  readonly changes: readonly KapsoChange[];
}

/** Payload crudo (formato Meta) tal como llega al webhook (raiz). */
export interface KapsoWebhookPayload {
  readonly object?: string;
  readonly entry: readonly KapsoEntry[];
}

/* ---------------------- Formato NATIVO de Kapso (v2) ---------------------- */
/*
 * Webhooks kind "kapso": el nombre del evento llega en el header X-Webhook-Event
 * (ej. "whatsapp.message.received") y el cuerpo tiene `message`, `conversation`
 * y `phone_number_id` al tope. Ver docs de Kapso "Event types".
 */

export interface KapsoNativeMessageKapso {
  /** "inbound" | "outbound". Solo procesamos inbound. */
  readonly direction?: string;
  readonly status?: string;
  readonly has_media?: boolean;
  /** Representacion textual del contenido (incluye caption/descripcion). */
  readonly content?: string;
}

export interface KapsoNativeMessage {
  readonly id: string;
  readonly timestamp?: string;
  readonly type: string;
  /** Telefono del remitente (puede no venir; usar conversation.phone_number). */
  readonly from?: string;
  readonly text?: KapsoTextBody;
  readonly image?: KapsoMediaBody;
  readonly kapso?: KapsoNativeMessageKapso;
}

export interface KapsoNativeConversation {
  readonly id?: string;
  readonly phone_number?: string;
  readonly phone_number_id?: string;
}

export interface KapsoNativeEvent {
  readonly message?: KapsoNativeMessage;
  readonly conversation?: KapsoNativeConversation;
  readonly phone_number_id?: string;
  readonly is_new_conversation?: boolean;
  /** Envelope de buffering (opcional). Mantener buffering OFF en el MVP. */
  readonly batch?: boolean;
  readonly data?: readonly unknown[];
}

/**
 * Resultado del parseo defensivo del payload crudo.
 * Distingue entre: mensaje analizable, evento no procesable y payload invalido.
 */
export type ParsedWebhook =
  | { readonly kind: 'message'; readonly message: KapsoInboundMessage; readonly metadata: KapsoMetadata; readonly conversationId?: string }
  | { readonly kind: 'ignorable'; readonly reason: IgnorableReason }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Razones por las que un payload es valido pero no procesable (-> responder 200). */
export type IgnorableReason =
  | 'status_event'
  | 'no_messages'
  | 'unsupported_message_type'
  | 'empty_entry'
  | 'not_inbound'
  | 'missing_sender';

/* ------------------------- Salida hacia Kapso ------------------------- */

/** Mensaje de texto saliente hacia Kapso. */
export interface KapsoOutboundText {
  readonly to: string;
  readonly type: 'text';
  readonly text: { readonly body: string };
}

/** Respuesta esperada de Kapso al enviar un mensaje. */
export interface KapsoSendResult {
  readonly messageId?: string;
  readonly accepted: boolean;
}
