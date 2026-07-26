import { describe, it, expect, vi } from 'vitest';
import { getLinkQr, qrOptionsFromEnv, parseQrResponse } from '../../src/kapso/qr';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const base = { baseUrl: 'https://api.kapso.example/v1', apiKey: 'key' };

describe('getLinkQr', () => {
  it('returns a mocked QR without hitting the network in mock mode', async () => {
    const fetchImpl = vi.fn();
    const result = await getLinkQr({ ...base, mock: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.state).toBe('pending');
    expect(result.qr).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns linked when the API says so', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { linked: true }));
    const result = await getLinkQr({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.state).toBe('linked');
  });

  it('returns pending with the qr payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { qr: 'data:image/png;base64,AAAA' }));
    const result = await getLinkQr({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.state).toBe('pending');
    expect(result.qr).toBe('data:image/png;base64,AAAA');
  });

  it('uses the configurable qr path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { linked: true }));
    await getLinkQr({ ...base, qrPath: '/whatsapp/qr', fetchImpl: fetchImpl as unknown as typeof fetch });
    const calledUrl = fetchImpl.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://api.kapso.example/v1/whatsapp/qr');
  });

  it('returns unknown on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const result = await getLinkQr({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.state).toBe('unknown');
  });

  it('returns unknown on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const result = await getLinkQr({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.state).toBe('unknown');
  });
});

describe('qrOptionsFromEnv', () => {
  it('reads path and mock flag from env', () => {
    const opts = qrOptionsFromEnv({
      KAPSO_API_BASE_URL: 'https://x',
      KAPSO_API_KEY: 'k',
      KAPSO_QR_PATH: '/custom',
      KAPSO_QR_MOCK: 'true',
    });
    expect(opts.qrPath).toBe('/custom');
    expect(opts.mock).toBe(true);
  });

  it('defaults the qr path to /qr', () => {
    const opts = qrOptionsFromEnv({ KAPSO_API_BASE_URL: 'https://x', KAPSO_API_KEY: 'k' });
    expect(opts.qrPath).toBe('/qr');
  });
});

describe('parseQrResponse', () => {
  it('detects linked via status field', () => {
    expect(parseQrResponse({ status: 'linked' }).state).toBe('linked');
  });
});
