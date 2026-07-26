/**
 * LambdaWebhook acepta rapidamente un mensaje Kapso, lo sanea y lo publica en
 * SQS. La firma HMAC es una implementacion provisional configurable mediante
 * KAPSO_SIGNATURE_HEADER; el contrato oficial de firma sigue pendiente.
 */
import { createHash } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { verifyWebhookAuth, type WebhookAuthConfig } from '../kapso/auth';
import { parseWebhookBody } from '../kapso/parser';
import { normalizeInbound, extractUrls } from '../messaging/normalizer';
import { pseudonymizePhone } from '../messaging/pseudonymize';
import { FallbackRedactor } from '../messaging/redaction-fallback';
import { FallbackUrlSanitizer } from '../messaging/url-fallback';
import type { Redactor } from '../ports/redaction';
import type { UrlSanitizer } from '../ports/url';
import { DynamoIdempotencyStore } from '../queue/dynamo-idempotency-store';
import type { IdempotencyStore } from '../queue/idempotency';
import { QueuePublisher } from '../queue/publisher';
import {
  ANALYSIS_EVENT_SCHEMA_VERSION,
  ANALYSIS_EVENT_TYPE,
  type AnalysisRequestedEvent,
  type SafeUrlReference,
} from '../queue/events';
import { loadWebhookConfig, type WebhookConfig } from './shared/config';
import { AwsSecretsResolver } from './shared/secrets';
import { createLogger, type Logger } from './shared/logger';

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const ROUTING_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WebhookDeps {
  readonly config: WebhookConfig;
  readonly redactor: Redactor;
  readonly urlSanitizer: UrlSanitizer;
  readonly publisher: Pick<QueuePublisher, 'publish'>;
  readonly idempotency: IdempotencyStore;
  readonly logger: Logger;
}

export function createWebhookHandler(deps: WebhookDeps) {
  const { config, redactor, urlSanitizer, publisher, idempotency, logger } = deps;
  const authConfig: WebhookAuthConfig = {
    secret: config.webhookSecret,
    signatureHeader: config.signatureHeader,
  };

  return async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    if (event.httpMethod !== 'POST') return respond(405, 'method_not_allowed');

    const headers = normalizeHeaders(event.headers);
    if (!isJsonContentType(headers['content-type'])) return respond(415, 'unsupported_media_type');

    const rawBody = decodeBody(event);
    if (rawBody === null) return respond(400, 'invalid_body');
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) return respond(413, 'payload_too_large');

    // HMAC provisional sobre el cuerpo exacto, antes de parsearlo.
    const auth = verifyWebhookAuth(rawBody, headers, authConfig);
    if (!auth.ok) {
      logger.warn('webhook auth rejected', { reason: auth.reason });
      return respond(401, 'unauthorized');
    }

    const parsed = parseWebhookBody(rawBody, headers['x-webhook-event']);
    if (parsed.kind === 'invalid') {
      logger.warn('webhook payload invalid', { reason: parsed.reason });
      return respond(400, 'invalid_payload');
    }
    if (parsed.kind === 'ignorable') {
      logger.info('webhook payload ignored', { reason: parsed.reason });
      return respond(200, 'ignored');
    }

    const normalized = normalizeInbound(parsed.message, parsed.metadata, parsed.conversationId, {
      locale: config.locale,
    });
    if (countCodePoints(normalized.rawText) > config.messageMaxLength) {
      return respond(413, 'message_too_large');
    }
    const routingToken = normalized.conversationId;
    if (!isSafeRoutingToken(routingToken, normalized.rawPhone)) {
      // No se usa el telefono como destino ni como sustituto de conversationId.
      logger.warn('webhook message has no safe routing token', { messageId: normalized.messageId });
      return respond(200, 'ignored');
    }

    const userId = pseudonymizePhone(normalized.rawPhone, config.userIdHmacSecret);
    const enqueueClaim = await idempotency.acquireForEnqueue(normalized.messageId);
    if (enqueueClaim.kind === 'duplicate') return respond(200, 'duplicate');
    if (enqueueClaim.kind === 'busy') return respond(200, 'in_progress');

    try {
      const redaction = redactor.redact(normalized.rawText);
      const sanitized = sanitizeMessageUrlsForQueue(redaction.redactedText, urlSanitizer);
      if (countCodePoints(sanitized.redactedText) > config.messageMaxLength) {
        await idempotency.releaseEnqueue(normalized.messageId, enqueueClaim.leaseToken);
        return respond(413, 'message_too_large');
      }
      const analysisEvent: AnalysisRequestedEvent = {
        eventType: ANALYSIS_EVENT_TYPE,
        schemaVersion: ANALYSIS_EVENT_SCHEMA_VERSION,
        executionId: executionIdFor(normalized.messageId),
        messageId: normalized.messageId,
        userId,
        routingToken,
        redactedText: sanitized.redactedText,
        urlReferences: sanitized.urlReferences,
        receivedAt: normalized.receivedAt,
      };

      await publisher.publish(analysisEvent);
      await idempotency.markEnqueued(normalized.messageId, enqueueClaim.leaseToken);
      logger.info('analysis event enqueued', {
        userId,
        messageId: normalized.messageId,
        urlCount: sanitized.urlReferences.length,
        hadSensitiveData: redaction.hadSensitiveData,
      });
      return respond(200, 'accepted');
    } catch (error) {
      // Si SQS o la marca posterior fallan, liberar RECEIVED permite un reintento.
      try {
        await idempotency.releaseEnqueue(normalized.messageId, enqueueClaim.leaseToken);
      } catch {
        // La expiracion de la concesion evita que un fallo secundario bloquee el mensaje.
      }
      logger.error('webhook enqueue failed', {
        userId,
        messageId: normalized.messageId,
        error: errorMessage(error),
      });
      return respond(500, 'processing_error');
    }
  };
}

/**
 * Sustituye cada URL encontrada en el texto antes de SQS. Las URLs aptas se
 * reemplazan por reputationUrl; credenciales, queries peligrosas y destinos no
 * permitidos se convierten en [URL_REDACTED]. No abre conexiones de red.
 */
export function sanitizeMessageUrlsForQueue(
  redactedText: string,
  urlSanitizer: UrlSanitizer,
): { readonly redactedText: string; readonly urlReferences: readonly SafeUrlReference[] } {
  let queueText = redactedText;
  const references: SafeUrlReference[] = [];
  const seenUrls = new Set<string>();

  for (const candidate of extractUrls(redactedText)) {
    const sanitized = urlSanitizer.sanitize(candidate);
    const replacement = sanitized?.reputationUrl ?? '[URL_REDACTED]';
    queueText = queueText.replaceAll(candidate, replacement);
    if (sanitized !== null && !seenUrls.has(sanitized.reputationUrl)) {
      seenUrls.add(sanitized.reputationUrl);
      references.push({ referenceId: `url-${references.length}`, reputationUrl: sanitized.reputationUrl });
    }
  }

  return { redactedText: queueText, urlReferences: Object.freeze(references) };
}

/** Determinista y opaco: no incorpora texto ni telefono en el identificador. */
export function executionIdFor(messageId: string): string {
  return `exec-${createHash('sha256').update(messageId, 'utf8').digest('hex').slice(0, 32)}`;
}

let cached: ReturnType<typeof createWebhookHandler> | undefined;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (cached === undefined) {
    const resolver = new AwsSecretsResolver();
    const config = await loadWebhookConfig(process.env, resolver);
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }));
    cached = createWebhookHandler({
      config,
      logger: createLogger(),
      publisher: new QueuePublisher({ queueUrl: config.sqsQueueUrl, region: config.awsRegion }),
      idempotency: new DynamoIdempotencyStore({
        client: documentClient,
        tableName: config.idempotencyTableName,
      }),
      redactor: new FallbackRedactor(),
      urlSanitizer: new FallbackUrlSanitizer(),
    });
  }
  return cached(event);
}

function decodeBody(event: APIGatewayProxyEvent): string | null {
  if (typeof event.body !== 'string' || event.body.length === 0) return null;
  if (!event.isBase64Encoded) return event.body;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(event.body) || event.body.length % 4 !== 0) return null;
  try {
    return Buffer.from(event.body, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function normalizeHeaders(headers: APIGatewayProxyEvent['headers']): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/i.test(value);
}

function isSafeRoutingToken(value: string | undefined, rawPhone: string): value is string {
  if (value === undefined || !ROUTING_TOKEN_PATTERN.test(value)) return false;
  return value !== rawPhone && !/^\+?\d{7,15}$/.test(value);
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function respond(statusCode: number, status: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
