/**
 * ConsentStore respaldado por DynamoDB.
 *
 * Item:
 *   userId        (PK, string)   - usuario seudonimizado (HMAC-SHA256). Nunca el telefono.
 *   consentStatus ("pending" | "accepted" | "revoked")
 *   updatedAt     (ISO-8601)
 *   ttl           (epoch segundos, opcional) - expiracion del registro (PRD §10)
 *
 * No guarda datos sensibles: solo el userId hasheado y el estado.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ConsentStatus, ConsentStore } from '../ports/consent';

export interface DynamoConsentStoreOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  /** TTL en dias para el registro de consentimiento. 0/undefined = sin TTL. */
  readonly ttlDays?: number;
}

interface ConsentItem {
  readonly userId: string;
  readonly consentStatus: ConsentStatus;
  readonly updatedAt: string;
  readonly ttl?: number;
}

export class DynamoConsentStore implements ConsentStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly ttlDays: number;

  constructor(options: DynamoConsentStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.ttlDays = options.ttlDays ?? 0;
  }

  async hasConsent(userId: string): Promise<boolean> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId },
        ProjectionExpression: 'consentStatus',
        ConsistentRead: true,
      }),
    );
    const item = result.Item as Pick<ConsentItem, 'consentStatus'> | undefined;
    return item?.consentStatus === 'accepted';
  }

  async grantConsent(userId: string): Promise<void> {
    await this.setStatus(userId, 'accepted');
  }

  async revokeConsent(userId: string): Promise<void> {
    await this.setStatus(userId, 'revoked');
  }

  private async setStatus(userId: string, status: ConsentStatus): Promise<void> {
    const now = new Date();
    const names: Record<string, string> = {
      '#s': 'consentStatus',
      '#u': 'updatedAt',
    };
    const values: Record<string, unknown> = {
      ':s': status,
      ':u': now.toISOString(),
    };
    let updateExpr = 'SET #s = :s, #u = :u';

    if (this.ttlDays > 0) {
      names['#t'] = 'ttl';
      values[':t'] = Math.floor(now.getTime() / 1000) + this.ttlDays * 24 * 60 * 60;
      updateExpr += ', #t = :t';
    }

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
}
