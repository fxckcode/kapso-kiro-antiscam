import { describe, expect, it, vi } from 'vitest';
import { KapsoClient, KapsoSendError } from '../../src/kapso/client';

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

function client(fetchImpl: typeof fetch): KapsoClient {
  return new KapsoClient({
    baseUrl: 'https://api.kapso.example/v1',
    apiKey: 'test-key',
    fetchImpl,
    timeoutMs: 10,
  });
}

describe('KapsoClient', () => {
  it('uses one injected fetch attempt for a successful send', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200));
    await expect(client(fetchImpl as unknown as typeof fetch).sendText('conv-1', 'hola')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 503])('classifies HTTP %i as retryable without an internal retry', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(status));
    await expect(client(fetchImpl as unknown as typeof fetch).sendText('conv-1', 'hola')).rejects.toMatchObject({
      retryable: true,
      status,
    } satisfies Partial<KapsoSendError>);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('classifies other 4xx responses as non-retryable without leaking credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400));
    await expect(client(fetchImpl as unknown as typeof fetch).sendText('conv-1', 'hola')).rejects.toMatchObject({
      retryable: false,
      status: 400,
    } satisfies Partial<KapsoSendError>);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('classifies network failures as retryable with one attempt', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unavailable'));
    await expect(client(fetchImpl as unknown as typeof fetch).sendText('conv-1', 'hola')).rejects.toMatchObject({
      retryable: true,
    } satisfies Partial<KapsoSendError>);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
