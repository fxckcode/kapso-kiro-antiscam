import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { createWebhookHandler, type WebhookDeps } from '../../src/lambda/webhook';
import type { WebhookConfig } from '../../src/lambda/shared/config';
import type { Logger } from '../../src/lambda/shared/logger';
import { FallbackRedactor } from '../../src/messaging/redaction-fallback';
import { FallbackUrlSanitizer } from '../../src/messaging/url-fallback';
import { InMemoryIdempotencyStore } from '../../src/queue/idempotency';

const SECRET = 'webhook-secret';
const PHONE = '+5491100000000';

const config: WebhookConfig = {
  awsRegion: 'us-east-1',
  sqsQueueUrl: 'https://sqs.example/queue',
  idempotencyTableName: 'IdempotencyTable',
  webhookSecret: SECRET,
  signatureHeader: 'x-webhook-signature',
  tokenHeader: undefined,
  userIdHmacSecret: 'hmac-secret',
  messageMaxLength: 4096,
  locale: 'es',
};

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function buildEvent(body: string, signed = true): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    body,
    isBase64Encoded: false,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(signed ? { 'x-webhook-signature': sign(body) } : {}),
    },
  } as unknown as APIGatewayProxyEvent;
}

function textBody(text: string, id = 'wamid.1', conversationId = 'conv-1'): string {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              conversation_id: conversationId,
              messages: [{ id, from: PHONE, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

interface Harness {
  readonly deps: WebhookDeps;
  readonly publish: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const publish = vi.fn().mockResolvedValue({ messageId: 'sqs-1' });
  return {
    publish,
    deps: {
      config,
      logger: silentLogger,
      redactor: new FallbackRedactor(),
      urlSanitizer: new FallbackUrlSanitizer(),
      idempotency: new InMemoryIdempotencyStore({ createLeaseToken: () => 'lease-1' }),
      publisher: { publish },
    },
  };
}

describe('webhook handler', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('rejects an invalid signature before parsing or publishing', async () => {
    const response = await createWebhookHandler(h.deps)(buildEvent(textBody('hola'), false));
    expect(response.statusCode).toBe(401);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('requires POST and application/json', async () => {
    const handler = createWebhookHandler(h.deps);
    // GET without proper verification query params = 400
    const wrongMethod = buildEvent(textBody('hola'));
    wrongMethod.httpMethod = 'GET';
    expect((await handler(wrongMethod)).statusCode).toBe(400);

    const wrongType = buildEvent(textBody('hola'));
    wrongType.headers = { ...wrongType.headers, 'content-type': 'text/plain' };
    expect((await handler(wrongType)).statusCode).toBe(415);
  });

  it('returns 200 for an ignorable status event without enqueueing', async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'read' }] } }] }] });
    const response = await createWebhookHandler(h.deps)(buildEvent(body));
    expect(response.statusCode).toBe(200);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('serializes only redacted text and safe URLs to SQS', async () => {
    const body = textBody(
      `OTP 123456, clave=secret, llama ${PHONE}. ` +
        'https://user:pass@example.com/path?token=secret y https://trusted.example/path?token=secret#part',
    );
    const response = await createWebhookHandler(h.deps)(buildEvent(body));

    expect(response.statusCode).toBe(200);
    expect(h.publish).toHaveBeenCalledOnce();
    const published = h.publish.mock.calls[0]?.[0];
    const serialized = JSON.stringify(published);
    for (const forbidden of ['token=', 'secret', 'user:pass', '?', PHONE, '123456']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(published.urlReferences).toEqual([
      { referenceId: 'url-0', reputationUrl: 'https://trusted.example/path' },
    ]);
    expect(published.routingToken).toBe('5491100000000');
  });

  it('does not republish a duplicate message', async () => {
    const handler = createWebhookHandler(h.deps);
    const body = textBody('hola https://example.com/path');
    expect((await handler(buildEvent(body))).statusCode).toBe(200);
    const duplicate = await handler(buildEvent(body));
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(duplicate.body).status).toBe('duplicate');
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('releases RECEIVED after publication failure so a retry can enqueue', async () => {
    h.publish.mockRejectedValueOnce(new Error('sqs unavailable'));
    const handler = createWebhookHandler(h.deps);
    const body = textBody('hola https://example.com/path');
    expect((await handler(buildEvent(body))).statusCode).toBe(500);
    expect((await handler(buildEvent(body))).statusCode).toBe(200);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });
});
