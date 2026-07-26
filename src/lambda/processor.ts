/**
 * LambdaProcessor consume SQS, delega el analisis al puerto inyectado y envia
 * una respuesta solo cuando hay un resultado. No contiene un agente ni emite
 * el antiguo mensaje "analisis no conectado".
 */
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { KapsoClient, KapsoSendError } from '../kapso/client';
import { createAntiScamAnalysisService } from '../analysis/antiscam-analysis-service';
import { Responder } from '../messaging/responder';
import type { AnalysisResult, AnalysisService } from '../ports/analysis';
import { DynamoIdempotencyStore } from '../queue/dynamo-idempotency-store';
import { validateAnalysisEvent, type AnalysisRequestedEvent } from '../queue/events';
import type { IdempotencyStore, ProcessingClaim } from '../queue/idempotency';
import { loadProcessorConfig, type ProcessorConfig } from './shared/config';
import { createLogger, type Logger } from './shared/logger';

export interface ProcessorDeps {
  readonly responder: Responder;
  readonly logger: Logger;
  readonly idempotency: IdempotencyStore;
  readonly analysisService?: AnalysisService;
}

export function createProcessorHandler(deps: ProcessorDeps) {
  return async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for (const record of event.Records) {
      if ((await processRecord(record, deps)) === 'retry') {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

type RecordOutcome = 'done' | 'retry';

async function processRecord(record: SQSRecord, deps: ProcessorDeps): Promise<RecordOutcome> {
  const { idempotency, logger } = deps;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.body);
  } catch {
    logger.warn('sqs record body is not valid JSON, dropping', { sqsMessageId: record.messageId });
    return 'done';
  }

  const validationErrors = validateAnalysisEvent(parsed);
  if (validationErrors.length > 0) {
    logger.warn('sqs record failed schema validation, dropping', {
      sqsMessageId: record.messageId,
      errorCount: validationErrors.length,
    });
    return 'done';
  }
  const analysisEvent = parsed as AnalysisRequestedEvent;

  let claim: ProcessingClaim;
  try {
    claim = await idempotency.claimProcessing(analysisEvent.messageId);
  } catch (error) {
    logger.error('idempotency processing claim failed', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      error: errorMessage(error),
    });
    return 'retry';
  }
  if (claim.kind === 'responded') return 'done';
  // La concesion puede pertenecer al webhook u otro worker; no borrar SQS aun.
  if (claim.kind === 'busy') return 'retry';

  if (deps.analysisService === undefined) {
    logger.warn('analysis service is not configured', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
    });
    await releaseForRetry(idempotency, analysisEvent, claim.leaseToken, logger);
    return 'retry';
  }

  let analysis: Awaited<ReturnType<AnalysisService['analyze']>>;
  try {
    analysis = await deps.analysisService.analyze({
      executionId: analysisEvent.executionId,
      messageId: analysisEvent.messageId,
      userId: analysisEvent.userId,
      redactedText: analysisEvent.redactedText,
      urlReferences: analysisEvent.urlReferences,
    });
  } catch (error) {
    logger.error('analysis service failed', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      error: errorMessage(error),
    });
    await releaseForRetry(idempotency, analysisEvent, claim.leaseToken, logger);
    return 'retry';
  }

  if (analysis.status === 'retryable_error') {
    await releaseForRetry(idempotency, analysisEvent, claim.leaseToken, logger);
    return 'retry';
  }
  if ((analysis.status !== 'success' && analysis.status !== 'fallback') || !isAnalysisResult(analysis.result)) {
    logger.error('analysis service returned no usable result', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
    });
    await releaseForRetry(idempotency, analysisEvent, claim.leaseToken, logger);
    return 'retry';
  }

  try {
    await deps.responder.respondWithResult(analysisEvent.routingToken, analysis.result);
  } catch (error) {
    const retryable = !(error instanceof KapsoSendError) || error.retryable;
    logger.error('kapso send failed after analysis', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      retryable,
      error: errorMessage(error),
    });
    await releaseForRetry(idempotency, analysisEvent, claim.leaseToken, logger);
    return retryable ? 'retry' : 'done';
  }

  try {
    await idempotency.markResponded(analysisEvent.messageId, claim.leaseToken);
  } catch (error) {
    // El envio ya ocurrio; la marca fallida se reintentara y el store decide si duplica.
    logger.error('failed to mark response as sent', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      error: errorMessage(error),
    });
    return 'retry';
  }

  logger.info('analysis responded', { userId: analysisEvent.userId, messageId: analysisEvent.messageId });
  return 'done';
}

async function releaseForRetry(
  idempotency: IdempotencyStore,
  event: AnalysisRequestedEvent,
  leaseToken: string,
  logger: Logger,
): Promise<void> {
  try {
    await idempotency.releaseProcessing(event.messageId, leaseToken);
  } catch (error) {
    logger.error('failed to release processing lease', {
      userId: event.userId,
      messageId: event.messageId,
      error: errorMessage(error),
    });
  }
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (!isRecord(value)) return false;
  const verdict = value['verdict'];
  const score = value['riskScore'];
  const confidence = value['confidence'];
  return (
    (verdict === 'scam' ||
      verdict === 'suspicious' ||
      verdict === 'insufficient_information' ||
      verdict === 'likely_legitimate') &&
    typeof score === 'number' &&
    Number.isFinite(score) &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    Array.isArray(value['recommendedActions']) &&
    typeof value['shortExplanation'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

let cached: ReturnType<typeof createProcessorHandler> | undefined;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  if (cached === undefined) {
    const config: ProcessorConfig = await loadProcessorConfig();
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }));
    const sender = new KapsoClient({
      baseUrl: config.kapsoApiBaseUrl,
      apiKey: config.kapsoApiKey,
      ...(config.kapsoPhoneNumberId !== undefined ? { phoneNumberId: config.kapsoPhoneNumberId } : {}),
    });
    cached = createProcessorHandler({
      responder: new Responder(sender),
      logger: createLogger(),
      idempotency: new DynamoIdempotencyStore({
        client: documentClient,
        tableName: config.idempotencyTableName,
      }),
      analysisService: createAntiScamAnalysisService({
        agentTimeoutMs: config.agentTimeoutMs,
      }),
    });
  }
  return cached(event);
}
