import { randomUUID } from 'node:crypto';

/** Estados persistidos por messageId para tolerar reintentos de webhook y SQS. */
export type IdempotencyStatus = 'RECEIVED' | 'ENQUEUED' | 'PROCESSING' | 'RESPONDED';

export type EnqueueClaim =
  | { readonly kind: 'acquired'; readonly leaseToken: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'busy' };

export type ProcessingClaim =
  | { readonly kind: 'acquired'; readonly leaseToken: string }
  | { readonly kind: 'responded' }
  | { readonly kind: 'busy' };

/**
 * El webhook toma una concesion RECEIVED antes de publicar. El processor toma
 * PROCESSING y solo completa RESPONDED despues del envio confirmado.
 */
export interface IdempotencyStore {
  acquireForEnqueue(messageId: string): Promise<EnqueueClaim>;
  markEnqueued(messageId: string, leaseToken: string): Promise<void>;
  releaseEnqueue(messageId: string, leaseToken: string): Promise<void>;
  claimProcessing(messageId: string): Promise<ProcessingClaim>;
  releaseProcessing(messageId: string, leaseToken: string): Promise<void>;
  markResponded(messageId: string, leaseToken: string): Promise<void>;
}

interface StoredRecord {
  status: IdempotencyStatus;
  leaseToken?: string;
  leaseExpiresAt?: number;
}

export interface InMemoryIdempotencyStoreOptions {
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly createLeaseToken?: () => string;
}

/** Solo para tests y ejecucion local; produccion usa DynamoIdempotencyStore. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly createLeaseToken: () => string;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
  }

  async acquireForEnqueue(messageId: string): Promise<EnqueueClaim> {
    const record = this.records.get(messageId);
    if (record === undefined) {
      const leaseToken = this.newLease();
      this.records.set(messageId, this.withLease('RECEIVED', leaseToken));
      return { kind: 'acquired', leaseToken };
    }
    if (record.status !== 'RECEIVED') return { kind: 'duplicate' };
    if (this.hasActiveLease(record)) return { kind: 'busy' };

    const leaseToken = this.newLease();
    this.records.set(messageId, this.withLease('RECEIVED', leaseToken));
    return { kind: 'acquired', leaseToken };
  }

  async markEnqueued(messageId: string, leaseToken: string): Promise<void> {
    this.requireLease(messageId, 'RECEIVED', leaseToken);
    this.records.set(messageId, { status: 'ENQUEUED' });
  }

  async releaseEnqueue(messageId: string, leaseToken: string): Promise<void> {
    this.release(messageId, 'RECEIVED', leaseToken);
  }

  async claimProcessing(messageId: string): Promise<ProcessingClaim> {
    const record = this.records.get(messageId);
    if (record === undefined) return { kind: 'busy' };
    if (record.status === 'RESPONDED') return { kind: 'responded' };
    if (record.status === 'PROCESSING' && this.hasActiveLease(record)) return { kind: 'busy' };
    if (record.status !== 'ENQUEUED' && record.status !== 'RECEIVED' && record.status !== 'PROCESSING') {
      return { kind: 'busy' };
    }

    const leaseToken = this.newLease();
    this.records.set(messageId, this.withLease('PROCESSING', leaseToken));
    return { kind: 'acquired', leaseToken };
  }

  async releaseProcessing(messageId: string, leaseToken: string): Promise<void> {
    this.release(messageId, 'PROCESSING', leaseToken);
  }

  async markResponded(messageId: string, leaseToken: string): Promise<void> {
    this.requireLease(messageId, 'PROCESSING', leaseToken);
    this.records.set(messageId, { status: 'RESPONDED' });
  }

  private newLease(): string {
    const token = this.createLeaseToken();
    if (token.length === 0) throw new Error('idempotency lease token must not be empty');
    return token;
  }

  private withLease(status: IdempotencyStatus, leaseToken: string): StoredRecord {
    return { status, leaseToken, leaseExpiresAt: this.now() + this.leaseMs };
  }

  private hasActiveLease(record: StoredRecord): boolean {
    return record.leaseToken !== undefined && (record.leaseExpiresAt ?? 0) > this.now();
  }

  private requireLease(messageId: string, status: IdempotencyStatus, leaseToken: string): void {
    const record = this.records.get(messageId);
    if (record?.status !== status || record.leaseToken !== leaseToken) {
      throw new Error('idempotency lease is no longer valid');
    }
  }

  private release(messageId: string, status: IdempotencyStatus, leaseToken: string): void {
    const record = this.records.get(messageId);
    if (record?.status === status && record.leaseToken === leaseToken) {
      this.records.set(messageId, { status });
    }
  }
}
