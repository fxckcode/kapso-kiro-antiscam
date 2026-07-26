/**
 * Routing token cifrado (feature OPCIONAL, desactivada por defecto).
 *
 * Contexto (PRD §13): el evento SQS no lleva el telefono en claro. Por defecto
 * la respuesta se enruta con `kapsoConversationId`. Si se confirma que Kapso
 * exige el numero destino, se habilita esta feature (ENABLE_ROUTING_TOKEN=true)
 * para transportar el destino cifrado con KMS y descifrarlo solo en el processor.
 *
 * NUNCA se persiste ni loguea el telefono en claro: solo el ciphertext (base64).
 */
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

export interface RoutingTokenCipher {
  /** Indica si el cifrado esta habilitado y configurado. */
  readonly enabled: boolean;
  /** Cifra un valor de enrutado (ej. telefono). Devuelve base64. */
  encrypt(plaintext: string): Promise<string>;
  /** Descifra un token base64 y devuelve el valor original. */
  decrypt(ciphertextB64: string): Promise<string>;
}

/** Implementacion desactivada: cualquier uso lanza. `enabled = false`. */
export class DisabledRoutingTokenCipher implements RoutingTokenCipher {
  readonly enabled = false;

  async encrypt(_plaintext: string): Promise<string> {
    throw new Error('Routing token cipher is disabled (ENABLE_ROUTING_TOKEN=false)');
  }

  async decrypt(_ciphertextB64: string): Promise<string> {
    throw new Error('Routing token cipher is disabled (ENABLE_ROUTING_TOKEN=false)');
  }
}

export interface KmsRoutingTokenCipherOptions {
  readonly keyId: string;
  readonly client?: KMSClient;
  readonly region?: string;
}

/** Implementacion con AWS KMS (Encrypt/Decrypt simetrico). */
export class KmsRoutingTokenCipher implements RoutingTokenCipher {
  readonly enabled = true;
  private readonly keyId: string;
  private clientInstance: KMSClient | undefined;
  private readonly region: string | undefined;

  constructor(options: KmsRoutingTokenCipherOptions) {
    this.keyId = options.keyId;
    this.clientInstance = options.client;
    this.region = options.region;
  }

  async encrypt(plaintext: string): Promise<string> {
    const result = await this.client().send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: Buffer.from(plaintext, 'utf8') }),
    );
    if (result.CiphertextBlob === undefined) {
      throw new Error('KMS did not return a ciphertext');
    }
    return Buffer.from(result.CiphertextBlob).toString('base64');
  }

  async decrypt(ciphertextB64: string): Promise<string> {
    const result = await this.client().send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(ciphertextB64, 'base64'),
      }),
    );
    if (result.Plaintext === undefined) {
      throw new Error('KMS did not return a plaintext');
    }
    return Buffer.from(result.Plaintext).toString('utf8');
  }

  private client(): KMSClient {
    if (this.clientInstance === undefined) {
      this.clientInstance = new KMSClient(this.region ? { region: this.region } : {});
    }
    return this.clientInstance;
  }
}

/**
 * Construye el cipher desde el entorno.
 * Habilitado solo si ENABLE_ROUTING_TOKEN=true y hay ROUTING_TOKEN_KMS_KEY_ID.
 */
export function routingCipherFromEnv(env: NodeJS.ProcessEnv = process.env): RoutingTokenCipher {
  const enabled = env['ENABLE_ROUTING_TOKEN'] === 'true';
  const keyId = env['ROUTING_TOKEN_KMS_KEY_ID'];
  if (enabled && keyId !== undefined && keyId.length > 0) {
    return new KmsRoutingTokenCipher({ keyId });
  }
  return new DisabledRoutingTokenCipher();
}
