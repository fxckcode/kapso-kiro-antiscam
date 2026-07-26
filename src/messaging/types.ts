/**
 * Modelo interno de mensajeria de este frente.
 *
 * Es el paso intermedio entre el payload crudo de Kapso (src/kapso/types.ts) y
 * el evento que va a SQS (src/queue/events.ts). El texto crudo aqui presente
 * SOLO existe en memoria de la LambdaWebhook y nunca se propaga ni loguea.
 */
export type NormalizedContentType = 'text' | 'image';

/** Media queda fuera del evento de demo; esta referencia nunca cruza SQS. */
export interface MediaReference {
  readonly referenceId: string;
  readonly mimeType: string;
  readonly storageKey: string;
  readonly sha256?: string;
}

/** Mensaje entrante ya normalizado, antes de redaccion/sanitizacion. */
export interface NormalizedInboundMessage {
  /** ID del proveedor (idempotencia). */
  readonly messageId: string;
  /**
   * Telefono en E.164 (dato sensible). Solo se usa para seudonimizar y NO debe
   * copiarse a eventos, logs ni persistencia.
   */
  readonly rawPhone: string;
  readonly type: NormalizedContentType;
  /** Texto crudo en memoria. Vacio para imagen sin caption. */
  readonly rawText: string;
  /** URLs candidatas extraidas del texto, aun sin sanitizar. */
  readonly urlCandidates: readonly string[];
  /** Media entrante (imagen). Vacio en MVP de texto. */
  readonly media: readonly MediaReference[];
  readonly conversationId?: string;
  readonly receivedAt: string;
  readonly locale: string;
}

/** Mensaje saliente hacia el usuario por WhatsApp. */
export interface OutboundMessage {
  /** Telefono destino en E.164. */
  readonly to: string;
  readonly body: string;
}

/**
 * Puerto de envio de mensajes por WhatsApp (via Kapso).
 * Lo implementa src/kapso/client.ts. Solo LambdaProcessor (via responder) lo
 * usa para enviar un resultado de analisis; LambdaWebhook no envia mensajes.
 */
export interface WhatsAppSender {
  sendText(to: string, body: string, messageId?: string): Promise<void>;
}
