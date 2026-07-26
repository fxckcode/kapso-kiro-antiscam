/**
 * Resolutor de secretos.
 *
 * Los handlers necesitan valores de secretos (secreto del webhook, secreto HMAC,
 * API key de Kapso). En produccion, infra (CDK) pasa el ARN del secreto en una
 * env var `<NOMBRE>_ARN` y otorga lectura de Secrets Manager. En local/tests se
 * puede pasar el valor directo en `<NOMBRE>`.
 *
 * Estrategia de resolucion para un nombre logico `NAME`:
 *   1. Si `env[NAME]` tiene valor -> se usa tal cual (dev/test/local).
 *   2. Si no, si `env[NAME_ARN]` existe -> GetSecretValue en Secrets Manager.
 *   3. Si no hay ninguno -> error.
 *
 * Cachea en memoria por ARN durante la vida del contenedor (cold start paga una
 * sola vez). Nunca loguea el valor del secreto.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export interface SecretsResolver {
  /** Resuelve el valor del secreto para un nombre logico (ej. "KAPSO_API_KEY"). */
  resolve(name: string): Promise<string>;
}

export interface AwsSecretsResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: SecretsManagerClient;
  readonly region?: string;
}

export class AwsSecretsResolver implements SecretsResolver {
  private readonly env: NodeJS.ProcessEnv;
  private clientInstance: SecretsManagerClient | undefined;
  private readonly region: string | undefined;
  /** Cache por SecretId (ARN) para no repetir el fetch. */
  private readonly cache = new Map<string, string>();

  constructor(options: AwsSecretsResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.clientInstance = options.client;
    this.region = options.region;
  }

  async resolve(name: string): Promise<string> {
    // 1. Valor directo en env (dev/test/local).
    const direct = this.env[name];
    if (direct !== undefined && direct.trim().length > 0) {
      return direct;
    }

    // 2. ARN -> Secrets Manager.
    const arn = this.env[`${name}_ARN`];
    if (arn !== undefined && arn.trim().length > 0) {
      return this.fetchFromSecretsManager(arn);
    }

    // 3. Nada disponible.
    throw new Error(`Missing secret: set ${name} or ${name}_ARN`);
  }

  private async fetchFromSecretsManager(secretId: string): Promise<string> {
    const cached = this.cache.get(secretId);
    if (cached !== undefined) {
      return cached;
    }

    const response = await this.client().send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = response.SecretString;
    if (value === undefined || value.length === 0) {
      throw new Error('Secret has no string value (binary secrets are not supported)');
    }

    this.cache.set(secretId, value);
    return value;
  }

  private client(): SecretsManagerClient {
    if (this.clientInstance === undefined) {
      this.clientInstance = new SecretsManagerClient(this.region ? { region: this.region } : {});
    }
    return this.clientInstance;
  }
}
