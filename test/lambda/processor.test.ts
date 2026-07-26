import { describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

import { createProcessorHandler } from '../../src/lambda/processor';
import type { Logger } from '../../src/lambda/shared/logger';
import { Responder } from '../../src/messaging/responder';
import type { AnalysisResult, AnalysisService } from '../../src/ports/analysis';
import { ANALYSIS_EVENT_SCHEMA_VERSION, ANALYSIS_EVENT_TYPE, type AnalysisRequestedEvent } from '../../src/queue/events';
import { InMemoryIdempotencyStore } from '../../src/queue/idempotency';

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function validEvent(overrides: Partial<AnalysisRequestedEvent> = {}): AnalysisRequestedEvent {
  return {
    eventType: ANALYSIS_EVENT_TYPE,
    schemaVersion: ANALYSIS_EVENT_SCHEMA_VERSION,
    executionId: 'exec-0123456789abcdef0123456789abcdef',
    messageId: 'wamid.1',
    userId: 'hash-1',
    routingToken: 'conv-1',
    redactedText: 'hola',
    urlReferences: [],
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function record(body: string, id = 'sqs-1'): SQSRecord {
  return { messageId: id, body } as unknown as SQSRecord;
}

function sqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records } as SQSEvent;
}

const result: AnalysisResult = {
  verdict: 'scam',
  riskScore: 90,
  confidence: 0.9,
  category: 'phishing_bancario',
  evidence: [],
  recommendedActions: ['No abras el enlace'],
  shortExplanation: 'Pide credenciales',
  needsMoreInformation: false,
};

async function enqueuedStore(messageId = 'wamid.1'): Promise<InMemoryIdempotencyStore> {
  const store = new InMemoryIdempotencyStore({ createLeaseToken: () => 'lease-1' });
  const claim = await store.acquireForEnqueue(messageId);
  if (claim.kind !== 'acquired') throw new Error('test setup failed');
  await store.markEnqueued(messageId, claim.leaseToken);
  return store;
}

function service(status: 'success' | 'fallback' | 'retryable_error', output?: unknown): AnalysisService {
  return { analyze: vi.fn().mockResolvedValue({ status, ...(output === undefined ? {} : { result: output }) }) };
}

describe('processor handler', () => {
  it('drops invalid JSON without calling analysis or Kapso', async () => {
    const sendText = vi.fn();
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      idempotency: await enqueuedStore(),
      analysisService: service('success', result),
    });
    expect((await handler(sqsEvent([record('{not json')]))).batchItemFailures).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('sends only after AnalysisService succeeds and then marks RESPONDED', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const store = await enqueuedStore();
    const analysis = service('success', result);
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      idempotency: store,
      analysisService: analysis,
    });

    expect((await handler(sqsEvent([record(JSON.stringify(validEvent()))]))).batchItemFailures).toEqual([]);
    expect(analysis.analyze).toHaveBeenCalledWith({
      executionId: 'exec-0123456789abcdef0123456789abcdef',
      redactedText: 'hola',
      urlReferences: [],
    });
    expect(sendText).toHaveBeenCalledOnce();
    await expect(store.claimProcessing('wamid.1')).resolves.toEqual({ kind: 'responded' });
  });

  it('returns a batch failure when analysis asks for retry and sends nothing', async () => {
    const sendText = vi.fn();
    const store = await enqueuedStore();
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      idempotency: store,
      analysisService: service('retryable_error'),
    });

    expect((await handler(sqsEvent([record(JSON.stringify(validEvent()), 'sqs-2')]))).batchItemFailures).toEqual([
      { itemIdentifier: 'sqs-2' },
    ]);
    expect(sendText).not.toHaveBeenCalled();
    expect((await store.claimProcessing('wamid.1')).kind).toBe('acquired');
  });

  it('does not mark RESPONDED when the outgoing send fails', async () => {
    const sendText = vi.fn().mockRejectedValue(new Error('kapso unavailable'));
    const store = await enqueuedStore();
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      idempotency: store,
      analysisService: service('success', result),
    });

    expect((await handler(sqsEvent([record(JSON.stringify(validEvent()), 'sqs-3')]))).batchItemFailures).toEqual([
      { itemIdentifier: 'sqs-3' },
    ]);
    expect((await store.claimProcessing('wamid.1')).kind).toBe('acquired');
  });
});
