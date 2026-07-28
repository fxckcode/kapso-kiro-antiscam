/**
 * Servicio conversacional.
 *
 * Flujo:
 * 1. Saludo → respuesta rapida
 * 2. Senales de alto peso (≥25) → respuesta directa con las señales
 * 3. Senales de bajo peso (<25) o sin señales → pasa a Bedrock + VirusTotal
 */
import { redact } from '../domain/redaction.js';
import { evaluateRules } from '../detection/rules.js';
import type { Responder } from '../messaging/responder.js';
import type { ConversationService, ConversationOutcome } from '../ports/conversation.js';
import type { AnalysisRequestedEvent } from '../queue/events';

const HIGH_RISK_WEIGHT = 25; // Umbral: señales con peso >= 25 son alto riesgo

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

      // Señales de alto riesgo: respuesta directa sin esperar a Bedrock.
      const highRiskSignals = signals.filter((s) => s.weight >= HIGH_RISK_WEIGHT);
      if (highRiskSignals.length > 0) {
        const sigDescriptions = highRiskSignals.map((s) => s.description.toLowerCase());
        const reply =
          `⚠️ Se detectaron señales de riesgo:\n\n` +
          `• ${sigDescriptions.join('\n• ')}\n\n` +
          `Recomendación: No compartas información personal, no hagas clic en enlaces ` +
          `ni descargues archivos de fuentes no verificadas. ` +
          `Verifica la identidad del remitente por un canal oficial.\n\n` +
          `Esto es orientativo, no asesoramiento. Ante la duda, verifica por canales oficiales.\n` +
          `Responde MAS INFO para ver el detalle.`;
        return { kind: 'reply', text: reply };
      }

      // Señales bajas (tracking, nonsense) o sin señales: pasar a Bedrock + VirusTotal
      // para análisis contextual completo.
      await deps.responder.respondWithText(
        event.routingToken,
        '⏳ Analizando el mensaje... Esto toma solo unos segundos.',
        event.messageId,
      );
      return { kind: 'needs_analysis' };
    },
  };
}
