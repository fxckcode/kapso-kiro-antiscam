/**
 * Servicio conversacional.
 *
 * Flujo:
 * 1. Saludo → respuesta rapida
 * 2. Senales de estafa → "⏳ Analizando..." + analisis por reglas
 * 3. Otros → pasa al analisis completo (needs_analysis)
 */
import { redact } from '../domain/redaction.js';
import { evaluateRules } from '../detection/rules.js';
import type { Responder } from '../messaging/responder.js';
import type { ConversationService, ConversationOutcome } from '../ports/conversation.js';
import type { AnalysisRequestedEvent } from '../queue/events';

export interface ConversationServiceDeps {
  readonly responder: Responder;
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return {
    async converse(event: AnalysisRequestedEvent): Promise<ConversationOutcome> {
      const redacted = redact(event.redactedText).text;
      const signals = evaluateRules(redacted);
      const lower = event.redactedText.toLowerCase().trim();

      // Tambien revisar urlReferences por parametros de rastreo
      const hasTrackingRef = (event.urlReferences ?? []).some((ref) => ref.hasTrackingParams);
      if (hasTrackingRef) {
        signals.push({
          type: "tracking_url",
          description: "Contiene un enlace con parametros de rastreo excesivos que pueden ocultar el proposito real.",
          weight: 15,
        });
      }

      // Saludos simples -> respuesta directa sin Bedrock.
      const greetingRe = /^(hola|ola|buenas?|hey|ey|qu[eé] (tal|hay|cuenta|c pasa)|c[oó]mo (est[áa]s|van)|q[uo]e se dice)\s*[.!]*$/i;
      if (greetingRe.test(lower)) {
        const replies = [
          '¡Hola! 👋 Soy el asistente AntiScamBot. ¿Tenés algún mensaje sospechoso para verificar?',
          '¡Hola! ¿Cómo estás? En qué puedo ayudarte con la seguridad hoy?',
          '¡Buenas! Si recibiste un mensaje raro, reenviámelo y lo analizo.',
        ];
        return { kind: 'reply', text: replies[Math.floor(Math.random() * replies.length)] as string };
      }

      // Si hay señales de riesgo detectadas por reglas, generar respuesta
      // directa sin esperar a Bedrock. Las reglas son deterministas y ya
      // identificaron el problema.
      if (signals.length > 0) {
        const sigDescriptions = signals.map((s) => s.description.toLowerCase());
        const riskLevel =
          signals.some((s) => s.weight >= 30) ? '⚠️ Cuidado:' :
          signals.some((s) => s.weight >= 15) ? 'ℹ️ Precaución:' :
          'ℹ️ Nota:';

        const reply =
          `${riskLevel} Se detectaron las siguientes señales de riesgo:\n\n` +
          `• ${sigDescriptions.join('\n• ')}\n\n` +
          `Recomendación: No compartas información personal, no hagas clic en enlaces ` +
          `ni descargues archivos de fuentes no verificadas. ` +
          `Verifica la identidad del remitente por un canal oficial.\n\n` +
          `Esto es orientativo, no asesoramiento. Ante la duda, verifica por canales oficiales.\n` +
          `Responde MAS INFO para ver el detalle.`;
        return { kind: 'reply', text: reply };
      }

      // Sin senales: enviar feedback y pasar al analisis completo (Bedrock).
      await deps.responder.respondWithText(
        event.routingToken,
        '⏳ Analizando el mensaje... Esto toma solo unos segundos.',
        event.messageId,
      );
      return { kind: 'needs_analysis' };
    },
  };
}
