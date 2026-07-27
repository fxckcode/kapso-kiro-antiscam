/**
 * Cliente saliente hacia Kapso.
 *
 * El endpoint, header de autenticacion y payload siguen siendo provisionales
 * hasta confirmar el contrato de Kapso. Este cliente no realiza reintentos:
 * SQS gobierna los reintentos del flujo completo despues de clasificar el fallo.
 */
import type { WhatsAppSender } from '../messaging/types';
import type { KapsoOutboundText } from './types';

export interface KapsoClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly phoneNumberId?: string;
  readonly timeoutMs?: number;
  /** Inyectable para pruebas; no se usa red real en los tests. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 4_000;

/** No incluye cuerpo, URL, API key ni respuesta del proveedor. */
export class KapsoSendError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'KapsoSendError';
    this.retryable = retryable;
    this.status = status;
  }
}

export class KapsoClient implements WhatsAppSender {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly phoneNumberId: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KapsoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.phoneNumberId = options.phoneNumberId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendText(to: string, body: string, messageId?: string): Promise<void> {
    const cleanTo = to.replace(/^\+/, '');
    const payload: KapsoOutboundText = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: { body },
      ...(messageId !== undefined ? { context: { message_id: messageId } } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = this.phoneNumberId
        ? `${this.baseUrl}/${this.phoneNumberId}/messages`
        : `${this.baseUrl}/messages`;
      let response: Response;
      try {
        console.log('kapso request', { url, apiKeyPrefix: this.apiKey.slice(0, 8) + '...', payload: JSON.stringify(payload).slice(0, 200) });
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Provisional hasta que Kapso confirme su header de autenticacion.
            'x-api-key': this.apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        throw new KapsoSendError('Kapso request failed', true);
      }

      if (!response.ok) {
        const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
        const body = await response.text().catch(() => 'no body');
        console.error('kapso send failed', { status: response.status, body: body.slice(0, 200) });
        throw new KapsoSendError(`Kapso returned HTTP ${response.status}`, retryable, response.status);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
