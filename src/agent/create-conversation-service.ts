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

      // Si hay senales de riesgo, analizar y responder directamente.
      if (signals.length > 0) {
        await deps.responder.respondWithText(
          event.routingToken,
          '⏳ Analizando el mensaje... Esto toma solo unos segundos.',
          event.messageId,
        );

        const signalDescriptions = signals.map((s) => s.description).join(', ');
        const reply =
          `⚠️ Se detectaron señales de riesgo.\n\n` +
          `• ${signalDescriptions}\n\n` +
          `Recomendación: No compartas información personal ni hagas clic en enlaces sospechosos. ` +
          `Verifica la identidad del remitente por un canal oficial.`;
        return { kind: 'reply', text: reply };
      }

      // Sin senales y sin saludo: pasar al analisis completo.
      return { kind: 'needs_analysis' };
    },
  };
}
