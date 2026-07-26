import { describe, it, expect, vi } from 'vitest';
import { AwsSecretsResolver } from '../../src/lambda/shared/secrets';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

function fakeClient(secretString: string | undefined) {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { send } as unknown as SecretsManagerClient & { send: ReturnType<typeof vi.fn> };
}

describe('AwsSecretsResolver', () => {
  it('uses the plaintext env value when present', async () => {
    const client = fakeClient('should-not-be-used');
    const resolver = new AwsSecretsResolver({ env: { KAPSO_API_KEY: 'plain-value' }, client });
    await expect(resolver.resolve('KAPSO_API_KEY')).resolves.toBe('plain-value');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('fetches from Secrets Manager using the ARN', async () => {
    const client = fakeClient('secret-from-sm');
    const resolver = new AwsSecretsResolver({
      env: { KAPSO_API_KEY_ARN: 'arn:aws:secretsmanager:...:key' },
      client,
    });
    await expect(resolver.resolve('KAPSO_API_KEY')).resolves.toBe('secret-from-sm');
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('caches by ARN and does not fetch twice', async () => {
    const client = fakeClient('cached-value');
    const resolver = new AwsSecretsResolver({
      env: { KAPSO_API_KEY_ARN: 'arn:aws:secretsmanager:...:key' },
      client,
    });
    await resolver.resolve('KAPSO_API_KEY');
    await resolver.resolve('KAPSO_API_KEY');
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('prefers plaintext over ARN when both are set', async () => {
    const client = fakeClient('from-sm');
    const resolver = new AwsSecretsResolver({
      env: { KAPSO_API_KEY: 'from-env', KAPSO_API_KEY_ARN: 'arn:...' },
      client,
    });
    await expect(resolver.resolve('KAPSO_API_KEY')).resolves.toBe('from-env');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('throws when neither value nor ARN is present', async () => {
    const resolver = new AwsSecretsResolver({ env: {}, client: fakeClient('x') });
    await expect(resolver.resolve('KAPSO_API_KEY')).rejects.toThrow(/KAPSO_API_KEY/);
  });

  it('throws when the secret has no string value', async () => {
    const client = fakeClient(undefined);
    const resolver = new AwsSecretsResolver({
      env: { KAPSO_API_KEY_ARN: 'arn:...' },
      client,
    });
    await expect(resolver.resolve('KAPSO_API_KEY')).rejects.toThrow(/no string value/);
  });
});
