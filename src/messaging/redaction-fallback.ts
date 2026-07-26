/**
 * Fallback local del puerto Redactor.
 *
 * Se usa SOLO si src/detection o src/domain aun no exponen un redactor real.
 * Cubre los casos mas comunes de LATAM de forma conservadora. La
 * implementacion definitiva (mas completa y auditada) vive fuera de este frente.
 *
 * Ante la duda, redacta de mas: es preferible perder contexto a filtrar un dato
 * sensible hacia SQS/logs/modelo.
 */
import type { Redactor, RedactionResult } from '../ports/redaction';

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const RULES: readonly RedactionRule[] = [
  // OTP / codigo de verificacion: 4 a 8 digitos, opcionalmente etiquetado.
  { pattern: /\b(?:otp|codigo|c[oó]digo|clave|pin)\s*[:#]?\s*\d{4,8}\b/gi, replacement: '[OTP]' },
  // Tarjeta: 13-19 digitos, con o sin separadores.
  { pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[TARJETA]' },
  // CBU argentino: 22 digitos.
  { pattern: /\b\d{22}\b/g, replacement: '[CBU]' },
  // CVU / alias con puntos suele ser texto; DNI: 7-8 digitos aislados.
  { pattern: /\b\d{7,8}\b/g, replacement: '[DOCUMENTO]' },
  // Secuencia de 4-8 digitos sueltos restante -> posible OTP no etiquetado.
  { pattern: /\b\d{4,8}\b/g, replacement: '[OTP]' },
];

export class FallbackRedactor implements Redactor {
  redact(rawText: string): RedactionResult {
    let redactedText = rawText;
    let hadSensitiveData = false;

    for (const rule of RULES) {
      redactedText = redactedText.replace(rule.pattern, () => {
        hadSensitiveData = true;
        return rule.replacement;
      });
    }

    return { redactedText, hadSensitiveData };
  }
}
