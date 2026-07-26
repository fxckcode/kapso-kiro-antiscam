import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type {
  EnqueueClaim,
  IdempotencyStatus,
  IdempotencyStore,
  ProcessingClaim,
} from './idempotency';
import { randomUUID } from 'node:crypto';

interface DynamoRecord {
  readonly messageId: string;
  readonly status: IdempotencyStatus;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: number;
}

export interface DynamoIdempotencyStoreOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now?: () => Date;
  readonly leaseSeconds?: number;
  readonly recordTtlSeconds?: number;
  readonly createLeaseToken?: () => string;
}

/** DynamoDB implementation. Conditional writes make concurrent webhooks safe. */
export class DynamoIdempotencyStore implements IdempotencyStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => Date;
  private readonly leaseSeconds: number;
  private readonly recordTtlSeconds: number;
  private readonly createLeaseToken: () => string;

  constructor(options: DynamoIdempotencyStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.now = options.now ?? (() => new Date());
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.recordTtlSeconds = options.recordTtlSeconds ?? 7 * 24 * 60 * 60;
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
  }

  async acquireForEnqueue(messageId: string): Promise<EnqueueClaim> {
    const leaseToken = this.newLease();
    const times = this.times();
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            messageId,
            status: 'RECEIVED',
            leaseToken,
            leaseExpiresAt: times.leaseExpiresAt,
            updatedAt: times.updatedAt,
            ttl: times.ttl,
          },
          ConditionExpression: 'attribute_not_exists(messageId)',
        }),
      );
      return { kind: 'acquired', leaseToken };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    const existing = await this.read(messageId);
    if (existing?.status !== 'RECEIVED') return { kind: 'duplicate' };
    try {
      await this.client.send(this.acquireExpiredLeaseCommand(messageId, 'RECEIVED', leaseToken, times));
      return { kind: 'acquired', leaseToken };
    } catch (error) {
      if (isConditionalFailure(error)) return { kind: 'busy' };
      throw error;
    }
  }

  async markEnqueued(messageId: string, leaseToken: string): Promise<void> {
    const times = this.times();
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { messageId },
        UpdateExpression: 'SET #status = :enqueued, #updatedAt = :updatedAt, #ttl = :ttl REMOVE #leaseToken, #leaseExpiresAt',
        ConditionExpression: '#status = :received AND #leaseToken = :leaseToken',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
          '#ttl': 'ttl',
          '#leaseToken': 'leaseToken',
          '#leaseExpiresAt': 'leaseExpiresAt',
        },
        ExpressionAttributeValues: {
          ':enqueued': 'ENQUEUED',
          ':received': 'RECEIVED',
          ':leaseToken': leaseToken,
          ':updatedAt': times.updatedAt,
          ':ttl': times.ttl,
        },
      }),
    );
  }

  async releaseEnqueue(messageId: string, leaseToken: string): Promise<void> {
    await this.release(messageId, 'RECEIVED', leaseToken);
  }

  async claimProcessing(messageId: string): Promise<ProcessingClaim> {
    const existing = await this.read(messageId);
    if (existing === undefined) return { kind: 'busy' };
    if (existing.status === 'RESPONDED') return { kind: 'responded' };
    if (existing.status !== 'RECEIVED' && existing.status !== 'ENQUEUED' && existing.status !== 'PROCESSING') {
      return { kind: 'busy' };
    }
    if (existing.status === 'PROCESSING' && hasActiveLease(existing, this.now())) {
      return { kind: 'busy' };
    }

    const leaseToken = this.newLease();
    const times = this.times();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { messageId },
          UpdateExpression: 'SET #status = :processing, #leaseToken = :leaseToken, #leaseExpiresAt = :leaseExpiresAt, #updatedAt = :updatedAt, #ttl = :ttl',
          ConditionExpression: '#status IN (:received, :enqueued, :processing) AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt <= :now)',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#leaseToken': 'leaseToken',
            '#leaseExpiresAt': 'leaseExpiresAt',
            '#updatedAt': 'updatedAt',
            '#ttl': 'ttl',
          },
          ExpressionAttributeValues: {
            ':received': 'RECEIVED',
            ':enqueued': 'ENQUEUED',
            ':processing': 'PROCESSING',
            ':leaseToken': leaseToken,
            ':leaseExpiresAt': times.leaseExpiresAt,
            ':now': times.nowEpoch,
            ':updatedAt': times.updatedAt,
            ':ttl': times.ttl,
          },
        }),
      );
      return { kind: 'acquired', leaseToken };
    } catch (error) {
      if (isConditionalFailure(error)) return { kind: 'busy' };
      throw error;
    }
  }

  async releaseProcessing(messageId: string, leaseToken: string): Promise<void> {
    await this.release(messageId, 'PROCESSING', leaseToken);
  }

  async markResponded(messageId: string, leaseToken: string): Promise<void> {
    const times = this.times();
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { messageId },
        UpdateExpression: 'SET #status = :responded, #updatedAt = :updatedAt, #ttl = :ttl REMOVE #leaseToken, #leaseExpiresAt',
        ConditionExpression: '#status = :processing AND #leaseToken = :leaseToken',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
          '#ttl': 'ttl',
          '#leaseToken': 'leaseToken',
          '#leaseExpiresAt': 'leaseExpiresAt',
        },
        ExpressionAttributeValues: {
          ':responded': 'RESPONDED',
          ':processing': 'PROCESSING',
          ':leaseToken': leaseToken,
          ':updatedAt': times.updatedAt,
          ':ttl': times.ttl,
        },
      }),
    );
  }

  private async read(messageId: string): Promise<DynamoRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { messageId },
        ConsistentRead: true,
      }),
    );
    return result.Item as DynamoRecord | undefined;
  }

  private acquireExpiredLeaseCommand(
    messageId: string,
    status: 'RECEIVED',
    leaseToken: string,
    times: Times,
  ): UpdateCommand {
    return new UpdateCommand({
      TableName: this.tableName,
      Key: { messageId },
      UpdateExpression: 'SET #leaseToken = :leaseToken, #leaseExpiresAt = :leaseExpiresAt, #updatedAt = :updatedAt, #ttl = :ttl',
      ConditionExpression: '#status = :status AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt <= :now)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#leaseToken': 'leaseToken',
        '#leaseExpiresAt': 'leaseExpiresAt',
        '#updatedAt': 'updatedAt',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':leaseToken': leaseToken,
        ':leaseExpiresAt': times.leaseExpiresAt,
        ':now': times.nowEpoch,
        ':updatedAt': times.updatedAt,
        ':ttl': times.ttl,
      },
    });
  }

  private async release(messageId: string, status: IdempotencyStatus, leaseToken: string): Promise<void> {
    const times = this.times();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { messageId },
          UpdateExpression: 'SET #updatedAt = :updatedAt, #ttl = :ttl REMOVE #leaseToken, #leaseExpiresAt',
          ConditionExpression: '#status = :status AND #leaseToken = :leaseToken',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updatedAt': 'updatedAt',
            '#ttl': 'ttl',
            '#leaseToken': 'leaseToken',
            '#leaseExpiresAt': 'leaseExpiresAt',
          },
          ExpressionAttributeValues: {
            ':status': status,
            ':leaseToken': leaseToken,
            ':updatedAt': times.updatedAt,
            ':ttl': times.ttl,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  private times(): Times {
    const now = this.now();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    return {
      nowEpoch,
      leaseExpiresAt: nowEpoch + this.leaseSeconds,
      ttl: nowEpoch + this.recordTtlSeconds,
      updatedAt: now.toISOString(),
    };
  }

  private newLease(): string {
    const leaseToken = this.createLeaseToken();
    if (leaseToken.length === 0) throw new Error('idempotency lease token must not be empty');
    return leaseToken;
  }
}

interface Times {
  readonly nowEpoch: number;
  readonly leaseExpiresAt: number;
  readonly ttl: number;
  readonly updatedAt: string;
}

function hasActiveLease(record: DynamoRecord, now: Date): boolean {
  return record.leaseToken !== undefined && (record.leaseExpiresAt ?? 0) > Math.floor(now.getTime() / 1000);
}

function isConditionalFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ConditionalCheckFailedException';
}
