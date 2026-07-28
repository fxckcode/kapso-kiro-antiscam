import { signalSchema } from "../domain/signal.js";
import type { Signal } from "../domain/signal.js";
import type { RedactedText } from "../domain/redaction.js";

/**
 * Reglas deterministas de deteccion. Reciben UNICAMENTE contenido ya redactado
 * (`RedactedText`; PR04-10 prohibe `string` crudo) y producen `Signal[]`.
 *
 * INVARIANTES (prompt maestro sec. 3; UBIQUITOUS_LANGUAGE.md sec. 3/7):
 *  - una regla NUNCA devuelve un veredicto;
 *  - una regla NUNCA invoca VirusTotal ni hace I/O;
 *  - una regla NUNCA declara por si sola una estafa (peso acotado, < banda scam);
 *  - no muta el mensaje (solo lectura);
 *  - es determinista (regex puras sobre el texto).
 *
 * Diseno contextual: se evita que una palabra comun (p. ej. "transferencia")
 * genere una senal por si sola; las reglas de pago, premio, suplantacion y
 * familiar exigen contexto adicional. Los relatos en pasado o de terceros
 * ("hice una transferencia ayer", "mi familiar esta en el hospital") no deben
 * producir senales graves: por eso se exige una SOLICITUD dirigida al usuario.
 */

/** Verbos de solicitud usados por varias reglas contextuales. */
const REQUEST_VERB =
  /(comparte|env[ií]a(?:me)?|d[ií]me|dame|proporciona|ingresa|confirma|reenv[ií]a|pasa(?:me)?|manda(?:me)?)/;

/** Marcadores de urgencia artificial. */
const URGENCY =
  /(urgente|inmediat|ahora\s+mismo|de\s+inmediato|cuanto\s+antes|en\s+los\s+pr[oó]ximos?\s+\d+\s*(?:min|minutos|horas)|antes\s+de\s+que|expira|vence\s+hoy|[uú]ltimo\s+aviso|responde\s+ya)/;

/**
 * Una regla determinista. `matches` es una funcion pura sobre el texto en
 * minusculas; no recibe ni conserva estado.
 */
export interface DetectionRule {
  readonly type: string;
  readonly description: string;
  readonly weight: number;
  readonly matches: (lowerText: string) => boolean;
}

/**
 * Extrae los hosts (en minusculas) de las URLs http/https presentes en el
 * texto. Solo para reglas basadas en dominio; no valida ni normaliza a fondo.
 */
function hostsIn(lowerText: string): string[] {
  const hosts: string[] = [];
  const re = /https?:\/\/([^/\s:?#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lowerText)) !== null) {
    const host = m[1];
    if (host) hosts.push(host);
  }
  return hosts;
}

/** Dominios acortadores conocidos. */
const SHORTENERS =
  /\b(?:bit\.ly|goo\.gl|t\.co|tinyurl\.com|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|shorturl\.at|acortar\.link)\b/;

/**
 * Marcas conocidas y sus dominios registrables oficiales. Lista deliberadamente
 * pequena y documentada: la deteccion de dominios similares es una heuristica y
 * se mantiene conservadora para no producir falsos positivos ruidosos.
 */
const BRANDS: Readonly<Record<string, readonly string[]>> = {
  paypal: ["paypal.com", "paypal.com.mx"],
  bbva: ["bbva.mx", "bbva.com"],
  banamex: ["banamex.com", "banamex.com.mx"],
  santander: ["santander.com.mx", "santander.com"],
  banorte: ["banorte.com"],
  mercadolibre: ["mercadolibre.com.mx", "mercadolibre.com"],
  mercadopago: ["mercadopago.com.mx", "mercadopago.com"],
  amazon: ["amazon.com", "amazon.com.mx"],
  netflix: ["netflix.com"],
  correos: ["correosdemexico.gob.mx"],
  sat: ["sat.gob.mx"],
};

/**
 * Dominio registrable aproximado: ultimas 2 etiquetas, o 3 cuando el TLD es un
 * ccTLD de 2 letras precedido por un dominio de segundo nivel comun
 * (com/net/org/gob/edu). Es una aproximacion sin lista de sufijos publicos.
 */
function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last = labels[labels.length - 1] ?? "";
  const secondLast = labels[labels.length - 2] ?? "";
  const commonSld = new Set(["com", "net", "org", "gob", "edu"]);
  if (last.length === 2 && commonSld.has(secondLast)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/** Normaliza leetspeak: reemplaza digitos y simbolos por letras. */
function normalizeLeet(text: string): string {
  return text
    .replace(/0/g, 'o').replace(/1/g, 'l').replace(/2/g, 'z')
    .replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/6/g, 'g').replace(/7/g, 't').replace(/8/g, 'b')
    .replace(/9/g, 'g');
}

/**
 * Detecta un host que menciona una marca conocida como etiqueta (separada por
 * `.` o `-`) pero cuyo dominio registrable NO es el oficial de esa marca.
 * Soporta leetspeak: "paypa1" → "paypal".
 */
function looksLikeBrandLookalike(hosts: readonly string[]): boolean {
  for (const host of hosts) {
    const registrable = registrableDomain(host);
    const tokens = new Set(host.split(/[.-]/).filter(Boolean));
    // Normalizar tokens para detectar leetspeak
    const normalizedTokens = new Set([...tokens].map(normalizeLeet));
    for (const [brand, official] of Object.entries(BRANDS)) {
      if ((tokens.has(brand) || normalizedTokens.has(brand)) && !official.includes(registrable)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Catalogo de reglas. Los pesos son moderados y acotados: ninguna regla por si
 * sola alcanza la banda `scam` (>= 80); el backend combina las senales.
 */
export const DEFAULT_RULES: readonly DetectionRule[] = [
  {
    type: "otp_request",
    description: "Solicita compartir un codigo de verificacion (OTP/PIN/token).",
    weight: 35,
    matches: (t) =>
      REQUEST_VERB.test(t) &&
      /(otp|c[oó]digo(?:\s+de\s+verificaci[oó]n)?|clave\s+temporal|token|\bpin\b|\[otp_redacted\])/.test(
        t,
      ),
  },
  {
    type: "credential_request",
    description: "Solicita credenciales o datos de acceso a una cuenta.",
    weight: 35,
    matches: (t) =>
      /(contrase[nñ]a|password|clave\s+de\s+acceso|credenciales|datos\s+de\s+tu\s+cuenta|\bnip\b|usuario\s+y\s+contrase|\[password_redacted\])/.test(
        t,
      ) && (REQUEST_VERB.test(t) || /(verifica|actualiza|inicia\s+sesi[oó]n|valida)/.test(t)),
  },
  {
    type: "artificial_urgency",
    description: "Genera urgencia artificial para forzar una accion rapida.",
    weight: 20,
    matches: (t) => URGENCY.test(t),
  },
  {
    type: "immediate_payment_transfer",
    description: "Pide una transferencia o pago inmediato, con contexto de destino o urgencia.",
    weight: 25,
    matches: (t) =>
      /(transferencia|transfiere|dep[oó]sito|deposita|\bpaga\b|\bpago\b|env[ií]a\s+dinero|abona|\bclabe\b|\bspei\b)/.test(
        t,
      ) &&
      (URGENCY.test(t) ||
        /(a\s+esta\s+cuenta|a\s+la\s+cuenta|\bclabe\b|n[uú]mero\s+de\s+cuenta|\[account_redacted\]|\$\s*\d|\d+\s*(?:pesos|mxn|usd|d[oó]lares))/.test(
          t,
        )),
  },
  {
    type: "fake_prize",
    description: "Anuncia un premio o sorteo no solicitado y pide una accion para reclamarlo.",
    weight: 25,
    matches: (t) =>
      /(felicidades|ganaste|has\s+ganado|premio|sorteo|has\s+sido\s+seleccionad|eres\s+el\s+ganador)/.test(
        t,
      ) &&
      /(reclama|recibir|cobrar|haz\s+clic|ingresa|deposita|paga|para\s+recibir)/.test(t),
  },
  {
    type: "relative_in_trouble",
    description: "Se hace pasar por un familiar en apuros que pide dinero o ayuda.",
    weight: 30,
    matches: (t) =>
      /(soy\s+tu\s+(?:hij[oa]|prim[oa]|herman[oa]|familiar)|cambi[eé]\s+de\s+n[uú]mero|es\s+una\s+emergencia)/.test(
        t,
      ) &&
      /(dinero|dep[oó]sito|transfer|prestar|urgente|emergencia|ayuda|saldo|recarga)/.test(t),
  },
  {
    type: "guaranteed_earnings",
    description: "Promete ganancias garantizadas o inversion sin riesgo.",
    weight: 25,
    matches: (t) =>
      /(ganancias?\s+garantizad|rendimiento\s+(?:asegurad|garantizad)|sin\s+riesgo|duplica\s+tu\s+(?:dinero|inversi[oó]n)|multiplica\s+tu\s+(?:dinero|capital)|retorno\s+garantizad|inversi[oó]n\s+segura)/.test(
        t,
      ),
  },
  {
    type: "impersonation",
    description: "Suplanta a una entidad oficial y exige verificar o desbloquear la cuenta.",
    weight: 30,
    matches: (t) =>
      /(banco|bbva|banamex|santander|banorte|\bsat\b|imss|cfe|paypal|mercado\s*pago|departamento\s+de\s+seguridad|equipo\s+de\s+seguridad|servicio\s+al\s+cliente|soporte\s+oficial)/.test(
        t,
      ) &&
      /(cuenta\s+ser[aá]\s+(?:bloquead|suspendid)|suspendid|bloquead|verifica\s+tu\s+cuenta|actualiza\s+tus\s+datos|detectamos\s+(?:un\s+)?(?:acceso|movimiento))/.test(
        t,
      ),
  },
  {
    type: "shortened_link",
    description: "Contiene un enlace acortado que oculta el destino real.",
    weight: 20,
    matches: (t) => SHORTENERS.test(t),
  },
  {
    type: "lookalike_domain",
    description: "Contiene un dominio que imita a una marca conocida (heuristica conservadora).",
    weight: 30,
    matches: (t) => looksLikeBrandLookalike(hostsIn(t)),
  },
  {
    type: "nonsense_domain",
    description:
      "El dominio contiene subcadenas sin sentido: caracteres repetidos o secuencias largas sin vocales.",
    weight: 20,
    matches: (t) => {
      const REPEATED_CHARS = /([a-z])\1{3,}/;
      const CONSONANT_RUN = /[bcdfghjklmnpqrstvwxyz]{8,}/;
      return hostsIn(t).some(
        (host) => REPEATED_CHARS.test(host) || CONSONANT_RUN.test(host),
      );
    },
  },
  {
    type: "tracking_url",
    description:
      "Contiene un enlace con parámetros de rastreo excesivos que pueden ocultar el propósito real.",
    weight: 15,
    matches: (t) => {
      const TRACKING_PARAMS = /(utm_source|utm_medium|utm_campaign|utm_term|utm_content|gclid|fbclid|qclid|qad_source)/;
      const MAX_TRACKING = 2;
      const urls = t.match(/https?:\/\/[^\s]+/g) ?? [];
      return urls.some((url) => {
        const qmark = url.indexOf("?");
        if (qmark === -1) return false;
        const query = url.slice(qmark + 1).split("&");
        const trackingCount = query.filter((p) => TRACKING_PARAMS.test(p)).length;
        return trackingCount > MAX_TRACKING;
      });
    },
  },
  {
    type: "nonsense_url_path",
    description:
      "La URL contiene una ruta con caracteres sin sentido, tipico de dominios generados aleatoriamente o enlaces manipulados.",
    weight: 25,
    matches: (t) => {
      const pathSegments = t.match(/https?:\/\/[^\/\s?#]+\/([^\s?#]*)/g) ?? [];
      const REPEATED_CHARS = /([a-z])\1{3,}/;
      const CONSONANT_RUN = /[bcdfghjklmnpqrstvwxyz]{7,}/;
      return pathSegments.some((fullUrl) => {
        const path = fullUrl.replace(/^https?:\/\/[^\/]+/, "");
        const segments = path.split("/").filter(Boolean);
        return segments.some(
          (seg) => REPEATED_CHARS.test(seg) || CONSONANT_RUN.test(seg) || (seg.length > 15 && /^[a-z]+$/.test(seg))
        );
      });
    },
  },
  {
    type: "suspicious_tld",
    description:
      "El enlace usa un dominio con TLD sospechoso, frecuente en sitios de phishing.",
    weight: 20,
    matches: (t) => {
      const SUSPICIOUS_TLDS = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(xyz|top|click|link|download|review|trade|webcam|men|loan|win|bid|date|racing|science|gdn)\b/i;
      return SUSPICIOUS_TLDS.test(t);
    },
  },
];

/**
 * Evalua las reglas sobre contenido redactado y devuelve las senales activadas,
 * en el orden estable del catalogo. Funcion pura: no muta la entrada ni depende
 * de estado externo. Cada senal se valida con `signalSchema` para garantizar
 * los limites del dominio.
 *
 * PR04-10: SOLO acepta `RedactedText`. Un `string` crudo es un error de tipo, de
 * modo que no se puedan evaluar reglas sobre contenido sin redactar. El unico
 * productor legitimo de `RedactedText` es `redact()` (PR-01); este modulo no
 * exporta casts ni constructores inseguros.
 */
export function evaluateRules(
  redacted: RedactedText,
  rules: readonly DetectionRule[] = DEFAULT_RULES,
): Signal[] {
  const lower = redacted.toLowerCase();
  const signals: Signal[] = [];
  for (const rule of rules) {
    if (rule.matches(lower)) {
      signals.push(
        signalSchema.parse({
          type: rule.type,
          description: rule.description,
          weight: rule.weight,
        }),
      );
    }
  }
  return signals;
}
