/**
 * Puerto del pipeline de analisis.
 *
 * Lo implementa el equipo de detection/domain (Strands + Bedrock + reglas).
 * La LambdaProcessor depende de esta interfaz para no acoplarse a la
 * implementacion concreta del agente.
 *
 * Este frente (Kapso) solo consume el resultado para responder por WhatsApp.
 */
import type { SafeUrlReference } from '../queue/events';

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

/**
 * Puerto que el modulo de analisis real (PR-06) implementara. Este repositorio
 * no crea ni duplica el agente: solo inyecta el servicio en LambdaProcessor.
 */
export interface AnalysisService {
  analyze(input: {
    readonly executionId: string;
    /** Identidad original del mensaje SQS; la usa el resultado de dominio. */
    readonly messageId: string;
    /** Seudonimo del remitente, nunca el telefono en claro. */
    readonly userId: string;
    readonly redactedText: string;
    readonly urlReferences: readonly SafeUrlReference[];
  }): Promise<{
    readonly status: 'success' | 'fallback' | 'retryable_error';
    readonly result?: unknown;
  }>;
}
