/**
 * Puerto de consentimiento.
 *
 * Regla (PRD §6, UBIQUITOUS_LANGUAGE §5): sin consentimiento explicito el
 * contenido recibido se descarta; no se almacena, analiza ni encola. El usuario
 * otorga consentimiento respondiendo `ACEPTO`.
 *
 * La implementacion persistente (DynamoDB) la provee infra/domain. Aca solo el
 * contrato; el fallback local (src/messaging/consent-fallback.ts) es en memoria
 * y sirve para desarrollo y tests, no para produccion.
 */
export type ConsentStatus = 'pending' | 'accepted' | 'revoked';

export interface ConsentStore {
  /** Devuelve true si el usuario seudonimizado ya otorgo consentimiento. */
  hasConsent(userId: string): Promise<boolean>;
  /** Marca el consentimiento como otorgado (respuesta `ACEPTO`). */
  grantConsent(userId: string): Promise<void>;
  /** Marca el consentimiento como revocado (opt-out / eliminacion). */
  revokeConsent(userId: string): Promise<void>;
}

/*
 * Implementaciones:
 *  - InMemoryConsentStore (src/messaging/consent-fallback.ts): dev/tests.
 *  - DynamoConsentStore (src/messaging/dynamo-consent-store.ts): produccion,
 *    respaldado por DynamoDB con PK = userId hasheado y TTL (PRD §10).
 */
