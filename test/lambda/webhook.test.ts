import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { createWebhookHandler, type WebhookDeps } from '../../src/lambda/webhook';
import type { WebhookConfig } from '../../src/lambda/shared/config';
import { FallbackRedactor } from '../../src/messaging/redaction-fallback';
import { FallbackUrlSanitizer } from '../../src/messaging/url-fallback';
import { InMemoryConsentStore } from '../../src/messaging/consent-fallback';
import type { Logger } from '../../src/lambda/shared/logger';

const SECRET = 'webhook-secret';

const config: WebhookConfig = {
  awsRegion: 'us-east-1',
  sqsQueueUrl: 'https://sqs/q',
  webhookSecret: SECRET,
  signatureHeader: 'x-hub-signature-256',
  tokenHeader: undefined,
  userIdHmacSecret: 'hmac-secret',
  messageMaxLength: 4096,
  locale: 'es',
};

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function buildEvent(body: string, signed = true): APIGatewayProxyEvent {
  return {
    body,
    isBase64Encoded: false,
    headers: signed ? { 'x-hub-signature-256': sign(body) } : {},
  } as unknown as APIGatewayProxyEvent;
}

function textBody(text: string, from = '+5491100000000', id = 'wamid.1'): string {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              conversation_id: 'conv-1',
              messages: [{ id, from, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

interface Harness {
  deps: WebhookDeps;
  publish: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  consent: InMemoryConsentStore;
}

function harness(): Harness {
  const publish = vi.fn().mockResolvedValue({ messageId: 'sqs-1' });
  const sendText = vi.fn().mockResolvedValue(undefined);
  const consent = new InMemoryConsentStore();
  const deps: WebhookDeps = {
    config,
    logger: silentLogger,
    redactor: new FallbackRedactor(),
    urlSanitizer: new FallbackUrlSanitizer(),
    consent,
    publisher: { publish },
    sender: { sendText },
  };
  return { deps, publish, sendText, consent };
}

describe('webhook handler', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('returns 401 when the signature is invalid', async () => {
    const handler = createWebhookHandler(h.deps);
    const res = await handler(buildEvent(textBody('hola'), false));
    expect(res.statusCode).toBe(401);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is missing', async () => {
    const handler = createWebhookHandler(h.deps);
    const event = { body: null, headers: {}, isBase64Encoded: false } as unknown as APIGatewayProxyEvent;
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 for a status event without enqueuing', async () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'read' }] } }] }],
    });
    const handler = createWebhookHandler(h.deps);
    const res = await handler(buildEvent(body));
    expect(res.statusCode).toBe(200);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('sends onboarding and does not enqueue when there is no consent', async () => {
    const handler = createWebhookHandler(h.deps);
    const res = await handler(buildEvent(textBody('hola')));
    expect(res.statusCode).toBe(200);
    expect(h.sendText).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('grants consent on ACEPTO and asks to resend', async () => {
    const handler = createWebhookHandler(h.deps);
    const res = await handler(buildEvent(textBody('ACEPTO')));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('consent_granted');
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('enqueues a redacted event once the user has consent', async () => {
    await h.consent.grantConsent(
      // userId derived the same way inside the handler
      (await import('../../src/messaging/pseudonymize')).pseudonymizePhone('+5491100000000', config.userIdHmacSecret),
    );
    const handler = createWebhookHandler(h.deps);
    const res = await handler(buildEvent(textBody('Tu codigo OTP es 123456 entra a https://banco-falso.com')));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('accepted');
    expect(h.publish).toHaveBeenCalledOnce();

    const event = h.publish.mock.calls[0]?.[0];
    expect(event.message.redactedText).not.toContain('123456');
    expect(event.message.redactedText).toContain('[OTP]');
    expect(event.userId).not.toContain('5491100000000');
    expect(event.message.urlReferences[0].domain).toBe('banco-falso.com');
    expect(event.meta.hadSensitiveData).toBe(true);
  });

  it('includes an encrypted routing token when the cipher is enabled', async () => {
    const encrypt = vi.fn().mockResolvedValue('cipher-abc');
    const cipherDeps = {
      ...h.deps,
      routingCipher: { enabled: true, encrypt, decrypt: vi.fn() },
    };
    await h.consent.grantConsent(
      (await import('../../src/messaging/pseudonymize')).pseudonymizePhone('+5491100000000', config.userIdHmacSecret),
    );
    const handler = createWebhookHandler(cipherDeps);
    const res = await handler(buildEvent(textBody('hola https://a.com')));
    expect(res.statusCode).toBe(200);
    expect(encrypt).toHaveBeenCalledWith('+5491100000000');
    const event = h.publish.mock.calls[0]?.[0];
    expect(event.encryptedRoutingToken).toBe('cipher-abc');
  });

  it('returns 500 when enqueue fails so the retry can complete it', async () => {
    h.publish.mockRejectedValueOnce(new Error('sqs down'));
    await h.consent.grantConsent(
      (await import('../../src/messaging/pseudonymize')).pseudonymizePhone('+5491100000000', config.userIdHmacSecret),
    );
    const handler = createWebhookHandler(h.deps);
    const res = await handler(buildEvent(textBody('hola https://a.com')));
    expect(res.statusCode).toBe(500);
  });
});
