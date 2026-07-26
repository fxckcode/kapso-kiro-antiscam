/**
 * Redaccion determinista de datos sensibles. Se ejecuta como codigo (no modelo)
 * en LambdaWebhook, ANTES de SQS, logs, modelo, cache y persistencia. Es la
 * unica barrera que garantiza que OTP, contrasenas, tarjetas, cuentas y
 * documentos no sobrevivan al pipeline.
 *
 * Diseno: privacidad primero, pero SIN falsos positivos ruidosos. Los OTP se
 * redactan SOLO por contexto (no cualquier numero de 4-8 digitos); las tarjetas
 * se validan por longitud y algoritmo de Luhn. (Hallazgo ASB-04.)
 *
 * Ver PRD.md sec. 6/10 y UBIQUITOUS_LANGUAGE.md sec. 2/7.
 */

/**
 * Marca de tipo opaca para texto ya redactado. NO existe un constructor publico
 * que marque un string arbitrario: el unico productor legitimo es `redact()`.
 *
 * La marca evita errores ACCIDENTALES (pasar contenido crudo donde se espera
 * texto redactado). No es una garantia de seguridad ante un `as` deliberado; la
 * seguridad real depende de que el webhook llame al redactor. (Hallazgo ASB-03.)
 */
declare const redactedTextBrand: unique symbol;
export type RedactedText = string & {
  readonly [redactedTextBrand]: true;
};

export const REDACTION_CATEGORIES = [
  "account", // IBAN, CLABE, cuentas bancarias
  "document", // CURP, RFC, DNI y similares
  "password", // contrasenas contextuales
  "card", // tarjetas de credito/debito (validadas con Luhn)
  "otp", // codigos de verificacion / OTP / PIN (solo contextual)
] as const;

export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

export const REDACTION_PLACEHOLDERS: Record<RedactionCategory, string> = {
  account: "[ACCOUNT_REDACTED]",
  document: "[DOC_REDACTED]",
  password: "[PASSWORD_REDACTED]",
  card: "[CARD_REDACTED]",
  otp: "[OTP_REDACTED]",
};

/** Conjunto de marcadores para reconocer texto ya redactado. */
const PLACEHOLDER_VALUES: readonly string[] = Object.values(REDACTION_PLACEHOLDERS);

export interface RedactionResult {
  readonly text: RedactedText;
  readonly redactionCount: number;
}

/**
 * Algoritmo de Luhn: reduce falsos positivos de tarjetas. Recibe solo digitos.
 */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface Rule {
  readonly category: RedactionCategory;
  readonly pattern: RegExp;
  /**
   * Reglas contextuales: grupo 1 = palabra clave a conservar; grupo 2 = valor
   * sensible a redactar (ej. "codigo: [OTP_REDACTED]"). Las reglas sin
   * `contextual` sustituyen la coincidencia completa.
   */
  readonly contextual?: boolean;
  /**
   * Predicado opcional sobre el texto coincidente para reglas no contextuales.
   * Si devuelve false, la coincidencia se conserva sin redactar.
   */
  readonly accept?: (match: string) => boolean;
}

/**
 * Orden IMPORTANTE: patrones mas especificos / mas largos primero.
 */
const RULES: readonly Rule[] = [
  // IBAN: 2 letras pais + 2 digitos control + 10-30 alfanumericos.
  { category: "account", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/gi },

  // Documentos con letras: CURP, RFC, DNI espanol.
  { category: "document", pattern: /\b[A-Z]{4}\d{6}[A-Z0-9]{8}\b/gi }, // CURP
  { category: "document", pattern: /\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b/gi }, // RFC
  { category: "document", pattern: /\b\d{8}[A-Z]\b/gi }, // DNI

  // Contrasenas contextuales: preserva la palabra clave, redacta el valor.
  // Requiere un separador `:`/`=` (con espacios opcionales) para no capturar la
  // palabra siguiente en frases como "clave temporal 12345678".
  {
    category: "password",
    pattern:
      /((?:contrase[nñ]a|password|passwd|clave(?:\s+de\s+acceso)?|pass)\s*[:=]\s*)(\S+)/gi,
    contextual: true,
  },

  // Tarjetas: 4 grupos de 4 (con espacios/guiones), validadas con Luhn.
  {
    category: "card",
    pattern: /\b\d{4}(?:[ -]\d{4}){2,4}\b/g,
    accept: (m) => passesLuhn(m.replace(/[ -]/g, "")),
  },
  // Tarjetas: 13-19 digitos seguidos, validadas con Luhn.
  {
    category: "card",
    pattern: /\b\d{13,19}\b/g,
    accept: (m) => passesLuhn(m),
  },

  // Cuentas / CLABE (18 digitos) y numeros de cuenta de 10-18 digitos.
  { category: "account", pattern: /\b\d{10,18}\b/g },

  // OTP contextual: preserva la palabra clave (incl. "clave temporal"),
  // redacta el codigo de 4-8 digitos. NO se redactan numeros sueltos.
  {
    category: "otp",
    pattern:
      /((?:otp|c[oó]digo(?:\s+de\s+verificaci[oó]n)?|clave\s+temporal|token|pin)\D{0,10}?)(\d{4,8})\b/gi,
    contextual: true,
  },
];

/**
 * Divide el texto en segmentos que son marcadores `[..._REDACTED]` (intactos) o
 * texto normal (redactable). Garantiza idempotencia: los marcadores nunca se
 * vuelven a tocar. (Hallazgo ASB-04.)
 */
const PLACEHOLDER_SPLIT = /(\[[A-Z]+_REDACTED\])/g;

/**
 * Aplica la redaccion determinista. Idempotente: `redact(redact(x)) === redact(x)`.
 * Devuelve un `RedactedText` de marca; es el unico productor legitimo del tipo.
 */
export function redact(input: string): RedactionResult {
  let redactionCount = 0;

  const segments = input.split(PLACEHOLDER_SPLIT);
  const out = segments.map((segment) => {
    // Segmentos que ya son un marcador se conservan intactos.
    if (PLACEHOLDER_VALUES.includes(segment)) return segment;

    let text = segment;
    for (const rule of RULES) {
      const placeholder = REDACTION_PLACEHOLDERS[rule.category];
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, (match, ...groups) => {
        if (!rule.contextual && rule.accept && !rule.accept(match)) {
          return match; // no cumple validacion (ej. Luhn): conservar
        }
        redactionCount += 1;
        if (rule.contextual) {
          const keyword = groups[0] as string;
          return `${keyword}${placeholder}`;
        }
        return placeholder;
      });
    }
    return text;
  });

  return { text: out.join("") as RedactedText, redactionCount };
}
