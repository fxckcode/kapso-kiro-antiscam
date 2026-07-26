/**
 * Puerto de redaccion determinista.
 *
 * La implementacion real vive (o vivira) en src/detection o src/domain, que NO
 * se editan desde este frente. La LambdaWebhook depende de esta interfaz; si el
 * modulo real no existe todavia, se usa el fallback local de
 * src/messaging/redaction-fallback.ts para no bloquear el desarrollo.
 *
 * Invariante (PRD §10): la redaccion ocurre en la LambdaWebhook, ANTES de SQS,
 * logs, modelo o persistencia. El contenido crudo nunca cruza este limite.
 */
export interface RedactionResult {
  /** Texto con datos sensibles sustituidos por marcadores (ej. "[OTP]"). */
  readonly redactedText: string;
  /** true si se detecto y sustituyo al menos un dato sensible. */
  readonly hadSensitiveData: boolean;
}

export interface Redactor {
  /** Redacta OTP, contrasenas, tarjetas, cuentas (CBU) y documentos. */
  redact(rawText: string): RedactionResult;
}
