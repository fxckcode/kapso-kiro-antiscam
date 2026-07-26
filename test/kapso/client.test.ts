import { describe, it, expect, vi } from 'vitest';
import { KapsoClient, KapsoSendError } from '../../src/kapso/client';

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeClient(fetchImpl: typeof fetch) {
  return new KapsoClient({
    baseUrl: 'https://api.kapso.example/v1',
    apiKey: 'key',
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    fetchImpl,
    sleepImpl: async () => {}, // sin esperas reales
  });
}

describe('KapsoClient retry/backoff', () => {
  it('succeeds on the first attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { messages: [{ id: 'm1' }] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.sendText('conv-1', 'hola');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries on 500 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(200));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.sendText('conv-1', 'hola');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.sendText('conv-1', 'hola');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400 and throws with status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.sendText('conv-1', 'hola')).rejects.toBeInstanceOf(KapsoSendError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries on network error and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response(200));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.sendText('conv-1', 'hola');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.sendText('conv-1', 'hola')).rejects.toBeInstanceOf(KapsoSendError);
    // intento inicial + 2 reintentos
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
