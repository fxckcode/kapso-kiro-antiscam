/**
 * Configuración pública de AntiScamBot.
 * Todas las variables usan el prefijo NEXT_PUBLIC_ para poder leerse en el cliente.
 * Si no están definidas, se usan placeholders seguros.
 */

const PLACEHOLDER_NUMBER = "54911XXXXXXXX";
const PLACEHOLDER_DISPLAY = "+54 11 XXX-XXXX";
const PLACEHOLDER_REPO = "https://github.com/usuario/antiscambot";

/** Número en formato internacional sin "+", usado para wa.me */
export const WHATSAPP_NUMBER =
  process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.trim() || PLACEHOLDER_NUMBER;

/** Número para mostrar en pantalla */
export const WHATSAPP_DISPLAY =
  process.env.NEXT_PUBLIC_WHATSAPP_DISPLAY?.trim() || PLACEHOLDER_DISPLAY;

/** Link al repositorio de GitHub */
export const GITHUB_REPO =
  process.env.NEXT_PUBLIC_GITHUB_REPO?.trim() || PLACEHOLDER_REPO;

/** Mensaje inicial que se precarga al abrir WhatsApp */
export const WHATSAPP_INITIAL_MESSAGE =
  "Hola AntiScamBot 👋 Quiero analizar un mensaje sospechoso.";

/** Indica si el número sigue siendo el placeholder (no configurado) */
export const IS_PLACEHOLDER_NUMBER =
  WHATSAPP_NUMBER === PLACEHOLDER_NUMBER ||
  /X/i.test(WHATSAPP_NUMBER) ||
  WHATSAPP_NUMBER.replace(/\D/g, "").length < 8;

/** Genera el link completo de WhatsApp con el mensaje inicial codificado */
export function buildWhatsAppLink(
  message: string = WHATSAPP_INITIAL_MESSAGE
): string {
  const digits = WHATSAPP_NUMBER.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
