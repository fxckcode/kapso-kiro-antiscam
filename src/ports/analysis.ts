/**
 * Puerto del pipeline de analisis.
 *
 * Lo implementa el equipo de detection/domain (Strands + Bedrock + reglas).
 * La LambdaProcessor depende de esta interfaz para no acoplarse a la
 * implementacion concreta del agente.
 *
 * Este frente (Kapso) solo consume el resultado para responder por WhatsApp.
 */
import type { AnalysisRequestedEvent } from '../queue/events';

export type Verdict = 'scam' | 'suspicious' | 'insufficient_information' | 'likely_legitimate';

export interface AnalysisEvidence {
  readonly source: string;
  readonly summary: string;
  readonly reference: string;
}

/** Resultado final derivado por el backend (incluye el veredicto). */
export interface AnalysisResult {
  readonly verdict: Verdict;
  /** Entero 0-100. */
  readonly riskScore: number;
  /** Decimal 0-1. */
  readonly confidence: number;
  readonly category: string | null;
  readonly evidence: readonly AnalysisEvidence[];
  readonly recommendedActions: readonly string[];
  readonly shortExplanation: string;
  readonly needsMoreInformation: boolean;
}

export interface AnalysisPipeline {
  analyze(event: AnalysisRequestedEvent): Promise<AnalysisResult>;
}
