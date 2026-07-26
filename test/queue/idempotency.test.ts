import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DynamoIdempotencyStore } from '../../src/queue/dynamo-idempotency-store';
import { InMemoryIdempotencyStore } from '../../src/queue/idempotency';

describe('InMemoryIdempotencyStore', () => {
  it('allows webhook retry after a failed enqueue and does not republish terminal records', async () => {
    let now = 1_000;
    let counter = 0;
    const store = new InMemoryIdempotencyStore({
      now: () => now,
      leaseMs: 100,
      createLeaseToken: () => `lease-${++counter}`,
    });

    const first = await store.acquireForEnqueue('wamid.1');
    expect(first).toEqual({ kind: 'acquired', leaseToken: 'lease-1' });
    expect(await store.acquireForEnqueue('wamid.1')).toEqual({ kind: 'busy' });
    if (first.kind !== 'acquired') throw new Error('test setup failed');
    await store.releaseEnqueue('wamid.1', first.leaseToken);
    const retry = await store.acquireForEnqueue('wamid.1');
    expect(retry).toEqual({ kind: 'acquired', leaseToken: 'lease-2' });
    if (retry.kind !== 'acquired') throw new Error('test setup failed');
    await store.markEnqueued('wamid.1', retry.leaseToken);
    expect(await store.acquireForEnqueue('wamid.1')).toEqual({ kind: 'duplicate' });

    const processing = await store.claimProcessing('wamid.1');
    if (processing.kind !== 'acquired') throw new Error('test setup failed');
    await store.markResponded('wamid.1', processing.leaseToken);
    expect(await store.claimProcessing('wamid.1')).toEqual({ kind: 'responded' });
    now += 100;
  });
});

describe('DynamoIdempotencyStore', () => {
  it('generates conditional DynamoDB commands without calling AWS', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoIdempotencyStore({
      client,
      tableName: 'IdempotencyTable',
      now: () => new Date('2026-07-26T00:00:00.000Z'),
      createLeaseToken: () => 'lease-1',
    });

    const claim = await store.acquireForEnqueue('wamid.1');
    expect(claim).toEqual({ kind: 'acquired', leaseToken: 'lease-1' });
    const put = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(put.input).toMatchObject({
      TableName: 'IdempotencyTable',
      ConditionExpression: 'attribute_not_exists(messageId)',
      Item: expect.objectContaining({ messageId: 'wamid.1', status: 'RECEIVED', leaseToken: 'lease-1' }),
    });

    await store.markEnqueued('wamid.1', 'lease-1');
    const update = send.mock.calls[1]?.[0] as { input: Record<string, unknown> };
    expect(update.input).toMatchObject({
      TableName: 'IdempotencyTable',
      ConditionExpression: '#status = :received AND #leaseToken = :leaseToken',
    });
  });
});
