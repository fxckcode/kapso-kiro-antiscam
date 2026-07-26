import { describe, it, expect, vi } from 'vitest';
import {
  DisabledRoutingTokenCipher,
  KmsRoutingTokenCipher,
  routingCipherFromEnv,
} from '../../src/messaging/routing-token';
import type { KMSClient } from '@aws-sdk/client-kms';

describe('DisabledRoutingTokenCipher', () => {
  it('is disabled and throws on use', async () => {
    const cipher = new DisabledRoutingTokenCipher();
    expect(cipher.enabled).toBe(false);
    await expect(cipher.encrypt('x')).rejects.toThrow();
    await expect(cipher.decrypt('x')).rejects.toThrow();
  });
});

describe('KmsRoutingTokenCipher', () => {
  function kmsClient() {
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === 'EncryptCommand') {
        // devuelve el plaintext como "ciphertext" para poder verificar el roundtrip
        return { CiphertextBlob: cmd.input['Plaintext'] as Uint8Array };
      }
      if (cmd.constructor.name === 'DecryptCommand') {
        return { Plaintext: cmd.input['CiphertextBlob'] as Uint8Array };
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
    return { client: { send } as unknown as KMSClient, send };
  }

  it('encrypts to base64 and decrypts back (roundtrip via mock)', async () => {
    const { client } = kmsClient();
    const cipher = new KmsRoutingTokenCipher({ keyId: 'key-1', client });
    expect(cipher.enabled).toBe(true);

    const token = await cipher.encrypt('+5491100000000');
    // el mock devuelve el mismo buffer, así que base64 -> utf8 recupera el valor
    expect(token).toBe(Buffer.from('+5491100000000', 'utf8').toString('base64'));

    const back = await cipher.decrypt(token);
    expect(back).toBe('+5491100000000');
  });

  it('throws when KMS returns no ciphertext', async () => {
    const send = vi.fn().mockResolvedValue({});
    const cipher = new KmsRoutingTokenCipher({
      keyId: 'key-1',
      client: { send } as unknown as KMSClient,
    });
    await expect(cipher.encrypt('x')).rejects.toThrow(/ciphertext/);
  });
});

describe('routingCipherFromEnv', () => {
  it('is disabled by default', () => {
    expect(routingCipherFromEnv({}).enabled).toBe(false);
  });

  it('is disabled when flag is true but no key', () => {
    expect(routingCipherFromEnv({ ENABLE_ROUTING_TOKEN: 'true' }).enabled).toBe(false);
  });

  it('is enabled when flag is true and key is present', () => {
    const cipher = routingCipherFromEnv({
      ENABLE_ROUTING_TOKEN: 'true',
      ROUTING_TOKEN_KMS_KEY_ID: 'arn:aws:kms:...:key/abc',
    });
    expect(cipher.enabled).toBe(true);
  });
});
