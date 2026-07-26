/**
 * Cliente HTTP hacia Kapso (proveedor de WhatsApp).
 *
 * Unico punto de salida hacia la API de Kapso. Implementa el puerto
 * `WhatsAppSender`. Usa fetch nativo (Node 18+), timeout corto y no loguea el
 * cuerpo del mensaje ni la API key.
 *
 * PENDIENTE (PRD §13): el endpoint exacto, headers de auth y forma del body de
 * Kapso deben confirmarse contra su documentacion. Los valores aca son un punto
 * de partida alineado a la WhatsApp Cloud API.
 */
import type { WhatsAppSender } from '../messaging/types';
import type { KapsoOutboundText, KapsoSendResult } from './types';

export interface RetryOptions {
  /** Numero maximo de reintentos (ademas del intento inicial). */
  readonly maxRetries: number;
  /** Delay base en ms para el backoff exponencial. */
  readonly baseDelayMs: number;
  /** Tope de delay en ms. */
  readonly maxDelayMs: number;
}

export interface KapsoClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** ID del numero emisor compartido, si Kapso lo requiere en la ruta/body. */
  readonly phoneNumberId?: string;
  /** Timeout de red en ms por intento. */
  readonly timeoutMs?: number;
  /** Configuracion de reintentos con backoff exponencial + jitter. */
  readonly retry?: Partial<RetryOptions>;
  /** Inyectable para tests. */
  readonly fetchImpl?: typeof fetch;
  /** Inyectable para tests (evita esperas reales). */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RETRY: RetryOptions = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 };

/** Error de envio con el status HTTP asociado (si lo hubo). */
export class KapsoSendError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'KapsoSendError';
    this.status = status;
  }
}

export class KapsoClient implements WhatsAppSender {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly phoneNumberId: string | undefined;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: KapsoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.phoneNumberId = options.phoneNumberId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.sendWithRetry({ to, type: 'text', text: { body } });
  }

  /**
   * Envia con reintentos. Reintenta ante errores de red/timeout y respuestas
   * 429 o 5xx (transitorias). NO reintenta ante 4xx (excepto 429), que indican
   * un problema no recuperable. Backoff exponencial con jitter.
   */
  private async sendWithRetry(payload: KapsoOutboundText): Promise<KapsoSendResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt += 1) {
      try {
        return await this.sendOnce(payload);
      } catch (err) {
        lastError = err;
        const retryable = isRetryable(err);
        const hasBudget = attempt < this.retry.maxRetries;
        if (!retryable || !hasBudget) {
          break;
        }
        await this.sleepImpl(this.backoffDelay(attempt));
      }
    }

    if (lastError instanceof KapsoSendError) {
      throw lastError;
    }
    throw new KapsoSendError(
      `Kapso send failed after ${this.retry.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'unknown'
      }`,
    );
  }

  private async sendOnce(payload: KapsoOutboundText): Promise<KapsoSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = this.phoneNumberId
        ? `${this.baseUrl}/${this.phoneNumberId}/messages`
        : `${this.baseUrl}/messages`;

      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Kapso autentica con X-API-Key (no Bearer). Ver docs de Kapso.
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Lanza con status para decidir si reintentar (429/5xx) o no (4xx).
        throw new KapsoSendError(`Kapso responded ${response.status}`, response.status);
      }

      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const messageId = extractMessageId(json);
      return messageId !== undefined ? { accepted: true, messageId } : { accepted: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Backoff exponencial (base * 2^attempt) con jitter, topado por maxDelayMs. */
  private backoffDelay(attempt: number): number {
    const exp = this.retry.baseDelayMs * 2 ** attempt;
    const capped = Math.min(exp, this.retry.maxDelayMs);
    const jitter = Math.random() * capped * 0.25; // hasta 25% de jitter
    return Math.round(capped - capped * 0.25 + jitter);
  }
}

/** Reintenta ante red/timeout (no KapsoSendError) o status 429 / 5xx. */
function isRetryable(err: unknown): boolean {
  if (err instanceof KapsoSendError) {
    if (err.status === undefined) return true; // sin status -> tratado como transitorio
    if (err.status === 429) return true;
    return err.status >= 500 && err.status <= 599;
  }
  // AbortError (timeout) u otros errores de red -> transitorio.
  return true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageId(json: Record<string, unknown>): string | undefined {
  const messages = json['messages'];
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0];
    if (typeof first === 'object' && first !== null) {
      const id = (first as Record<string, unknown>)['id'];
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}
