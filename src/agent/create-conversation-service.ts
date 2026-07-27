/**
 * Servicio conversacional que envuelve el agente Strands.
 *
 * Flujo:
 * 1. Si el mensaje activa reglas de deteccion → envia "⏳ Analizando..." y llama al agente
 * 2. Si no → llama al agente directamente (respuesta conversacional)
 * 3. El agente decide si usar analyzeScam tool o responder naturalmente
 */
import { redact } from '../domain/redaction.js';
import { evaluateRules } from '../detection/rules.js';
import { createConversationAgent } from './create-conversation-agent.js';
import type { ModelProvider } from './model/model-provider.js';
import type { CheckUrlReputationDeps } from '../reputation/check-url-reputation.js';
import type { Responder } from '../messaging/responder.js';
import type { ConversationService, ConversationOutcome } from '../ports/conversation.js';
import type { AnalysisRequestedEvent } from '../queue/events';

export interface ConversationServiceDeps {
  readonly model: ModelProvider;
  readonly reputationDeps: CheckUrlReputationDeps;
  readonly responder: Responder;
  readonly now: () => string;
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return {
    async converse(event: AnalysisRequestedEvent): Promise<ConversationOutcome> {
      const redacted = redact(event.redactedText).text;
      const signals = evaluateRules(redacted);
      const lower = event.redactedText.toLowerCase().trim();

      // Saludos simples -> respuesta directa sin agente (ahorra costos).
      const greetingRe = /^(hola|ola|buenas?|hey|ey|qu[eé] (tal|hay|cuenta|c pasa)|c[oó]mo (est[áa]s|van)|q[uo]e se dice)\s*[.!]*$/i;
      if (greetingRe.test(lower)) {
        const replies = [
          '¡Hola! 👋 Soy el asistente AntiScamBot. ¿Tenés algún mensaje sospechoso para verificar?',
          '¡Hola! ¿Cómo estás? En qué puedo ayudarte con la seguridad hoy?',
          '¡Buenas! Si recibiste un mensaje raro, reenviámelo y lo analizo.',
        ];
        return { kind: 'reply', text: replies[Math.floor(Math.random() * replies.length)] as string };
      }

      // Si hay senales de estafa, avisar que estamos analizando.
      if (signals.length > 0) {
        await deps.responder.respondWithText(
          event.routingToken,
          '⏳ Analizando el mensaje... Esto toma solo unos segundos.',
          event.messageId,
        );
      }

      // Crear agente conversacional y ejecutarlo.
      const agent = createConversationAgent({
        model: deps.model,
        reputationDeps: deps.reputationDeps,
        now: deps.now,
      });

      try {
        const result = await agent.invoke(event.redactedText);
        const text = result.toString().trim();
        const reply = text.length > 0 ? text : 'No pude procesar tu mensaje. ¿Podrías reenviarlo?';
        return { kind: 'reply', text: reply };
      } catch {
        return { kind: 'reply', text: 'Ocurrió un error al procesar tu mensaje. Intentalo de nuevo.' };
      }
    },
  };
}
