/**
 * Puerto del servicio conversacional.
 *
 * Lo implementa el agente conversacional de Strands.
 * La LambdaProcessor lo usa como paso previo al analisis completo.
 */
import type { AnalysisRequestedEvent } from '../queue/events';

export type ConversationOutcome =
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'needs_analysis' };

export interface ConversationService {
  /** Procesa un mensaje y retorna respuesta conversacional o indica que requiere analisis. */
  converse(event: AnalysisRequestedEvent): Promise<ConversationOutcome>;
}
