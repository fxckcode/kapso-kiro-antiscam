import type { FraudCategory } from "../domain/agent-evaluation.js";

/**
 * Catalogo de casos conocidos de fraude (PR-06 sec. 10).
 *
 * PRINCIPIOS DE DISENO:
 *  - Solo casos DEFENSIVOS: cada entrada explica como reconocer la estafa y
 *    que hacer; NUNCA incluye instrucciones para ejecutarla.
 *  - Sin keywords internas ni detalles tecnicos de evasion en `summary`:
 *    lo que ve el modelo debe ser util para analizar, no para abusar.
 *  - El catalogo es estatico y determinista: no hay red, filesystem ni estado
 *    global. Cualquier cambio requiere incrementar `CASES_VERSION`.
 *  - `signalTypes` y `keywords` se usan solo en el servidor para filtrar;
 *    no llegan al modelo (sec. 10 ultimo parrafo).
 *
 * INVARIANTE DE VERSION: si se modifica cualquier entrada (texto, keywords,
 * categoria, acciones), se debe incrementar `CASES_VERSION`. El id de
 * evidencia es determinista sobre (executionId, version, caseIds seleccionados),
 * de modo que un cambio en el catalogo invalida los ids de una version anterior.
 */

export const CASES_VERSION = "1.0.0";

export interface KnownCase {
  readonly caseId: string;
  readonly version: string;
  readonly category: FraudCategory;
  /** Tipos de senales del backend que correlacionan con este caso. */
  readonly signalTypes: readonly string[];
  /** Palabras clave del texto redactado que correlacionan (minusculas). */
  readonly keywords: readonly string[];
  /** Descripcion del patron para el modelo. Sin tecnicas de evasion. */
  readonly summary: string;
  /** Acciones defensivas recomendadas al usuario. Breves y accionables. */
  readonly recommendedActions: readonly string[];
}

export const KNOWN_CASES: readonly KnownCase[] = [
  {
    caseId: "kc-phishing-bancario-otp",
    version: CASES_VERSION,
    category: "phishing_bancario",
    signalTypes: ["otp_request", "credential_request", "impersonation", "artificial_urgency"],
    keywords: [
      "banco", "cuenta", "otp", "codigo", "verificacion", "contrasena",
      "bloquead", "suspendid", "actualiza", "confirma", "bbva", "banamex",
      "santander", "banorte", "paypal",
    ],
    summary:
      "El mensaje suplanta a una entidad bancaria o servicio financiero y " +
      "solicita credenciales, OTP o datos de cuenta bajo pretexto de " +
      "verificacion o desbloqueo urgente. Los bancos NUNCA solicitan estos " +
      "datos por WhatsApp, SMS o enlace externo.",
    recommendedActions: [
      "No compartas codigos OTP, contrasenas ni datos de cuenta por ningun canal de mensajeria.",
      "Llama directamente al numero oficial del banco para verificar cualquier alerta.",
      "Reporta el mensaje a tu banco y a la Condusef (800 999 8080).",
    ],
  },
  {
    caseId: "kc-premio-falso",
    version: CASES_VERSION,
    category: "premio_falso",
    signalTypes: ["fake_prize", "artificial_urgency", "immediate_payment_transfer"],
    keywords: [
      "ganaste", "premio", "sorteo", "felicidades", "seleccionad", "ganador",
      "reclama", "recibir", "cobrar", "deposita", "paga", "cuota", "activacion",
    ],
    summary:
      "El mensaje anuncia un premio, sorteo o regalo no solicitado y exige " +
      "realizar un pago, deposito o proporcionar datos para 'activarlo' o " +
      "'liberarlo'. Los sorteos legitimos no cobran cuotas previas.",
    recommendedActions: [
      "No realices ningun pago para reclamar un premio que no solicitaste.",
      "Verifica la autenticidad del sorteo en el sitio oficial de la empresa.",
      "Ignora y reporta mensajes que piden datos financieros para 'liberar' premios.",
    ],
  },
  {
    caseId: "kc-suplantacion-soporte",
    version: CASES_VERSION,
    category: "suplantacion",
    signalTypes: ["impersonation", "lookalike_domain", "credential_request"],
    keywords: [
      "soporte", "tecnico", "servicio al cliente", "equipo de seguridad",
      "cuenta bloqueada", "acceso no autorizado", "detectamos", "movimiento sospechoso",
      "verifica", "ingresa", "enlace", "link", "sat", "imss", "cfe",
    ],
    summary:
      "El mensaje se hace pasar por soporte tecnico, seguridad o una entidad " +
      "gubernamental (SAT, IMSS, CFE) y solicita acceso remoto, credenciales o " +
      "datos personales. Las instituciones oficiales contactan por canales " +
      "certificados, no por WhatsApp no solicitado.",
    recommendedActions: [
      "No instales aplicaciones ni des acceso remoto a tu dispositivo.",
      "Nunca compartas contrasenas o datos personales con quien te contacta de forma inesperada.",
      "Verifica la comunicacion llamando directamente al numero oficial de la institucion.",
    ],
  },
  {
    caseId: "kc-inversion-falsa",
    version: CASES_VERSION,
    category: "inversion_falsa",
    signalTypes: ["guaranteed_earnings"],
    keywords: [
      "inversion", "rendimiento", "garantizado", "sin riesgo", "ganancias",
      "duplica", "multiplica", "capital", "cripto", "forex", "trading",
      "retorno asegurado", "100%", "rentabilidad",
    ],
    summary:
      "El mensaje promete inversiones con rendimientos garantizados, sin riesgo " +
      "o con retornos desproporcionados. Ninguna inversion legitima garantiza " +
      "ganancias. Estas esquemas suelen ser piramides o fraudes de tipo Ponzi.",
    recommendedActions: [
      "Desconfia de cualquier oferta que garantice ganancias o prometa rendimientos superiores al mercado.",
      "Verifica si la empresa esta registrada ante la CNBV antes de invertir.",
      "Consulta a un asesor financiero certificado antes de tomar decisiones de inversion.",
    ],
  },
  {
    caseId: "kc-familiar-en-apuros",
    version: CASES_VERSION,
    category: "familiar_en_apuros",
    signalTypes: ["relative_in_trouble", "artificial_urgency", "immediate_payment_transfer"],
    keywords: [
      "familiar", "hijo", "hija", "hermano", "hermana", "primo", "primero",
      "emergencia", "accidente", "hospital", "detenido", "cambio de numero",
      "nuevo numero", "prestame", "necesito", "urgente", "transferencia",
    ],
    summary:
      "El mensaje finge ser un familiar cercano que cambio de numero o esta en " +
      "una situacion de emergencia (accidente, detencion, hospital) y solicita " +
      "una transferencia urgente. La urgencia artificialmente creada busca " +
      "impedir la verificacion de identidad.",
    recommendedActions: [
      "Llama directamente al numero conocido del familiar para verificar la situacion.",
      "Usa una palabra clave familiar previamente acordada para autenticar mensajes urgentes.",
      "No realices transferencias sin confirmar la identidad del solicitante por otro canal.",
    ],
  },
];
