/**
 * LambdaWebhook: punto de ingreso desde API Gateway (Kapso -> WhatsApp).
 *
 * Orquesta, en orden y con contenido crudo SOLO en memoria:
 *   1. Autenticar la firma del webhook       -> 401 si falla.
 *   2. Parsear el payload de forma defensiva  -> 400 si es invalido,
 *                                                200 si es valido no procesable.
 *   3. Normalizar el mensaje y seudonimizar al usuario.
 *   4. Consentimiento (PRD §6):
 *        - "ACEPTO"  -> otorgar consentimiento, pedir reenviar, 200.
 *        - sin consentimiento -> enviar onboarding, descartar contenido, 200.
 *   5. Con consentimiento: validar longitud, REDACTAR, extraer/sanitizar URLs
 *      del texto redactado, publicar el evento en SQS -> 200.
 *
 * Se prioriza responder 200 cuando el mensaje fue aceptado/encolado o no es
 * procesable, para evitar reintentos innecesarios de Kapso. Solo un fallo real
 * de encolado devuelve 500 (para que el reintento complete el enqueue).
 *
 * El contenido crudo nunca se loguea ni sale de esta funcion sin redactar.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { verifyWebhookAuth, type WebhookAuthConfig } from '../kapso/auth';
import { parseWebhookBody } from '../kapso/parser';
import { KapsoClient } from '../kapso/client';
import { extractUrls, normalizeInbound } from '../messaging/normalizer';
import { pseudonymizePhone } from '../messaging/pseudonymize';
import { FallbackRedactor } from '../messaging/redaction-fallback';
import { FallbackUrlSanitizer } from '../messaging/url-fallback';
import { InMemoryConsentStore } from '../messaging/consent-fallback';
import { DynamoConsentStore } from '../messaging/dynamo-consent-store';
import {
  DisabledRoutingTokenCipher,
  routingCipherFromEnv,
  type RoutingTokenCipher,
} from '../messaging/routing-token';
import type { WhatsAppSender } from '../messaging/types';
import type { Redactor } from '../ports/redaction';
import type { UrlSanitizer } from '../ports/url';
import type { ConsentStore } from '../ports/consent';
import { QueuePublisher } from '../queue/publisher';
import {
  ANALYSIS_EVENT_SCHEMA_VERSION,
  type AnalysisRequestedEvent,
  type UrlReference,
} from '../queue/events';
import { loadWebhookConfig, type WebhookConfig } from './shared/config';
import { AwsSecretsResolver } from './shared/secrets';
import { createLogger, type Logger } from './shared/logger';

const CONSENT_KEYWORD = 'ACEPTO';

const ONBOARDING_MESSAGE =
  'Hola, soy un asistente que te ayuda a detectar posibles estafas por WhatsApp. ' +
  'Reenviame un mensaje o enlace sospechoso y te doy una evaluacion orientativa. ' +
  'No guardo tu numero en claro ni tus datos sensibles. ' +
  'Para empezar, responde ACEPTO.';

const CONSENT_GRANTED_MESSAGE =
  'Gracias. Ahora reenviame el mensaje, texto o enlace sospechoso que quieras que analice.';

const TOO_LONG_MESSAGE =
  'El mensaje es demasiado largo para analizarlo. Enviame solo la parte sospechosa o el enlace.';

/** Dependencias inyectables (facilita tests y el cableado real de infra). */
export interface WebhookDeps {
  readonly config: WebhookConfig;
  readonly redactor: Redactor;
  readonly urlSanitizer: UrlSanitizer;
  readonly consent: ConsentStore;
  readonly publisher: Pick<QueuePublisher, 'publish'>;
  readonly sender: WhatsAppSender;
  readonly logger: Logger;
  /** Cipher opcional para el routing token. Default: desactivado. */
  readonly routingCipher?: RoutingTokenCipher;
}

export function createWebhookHandler(deps: WebhookDeps) {
  const { config, redactor, urlSanitizer, consent, publisher, sender, logger } = deps;
  const routingCipher = deps.routingCipher ?? new DisabledRoutingTokenCipher();

  const authConfig: WebhookAuthConfig = {
    secret: config.webhookSecret,
    signatureHeader: config.signatureHeader,
    ...(config.tokenHeader !== undefined ? { tokenHeader: config.tokenHeader } : {}),
  };

  return async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const rawBody = decodeBody(event);
    if (rawBody === null) {
      return respond(400, 'invalid_body');
    }

    // 1. Autenticacion sobre el cuerpo crudo exacto.
    const headers = normalizeHeaders(event.headers);
    const auth = verifyWebhookAuth(rawBody, headers, authConfig);
    if (!auth.ok) {
      logger.warn('webhook auth rejected', { reason: auth.reason });
      return respond(401, 'unauthorized');
    }

    // 2. Parseo defensivo (autodetecta formato Kapso nativo vs Meta).
    const parsed = parseWebhookBody(rawBody, headers['x-webhook-event']);
    if (parsed.kind === 'invalid') {
      logger.warn('webhook payload invalid', { reason: parsed.reason });
      return respond(400, 'invalid_payload');
    }
    if (parsed.kind === 'ignorable') {
      logger.info('webhook payload ignorable', { reason: parsed.reason });
      return respond(200, 'ignored');
    }

    // 3. Normalizar + seudonimizar.
    const normalized = normalizeInbound(
      parsed.message,
      parsed.metadata,
      parsed.conversationId,
      { locale: config.locale },
    );
    const userId = pseudonymizePhone(normalized.rawPhone, config.userIdHmacSecret);

    try {
      // 4. Consentimiento.
      if (isConsentKeyword(normalized.rawText)) {
        await consent.grantConsent(userId);
        await sender.sendText(normalized.rawPhone, CONSENT_GRANTED_MESSAGE);
        logger.info('consent granted', { userId });
        return respond(200, 'consent_granted');
      }

      if (!(await consent.hasConsent(userId))) {
        await sender.sendText(normalized.rawPhone, ONBOARDING_MESSAGE);
        logger.info('onboarding sent, content discarded', { userId });
        return respond(200, 'onboarding_sent');
      }

      // 5. Validacion de longitud.
      if (normalized.rawText.length > config.messageMaxLength) {
        await sender.sendText(normalized.rawPhone, TOO_LONG_MESSAGE);
        logger.info('message too long, discarded', { userId, messageId: normalized.messageId });
        return respond(200, 'too_long');
      }

      // Redaccion determinista ANTES de cualquier salida.
      const { redactedText, hadSensitiveData } = redactor.redact(normalized.rawText);

      // URLs se extraen del texto YA redactado y se sanitizan (allowlist).
      const urlReferences = buildUrlReferences(redactedText, urlSanitizer);

      // Routing token cifrado (opcional). Si esta habilitado, cifra el telefono
      // con KMS para que el processor pueda responder sin exponerlo en claro.
      const encryptedRoutingToken = routingCipher.enabled
        ? await routingCipher.encrypt(normalized.rawPhone)
        : undefined;

      const analysisEvent: AnalysisRequestedEvent = {
        schemaVersion: ANALYSIS_EVENT_SCHEMA_VERSION,
        messageId: normalized.messageId,
        userId,
        provider: 'kapso',
        channel: 'whatsapp',
        receivedAt: normalized.receivedAt,
        message: {
          type: normalized.type,
          locale: normalized.locale,
          redactedText,
          urlReferences,
          media: normalized.media,
        },
        meta: {
          ...(normalized.conversationId !== undefined
            ? { kapsoConversationId: normalized.conversationId }
            : {}),
          hadSensitiveData,
        },
        ...(encryptedRoutingToken !== undefined ? { encryptedRoutingToken } : {}),
      };

      await publisher.publish(analysisEvent);
      logger.info('analysis event enqueued', {
        userId,
        messageId: normalized.messageId,
        contentType: normalized.type,
        urlCount: urlReferences.length,
        hadSensitiveData,
      });
      return respond(200, 'accepted');
    } catch (err) {
      // Fallo real (envio/encolado): 500 para que el reintento complete el enqueue.
      logger.error('webhook processing failed', {
        userId,
        messageId: normalized.messageId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return respond(500, 'processing_error');
    }
  };
}

/** Handler por defecto: cablea fallbacks locales. Infra puede reemplazar deps. */
let cached: ReturnType<typeof createWebhookHandler> | undefined;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (cached === undefined) {
    const resolver = new AwsSecretsResolver();
    const config = await loadWebhookConfig(process.env, resolver);
    const logger = createLogger();
    const publisher = new QueuePublisher({ queueUrl: config.sqsQueueUrl, region: config.awsRegion });
    const sender = new KapsoClient({
      baseUrl: requiredEnv('KAPSO_API_BASE_URL'),
      apiKey: await resolver.resolve('KAPSO_API_KEY'),
      ...(process.env['KAPSO_PHONE_NUMBER_ID'] !== undefined
        ? { phoneNumberId: process.env['KAPSO_PHONE_NUMBER_ID'] }
        : {}),
    });
    cached = createWebhookHandler({
      config,
      logger,
      publisher,
      sender,
      redactor: new FallbackRedactor(),
      urlSanitizer: new FallbackUrlSanitizer(),
      consent: buildConsentStore(config.awsRegion),
      routingCipher: routingCipherFromEnv(),
    });
  }
  return cached(event);
}

/* --------------------------------- helpers --------------------------------- */

function buildUrlReferences(redactedText: string, sanitizer: UrlSanitizer): readonly UrlReference[] {
  const candidates = extractUrls(redactedText);
  const refs: UrlReference[] = [];
  let index = 0;
  for (const candidate of candidates) {
    const sanitized = sanitizer.sanitize(candidate);
    if (sanitized !== null) {
      refs.push({
        referenceId: `url-${index}`,
        sanitizedUrl: sanitized.sanitizedUrl,
        domain: sanitized.domain,
      });
      index += 1;
    }
  }
  return refs;
}

function isConsentKeyword(text: string): boolean {
  return text.trim().toUpperCase() === CONSENT_KEYWORD;
}

function decodeBody(event: APIGatewayProxyEvent): string | null {
  if (typeof event.body !== 'string' || event.body.length === 0) {
    return null;
  }
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return event.body;
}

function normalizeHeaders(headers: APIGatewayProxyEvent['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (headers) {
    for (const key of Object.keys(headers)) {
      out[key.toLowerCase()] = headers[key];
    }
  }
  return out;
}

function respond(statusCode: number, status: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Consent store real (DynamoDB) si CONSENT_TABLE_NAME esta definido; si no, el
 * fallback en memoria (dev/local). El TTL se controla con CONSENT_TTL_DAYS.
 */
function buildConsentStore(region: string): ConsentStore {
  const tableName = process.env['CONSENT_TABLE_NAME'];
  if (tableName === undefined || tableName.length === 0) {
    return new InMemoryConsentStore();
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const ttlDays = Number.parseInt(process.env['CONSENT_TTL_DAYS'] ?? '', 10);
  return new DynamoConsentStore({
    client: doc,
    tableName,
    ...(Number.isFinite(ttlDays) && ttlDays > 0 ? { ttlDays } : {}),
  });
}
