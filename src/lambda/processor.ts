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
import { createConversationService } from '../agent/create-conversation-service';
import { buildBedrockProviderConfig, createBedrockProvider } from '../agent/model/bedrock-provider';

export interface ProcessorDeps {
  readonly responder: Responder;
  readonly logger: Logger;
  readonly idempotency: IdempotencyStore;
  readonly analysisService?: AnalysisService;
  readonly conversationService?: import('../ports/conversation.js').ConversationService;
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

  // Saludos: respuesta rapida sin agentes ni Bedrock.
  const text = (analysisEvent.redactedText ?? '').toLowerCase().trim();
  const greetingPattern = /^(hola|ola|buenas?|hey|ey|qu[eé] (tal|hay|cuenta|c pasa)|c[oó]mo (est[áa]s|van)|q[uo]e se dice)\s*[.!]*$/i;
  if (greetingPattern.test(text)) {
    const replies = [
      '¡Hola! 👋 Soy el asistente AntiScamBot. ¿Tenés algún mensaje sospechoso para verificar?',
      '¡Hola! ¿Cómo estás? En qué puedo ayudarte con la seguridad hoy?',
      '¡Buenas! Si recibiste un mensaje raro, reenviámelo y lo analizo.',
    ];
    const response = replies[Math.floor(Math.random() * replies.length)] as string;
    await deps.responder.respondWithText(analysisEvent.routingToken, response, analysisEvent.messageId as string);
    logger.info('greeting response sent', { userId: analysisEvent.userId, messageId: analysisEvent.messageId });
    return 'done';
  }

  // "MAS INFO" o "más info": respuesta rapida.
  if (/^m[áa]s\s+info$/i.test(text) || /^detalles?$/i.test(text)) {
    const response =
      'ℹ️ Reenviame el mensaje sospechoso y lo analizo al instante.';
    await deps.responder.respondWithText(analysisEvent.routingToken, response, analysisEvent.messageId);
    logger.info('info response sent', { userId: analysisEvent.userId, messageId: analysisEvent.messageId });
    return 'done';
  }

  // Servicio conversacional: responde con el agente Strands.
  if (deps.conversationService !== undefined) {
    try {
      const outcome = await deps.conversationService.converse(analysisEvent);
      if (outcome.kind === 'reply') {
        await deps.responder.respondWithText(analysisEvent.routingToken, outcome.text, analysisEvent.messageId);
        logger.info('conversation reply sent', { userId: analysisEvent.userId, messageId: analysisEvent.messageId });
        return 'done';
      }
    } catch (error) {
      logger.error('conversation service failed', {
        userId: analysisEvent.userId,
        messageId: analysisEvent.messageId,
        error: errorMessage(error),
      });
      // Fall through to analysis service.
    }
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
    await deps.responder.respondWithResult(analysisEvent.routingToken, analysis.result, analysisEvent.messageId);
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
    const responder = new Responder(sender);
    const now = () => new Date().toISOString();
    const model = createBedrockProvider(buildBedrockProviderConfig());
    const reputationDeps = {
      provider: {
        check: async () => ({
          status: 'temporary_error' as const,
          source: 'virustotal' as const,
          summary: 'Reputacion no disponible.',
        }),
      },
      cache: {
        get: () => null,
        set: () => {},
      },
      allowlist: {} as never,
      now,
    } as unknown as Parameters<typeof createConversationService>[0]['reputationDeps'];

    cached = createProcessorHandler({
      responder,
      logger: createLogger(),
      idempotency: new DynamoIdempotencyStore({
        client: documentClient,
        tableName: config.idempotencyTableName,
      }),
      analysisService: createAntiScamAnalysisService({
        agentTimeoutMs: config.agentTimeoutMs,
      }),
      conversationService: createConversationService({
        model,
        reputationDeps,
        responder,
        now,
      }),
    });
  }
  return cached(event);
}
