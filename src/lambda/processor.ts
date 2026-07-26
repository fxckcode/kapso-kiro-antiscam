/**
 * LambdaProcessor: consume la cola SQS de analisis y responde por Kapso.
 *
 * Contrato de fallos (SQS batch):
 *  - Usa `reportBatchItemFailures`: solo los records que fallan de forma
 *    TRANSITORIA (analisis o envio por Kapso) se devuelven en
 *    `batchItemFailures`, para que SQS reintente y, tras maxReceiveCount,
 *    caigan a la DLQ.
 *  - Los records NO recuperables (JSON invalido o esquema invalido) se
 *    descartan (se loguean y no se reintentan) para no envenenar la cola.
 *
 * Reglas:
 *  - NO importa src/detection: depende del puerto `AnalysisPipeline`.
 *  - NO loguea contenido crudo ni telefono; solo `userId` (hash) y `messageId`.
 *
 * Enrutado de la respuesta: el evento no contiene el telefono (solo el userId
 * seudonimizado). Se responde usando `kapsoConversationId`. PENDIENTE (§13):
 * confirmar que Kapso permite responder por conversacion; si exige el telefono,
 * infra debe inyectar un token de entrega cifrado (nunca el numero en claro).
 */
import type { SQSEvent, SQSRecord, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';

import { Responder } from '../messaging/responder';
import { KapsoClient } from '../kapso/client';
import { routingCipherFromEnv, type RoutingTokenCipher } from '../messaging/routing-token';
import type { AnalysisPipeline, AnalysisResult } from '../ports/analysis';
import { validateAnalysisEvent, type AnalysisRequestedEvent } from '../queue/events';
import { loadProcessorConfig, type ProcessorConfig } from './shared/config';
import { createLogger, type Logger } from './shared/logger';

/** Mensaje de modo degradado cuando el pipeline de analisis aun no esta conectado. */
export const ANALYSIS_NOT_CONNECTED_MESSAGE =
  '✅ Recibi tu mensaje. El analisis todavia no esta conectado, intenta mas tarde.';

/** Dependencias inyectables (facilita tests y el cableado de infra). */
export interface ProcessorDeps {
  readonly responder: Responder;
  readonly logger: Logger;
  /** Puerto de analisis. Si esta ausente, se responde en modo degradado. */
  readonly analysisPipeline?: AnalysisPipeline;
  /** Cipher opcional para descifrar el routing token. Default: desactivado. */
  readonly routingCipher?: RoutingTokenCipher;
}

export function createProcessorHandler(deps: ProcessorDeps) {
  return async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of event.Records) {
      const outcome = await processRecord(record, deps);
      if (outcome === 'retry') {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}

type RecordOutcome = 'done' | 'retry';

async function processRecord(record: SQSRecord, deps: ProcessorDeps): Promise<RecordOutcome> {
  const { responder, logger, analysisPipeline } = deps;

  // 1. Parseo del body (no recuperable si falla).
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.body);
  } catch {
    logger.warn('sqs record body is not valid JSON, dropping', { sqsMessageId: record.messageId });
    return 'done';
  }

  // 2. Validacion de esquema (no recuperable si falla).
  const errors = validateAnalysisEvent(parsed);
  if (errors.length > 0) {
    logger.warn('sqs record failed schema validation, dropping', {
      sqsMessageId: record.messageId,
      errorCount: errors.length,
    });
    return 'done';
  }

  const analysisEvent = parsed as AnalysisRequestedEvent;

  // Enrutado: si viene routing token cifrado y el cipher esta habilitado,
  // descifrar para obtener el destino; si no, usar kapsoConversationId.
  let replyTo: string | undefined = analysisEvent.meta.kapsoConversationId;
  if (analysisEvent.encryptedRoutingToken !== undefined && deps.routingCipher?.enabled) {
    try {
      replyTo = await deps.routingCipher.decrypt(analysisEvent.encryptedRoutingToken);
    } catch (err) {
      // Fallo de KMS: transitorio -> reintentar (bounded por maxReceiveCount).
      logger.error('failed to decrypt routing token', {
        userId: analysisEvent.userId,
        messageId: analysisEvent.messageId,
        error: errorMessage(err),
      });
      return 'retry';
    }
  }

  if (replyTo === undefined || replyTo.length === 0) {
    // Sin destino de respuesta no hay accion util; no tiene sentido reintentar.
    logger.warn('no reply destination on event, dropping', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
    });
    return 'done';
  }

  // 3. Modo degradado: pipeline no conectado.
  if (analysisPipeline === undefined) {
    try {
      await responder.respondWithText(replyTo, ANALYSIS_NOT_CONNECTED_MESSAGE);
      logger.info('responded in degraded mode (no pipeline)', {
        userId: analysisEvent.userId,
        messageId: analysisEvent.messageId,
      });
      return 'done';
    } catch (err) {
      logger.error('kapso send failed in degraded mode', {
        userId: analysisEvent.userId,
        messageId: analysisEvent.messageId,
        error: errorMessage(err),
      });
      return 'retry';
    }
  }

  // 4. Analisis real + respuesta.
  let result: AnalysisResult;
  try {
    result = await analysisPipeline.analyze(analysisEvent);
  } catch (err) {
    logger.error('analysis pipeline failed', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      error: errorMessage(err),
    });
    return 'retry';
  }

  try {
    await responder.respondWithResult(replyTo, result);
    logger.info('analysis responded', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      verdict: result.verdict,
    });
    return 'done';
  } catch (err) {
    logger.error('kapso send failed after analysis', {
      userId: analysisEvent.userId,
      messageId: analysisEvent.messageId,
      error: errorMessage(err),
    });
    return 'retry';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

/** Handler por defecto: cablea Kapso como sender. Sin pipeline -> modo degradado. */
let cached: ReturnType<typeof createProcessorHandler> | undefined;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  if (cached === undefined) {
    const config: ProcessorConfig = await loadProcessorConfig();
    const logger = createLogger();
    const sender = new KapsoClient({
      baseUrl: config.kapsoApiBaseUrl,
      apiKey: config.kapsoApiKey,
      ...(config.kapsoPhoneNumberId !== undefined ? { phoneNumberId: config.kapsoPhoneNumberId } : {}),
    });
    cached = createProcessorHandler({
      responder: new Responder(sender),
      logger,
      routingCipher: routingCipherFromEnv(),
      // analysisPipeline se inyecta cuando detection/domain lo exponga.
    });
  }
  return cached(event);
}
