import { describe, it, expect, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

import {
  createProcessorHandler,
  ANALYSIS_NOT_CONNECTED_MESSAGE,
} from '../../src/lambda/processor';
import { Responder } from '../../src/messaging/responder';
import type { Logger } from '../../src/lambda/shared/logger';
import type { AnalysisPipeline, AnalysisResult } from '../../src/ports/analysis';
import {
  ANALYSIS_EVENT_SCHEMA_VERSION,
  type AnalysisRequestedEvent,
} from '../../src/queue/events';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function validEvent(overrides: Partial<AnalysisRequestedEvent> = {}): AnalysisRequestedEvent {
  return {
    schemaVersion: ANALYSIS_EVENT_SCHEMA_VERSION,
    messageId: 'wamid.1',
    userId: 'hash-1',
    provider: 'kapso',
    channel: 'whatsapp',
    receivedAt: new Date().toISOString(),
    message: { type: 'text', locale: 'es', redactedText: 'hola', urlReferences: [], media: [] },
    meta: { kapsoConversationId: 'conv-1', hadSensitiveData: false },
    ...overrides,
  };
}

function record(body: string, id = 'sqs-1'): SQSRecord {
  return { messageId: id, body } as unknown as SQSRecord;
}

function sqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records } as SQSEvent;
}

const okResult: AnalysisResult = {
  verdict: 'scam',
  riskScore: 90,
  confidence: 0.9,
  category: 'phishing_bancario',
  evidence: [],
  recommendedActions: ['No abras el enlace'],
  shortExplanation: 'Pide credenciales',
  needsMoreInformation: false,
};

describe('processor handler', () => {
  it('responds in degraded mode when no pipeline is provided', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
    });

    const res = await handler(sqsEvent([record(JSON.stringify(validEvent()))]));

    expect(res.batchItemFailures).toEqual([]);
    expect(sendText).toHaveBeenCalledWith('conv-1', ANALYSIS_NOT_CONNECTED_MESSAGE);
  });

  it('drops a record with invalid JSON without failing the batch', async () => {
    const sendText = vi.fn();
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
    });

    const res = await handler(sqsEvent([record('{not json')]));

    expect(res.batchItemFailures).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('drops a record that fails schema validation', async () => {
    const sendText = vi.fn();
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
    });

    const res = await handler(sqsEvent([record(JSON.stringify({ foo: 'bar' }))]));
    expect(res.batchItemFailures).toEqual([]);
  });

  it('runs the pipeline and responds with the verdict', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const pipeline: AnalysisPipeline = { analyze: vi.fn().mockResolvedValue(okResult) };
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      analysisPipeline: pipeline,
    });

    const res = await handler(sqsEvent([record(JSON.stringify(validEvent()))]));

    expect(res.batchItemFailures).toEqual([]);
    expect(pipeline.analyze).toHaveBeenCalledOnce();
    const sentBody = sendText.mock.calls[0]?.[1] as string;
    expect(sentBody).toContain('🚨');
  });

  it('reports batch item failure when Kapso send fails', async () => {
    const sendText = vi.fn().mockRejectedValue(new Error('kapso 500'));
    const pipeline: AnalysisPipeline = { analyze: vi.fn().mockResolvedValue(okResult) };
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      analysisPipeline: pipeline,
    });

    const res = await handler(sqsEvent([record(JSON.stringify(validEvent()), 'sqs-9')]));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-9' }]);
  });

  it('reports batch item failure when the pipeline throws', async () => {
    const sendText = vi.fn();
    const pipeline: AnalysisPipeline = { analyze: vi.fn().mockRejectedValue(new Error('bedrock down')) };
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      analysisPipeline: pipeline,
    });

    const res = await handler(sqsEvent([record(JSON.stringify(validEvent()), 'sqs-7')]));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-7' }]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('decrypts the routing token and responds to the decrypted destination', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const decrypt = vi.fn().mockResolvedValue('+5491100000000');
    const pipeline: AnalysisPipeline = { analyze: vi.fn().mockResolvedValue(okResult) };
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      analysisPipeline: pipeline,
      routingCipher: { enabled: true, encrypt: vi.fn(), decrypt },
    });

    const event = validEvent({ encryptedRoutingToken: 'cipher-abc' });
    const res = await handler(sqsEvent([record(JSON.stringify(event))]));

    expect(res.batchItemFailures).toEqual([]);
    expect(decrypt).toHaveBeenCalledWith('cipher-abc');
    expect(sendText.mock.calls[0]?.[0]).toBe('+5491100000000');
  });

  it('retries when routing token decryption fails', async () => {
    const sendText = vi.fn();
    const decrypt = vi.fn().mockRejectedValue(new Error('kms down'));
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      analysisPipeline: { analyze: vi.fn().mockResolvedValue(okResult) },
      routingCipher: { enabled: true, encrypt: vi.fn(), decrypt },
    });

    const event = validEvent({ encryptedRoutingToken: 'bad' });
    const res = await handler(sqsEvent([record(JSON.stringify(event), 'sqs-k')]));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-k' }]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('processes a batch independently, isolating failures', async () => {
    const sendText = vi
      .fn()
      .mockResolvedValueOnce(undefined) // first ok
      .mockRejectedValueOnce(new Error('kapso down')); // second fails
    const pipeline: AnalysisPipeline = { analyze: vi.fn().mockResolvedValue(okResult) };
    const handler = createProcessorHandler({
      responder: new Responder({ sendText }),
      logger: silentLogger,
      analysisPipeline: pipeline,
    });

    const res = await handler(
      sqsEvent([
        record(JSON.stringify(validEvent({ messageId: 'a' })), 'sqs-a'),
        record(JSON.stringify(validEvent({ messageId: 'b' })), 'sqs-b'),
      ]),
    );

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-b' }]);
  });
});
