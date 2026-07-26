/**
 * Responder: traduce el resultado del analisis a mensajes de WhatsApp y los
 * envia por Kapso (via el puerto WhatsAppSender).
 *
 * Genera el "Veredicto corto" (UBIQUITOUS_LANGUAGE §4): riesgo, explicacion y
 * accion principal. La copia es en espanol y siempre orientativa: nunca afirma
 * certeza absoluta. No incluye enlaces clicables sospechosos.
 */
import type { AnalysisResult, Verdict } from '../ports/analysis';
import type { WhatsAppSender } from './types';

const VERDICT_ICON: Record<Verdict, string> = {
  scam: '🚨',
  suspicious: '⚠️',
  insufficient_information: 'ℹ️',
  likely_legitimate: '✅',
};

const VERDICT_HEADLINE: Record<Verdict, string> = {
  scam: 'Alto riesgo: parece una estafa',
  suspicious: 'Cuidado: hay senales sospechosas',
  insufficient_information: 'No hay informacion suficiente para decidir',
  likely_legitimate: 'Parece seguro, pero nunca al 100%',
};

const DISCLAIMER = 'Esto es orientativo, no asesoramiento. Ante la duda, verifica por canales oficiales.';
const MORE_INFO_HINT = 'Responde MAS INFO para ver el detalle.';

/** Construye el texto del veredicto corto a partir del resultado. */
export function formatVerdict(result: AnalysisResult): string {
  const icon = VERDICT_ICON[result.verdict];
  const headline = VERDICT_HEADLINE[result.verdict];

  const lines: string[] = [`${icon} ${headline}`];

  if (result.shortExplanation.trim().length > 0) {
    lines.push('', result.shortExplanation.trim());
  }

  const primaryAction = result.recommendedActions[0];
  if (primaryAction !== undefined && primaryAction.trim().length > 0) {
    lines.push('', `Que hacer: ${primaryAction.trim()}`);
  }

  lines.push('', DISCLAIMER, MORE_INFO_HINT);
  return lines.join('\n');
}

export class Responder {
  private readonly sender: WhatsAppSender;

  constructor(sender: WhatsAppSender) {
    this.sender = sender;
  }

  /** Envia el veredicto corto derivado del analisis. */
  async respondWithResult(to: string, result: AnalysisResult, replyToMessageId?: string): Promise<void> {
    await this.sender.sendText(to, formatVerdict(result), replyToMessageId);
  }

  /** Envia un texto fijo (ej. acuse o modo degradado). */
  async respondWithText(to: string, body: string, replyToMessageId?: string): Promise<void> {
    await this.sender.sendText(to, body, replyToMessageId);
  }
}
