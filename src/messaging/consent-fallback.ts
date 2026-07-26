/**
 * Fallback local del puerto ConsentStore.
 *
 * EN MEMORIA: pierde el estado al reciclarse la Lambda. Sirve para desarrollo y
 * tests. En produccion infra debe inyectar una implementacion respaldada por
 * DynamoDB. No cumple la persistencia real de consentimiento por si solo.
 */
import type { ConsentStore } from '../ports/consent';

export class InMemoryConsentStore implements ConsentStore {
  private readonly granted = new Set<string>();

  async hasConsent(userId: string): Promise<boolean> {
    return this.granted.has(userId);
  }

  async grantConsent(userId: string): Promise<void> {
    this.granted.add(userId);
  }

  async revokeConsent(userId: string): Promise<void> {
    this.granted.delete(userId);
  }
}
