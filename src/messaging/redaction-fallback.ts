/**
 * Redactor local de demostracion. Se ejecuta antes de SQS; el redactor canonico
 * de AntiScamBot debe reemplazarlo al integrar el repositorio principal.
 */
import type { RedactionResult, Redactor } from '../ports/redaction';

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const RULES: readonly RedactionRule[] = [
  {
    pattern: /\b(?:contrasena|password|passwd|pass|clave(?:\s+de\s+acceso)?)\s*[:=]\s*\S+/gi,
    replacement: '[PASSWORD_REDACTED]',
  },
  {
    pattern: /\b(?:otp|codigo|c\u00f3digo|clave(?:\s+temporal)?|pin)\s*[:#]?\s*\d{4,8}\b/gi,
    replacement: '[OTP_REDACTED]',
  },
  { pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[CARD_REDACTED]' },
  { pattern: /\+?\d(?:[ ()-]?\d){8,14}\b/g, replacement: '[PHONE_REDACTED]' },
  { pattern: /\b\d{22}\b/g, replacement: '[ACCOUNT_REDACTED]' },
  { pattern: /\b\d{7,8}\b/g, replacement: '[DOC_REDACTED]' },
  // Conservador ante codigos aislados: preferible no filtrar a la cola.
  { pattern: /\b\d{4,8}\b/g, replacement: '[OTP_REDACTED]' },
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
