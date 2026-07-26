import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookAuth, type WebhookAuthConfig } from '../../src/kapso/auth';

const SECRET = 'super-secret';
const body = JSON.stringify({ hello: 'world' });

function hmac(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

const signatureConfig: WebhookAuthConfig = {
  secret: SECRET,
  signatureHeader: 'x-hub-signature-256',
  tokenHeader: 'x-kapso-token',
};

describe('verifyWebhookAuth - HMAC signature', () => {
  it('accepts a valid signature with sha256= prefix', () => {
    const headers = { 'x-hub-signature-256': `sha256=${hmac(body)}` };
    expect(verifyWebhookAuth(body, headers, signatureConfig)).toEqual({ ok: true });
  });

  it('accepts a valid signature without prefix', () => {
    const headers = { 'x-hub-signature-256': hmac(body) };
    expect(verifyWebhookAuth(body, headers, signatureConfig)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const headers = { 'x-hub-signature-256': hmac(body) };
    const result = verifyWebhookAuth(body + 'x', headers, signatureConfig);
    expect(result.ok).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const headers = { 'x-hub-signature-256': hmac(body, 'other') };
    const result = verifyWebhookAuth(body, headers, signatureConfig);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('is case-insensitive on header names', () => {
    const headers = { 'X-Hub-Signature-256': hmac(body) };
    expect(verifyWebhookAuth(body, headers, signatureConfig)).toEqual({ ok: true });
  });
});

describe('verifyWebhookAuth - shared token', () => {
  it('accepts a matching token when no signature is present', () => {
    const headers = { 'x-kapso-token': SECRET };
    expect(verifyWebhookAuth(body, headers, signatureConfig)).toEqual({ ok: true });
  });

  it('rejects a mismatched token', () => {
    const headers = { 'x-kapso-token': 'nope' };
    expect(verifyWebhookAuth(body, headers, signatureConfig)).toEqual({
      ok: false,
      reason: 'token_mismatch',
    });
  });
});

describe('verifyWebhookAuth - edge cases', () => {
  it('fails when no auth header is present', () => {
    expect(verifyWebhookAuth(body, {}, signatureConfig)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('fails when the secret is empty', () => {
    const result = verifyWebhookAuth(body, { 'x-hub-signature-256': 'x' }, {
      secret: '',
      signatureHeader: 'x-hub-signature-256',
    });
    expect(result).toEqual({ ok: false, reason: 'missing_secret' });
  });
});
