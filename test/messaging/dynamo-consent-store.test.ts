import { describe, it, expect, vi } from 'vitest';
import { DynamoConsentStore } from '../../src/messaging/dynamo-consent-store';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

function docClient(sendImpl: (cmd: unknown) => Promise<unknown>) {
  const send = vi.fn(sendImpl);
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

const TABLE = 'ConsentTable';

describe('DynamoConsentStore', () => {
  it('returns true when consentStatus is accepted', async () => {
    const { client, send } = docClient(async () => ({ Item: { consentStatus: 'accepted' } }));
    const store = new DynamoConsentStore({ client, tableName: TABLE });
    await expect(store.hasConsent('user-1')).resolves.toBe(true);
    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.TableName).toBe(TABLE);
    expect(input.Key).toEqual({ userId: 'user-1' });
  });

  it('returns false when the item is missing', async () => {
    const { client } = docClient(async () => ({ Item: undefined }));
    const store = new DynamoConsentStore({ client, tableName: TABLE });
    await expect(store.hasConsent('user-1')).resolves.toBe(false);
  });

  it('returns false when status is pending', async () => {
    const { client } = docClient(async () => ({ Item: { consentStatus: 'pending' } }));
    const store = new DynamoConsentStore({ client, tableName: TABLE });
    await expect(store.hasConsent('user-1')).resolves.toBe(false);
  });

  it('writes accepted status on grantConsent', async () => {
    const { client, send } = docClient(async () => ({}));
    const store = new DynamoConsentStore({ client, tableName: TABLE });
    await store.grantConsent('user-1');
    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ':s': 'accepted' });
    expect(input.UpdateExpression).not.toContain('#t'); // sin TTL por defecto
  });

  it('writes revoked status on revokeConsent', async () => {
    const { client, send } = docClient(async () => ({}));
    const store = new DynamoConsentStore({ client, tableName: TABLE });
    await store.revokeConsent('user-1');
    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ':s': 'revoked' });
  });

  it('adds a ttl attribute when ttlDays is set', async () => {
    const { client, send } = docClient(async () => ({}));
    const store = new DynamoConsentStore({ client, tableName: TABLE, ttlDays: 30 });
    await store.grantConsent('user-1');
    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.UpdateExpression).toContain('#t');
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    expect(typeof values[':t']).toBe('number');
  });
});
