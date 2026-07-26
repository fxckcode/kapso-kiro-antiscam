/**
 * Carga y validacion de variables de entorno.
 *
 * Separa configuracion NO sensible (se lee directo de env) de los SECRETOS, que
 * se resuelven de forma asincrona mediante un `SecretsResolver` (ver
 * ./secrets.ts). En produccion infra pasa los ARNs (`<NOMBRE>_ARN`); en
 * local/tests se puede pasar el valor directo (`<NOMBRE>`).
 *
 * Falla temprano si falta algo esencial, para no descubrirlo a mitad de una
 * invocacion.
 */
import { AwsSecretsResolver, type SecretsResolver } from './secrets';

export interface WebhookConfig {
  readonly awsRegion: string;
  readonly sqsQueueUrl: string;
  readonly idempotencyTableName: string;
  /** Secreto para validar la firma del webhook. */
  readonly webhookSecret: string;
  readonly signatureHeader: string;
  readonly tokenHeader: string | undefined;
  /** Secreto HMAC para seudonimizar el telefono. */
  readonly userIdHmacSecret: string;
  readonly messageMaxLength: number;
  readonly locale: string;
}

export interface ProcessorConfig {
  readonly awsRegion: string;
  readonly kapsoApiBaseUrl: string;
  readonly idempotencyTableName: string;
  /** API key para responder por Kapso. */
  readonly kapsoApiKey: string;
  readonly kapsoPhoneNumberId: string | undefined;
}

const DEFAULT_MESSAGE_MAX_LENGTH = 4096;
// Kapso firma los webhooks (kind "kapso") en el header x-webhook-signature.
const DEFAULT_SIGNATURE_HEADER = 'x-webhook-signature';
const DEFAULT_LOCALE = 'es';

export async function loadWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
  resolver: SecretsResolver = new AwsSecretsResolver({ env }),
): Promise<WebhookConfig> {
  const [webhookSecret, userIdHmacSecret] = await Promise.all([
    resolver.resolve('KAPSO_WEBHOOK_SECRET'),
    resolver.resolve('USER_ID_HMAC_SECRET'),
  ]);

  return {
    awsRegion: required(env, 'AWS_REGION'),
    sqsQueueUrl: required(env, 'SQS_QUEUE_URL'),
    idempotencyTableName: required(env, 'IDEMPOTENCY_TABLE_NAME'),
    webhookSecret,
    signatureHeader: env['KAPSO_SIGNATURE_HEADER'] ?? DEFAULT_SIGNATURE_HEADER,
    tokenHeader: env['KAPSO_TOKEN_HEADER'],
    userIdHmacSecret,
    messageMaxLength: intOr(env['MESSAGE_MAX_LENGTH'], DEFAULT_MESSAGE_MAX_LENGTH),
    locale: env['DEFAULT_LOCALE'] ?? DEFAULT_LOCALE,
  };
}

export async function loadProcessorConfig(
  env: NodeJS.ProcessEnv = process.env,
  resolver: SecretsResolver = new AwsSecretsResolver({ env }),
): Promise<ProcessorConfig> {
  const kapsoApiKey = await resolver.resolve('KAPSO_API_KEY');

  return {
    awsRegion: required(env, 'AWS_REGION'),
    kapsoApiBaseUrl: required(env, 'KAPSO_API_BASE_URL'),
    idempotencyTableName: required(env, 'IDEMPOTENCY_TABLE_NAME'),
    kapsoApiKey,
    kapsoPhoneNumberId: env['KAPSO_PHONE_NUMBER_ID'],
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
