/**
 * QR de vinculacion del numero de Kapso.
 *
 * ⚠️ El contrato real de Kapso para obtener el QR/estado de vinculacion es un
 * PENDIENTE (PRD §13). Por eso este modulo es un ADAPTER configurable:
 *   - `KAPSO_QR_PATH`  : ruta del endpoint (default probable: `/qr`).
 *   - `KAPSO_QR_MOCK`  : si es "true", devuelve un QR simulado (sin llamar a la red).
 *
 * No forma parte del hot path del webhook: se usa una sola vez para vincular el
 * numero compartido del bot (setup / landing). No usar en prod hasta confirmar
 * el contrato real.
 */

export type LinkState = 'linked' | 'pending' | 'unknown';

export interface QrLinkStatus {
  readonly state: LinkState;
  /** Imagen del QR en data URL o base64, si Kapso la provee. */
  readonly qr?: string;
}

export interface QrClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Ruta del endpoint de QR. Default: `/qr`. Configurable por KAPSO_QR_PATH. */
  readonly qrPath?: string;
  /** Modo mock: no llama a la red, devuelve un QR simulado. */
  readonly mock?: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_QR_PATH = '/qr';

/** QR simulado (data URL trivial) para desarrollo sin contrato real. */
const MOCK_QR: QrLinkStatus = {
  state: 'pending',
  qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
};

/** Construye las opciones del cliente QR desde el entorno. */
export function qrOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): QrClientOptions {
  return {
    baseUrl: env['KAPSO_API_BASE_URL'] ?? '',
    apiKey: env['KAPSO_API_KEY'] ?? '',
    qrPath: env['KAPSO_QR_PATH'] ?? DEFAULT_QR_PATH,
    mock: env['KAPSO_QR_MOCK'] === 'true',
  };
}

/**
 * Obtiene el QR / estado de vinculacion.
 *
 * TODO(kapso-contract): ajustar la ruta (KAPSO_QR_PATH), headers y parseo cuando
 * se confirme el contrato real de Kapso.
 */
export async function getLinkQr(options: QrClientOptions): Promise<QrLinkStatus> {
  if (options.mock === true) {
    return MOCK_QR;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const path = options.qrPath ?? DEFAULT_QR_PATH;
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'x-api-key': options.apiKey },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { state: 'unknown' };
    }

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return parseQrResponse(json);
  } catch {
    // Error de red/timeout -> estado desconocido (no lanza; es setup, no hot path).
    return { state: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** Parseo defensivo de la respuesta (forma provisional, confirmar con Kapso). */
export function parseQrResponse(json: Record<string, unknown>): QrLinkStatus {
  const qr = typeof json['qr'] === 'string' ? json['qr'] : undefined;
  const linked = json['linked'] === true || json['status'] === 'linked';

  if (linked) {
    return { state: 'linked' };
  }
  return qr !== undefined ? { state: 'pending', qr } : { state: 'pending' };
}
