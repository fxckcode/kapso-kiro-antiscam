import { BedrockModel } from "@strands-agents/sdk";
import { AgentConfigurationError } from "../errors.js";
import type { ModelProvider } from "./model-provider.js";

/**
 * Configuracion del proveedor Bedrock (PR-06 sec. 7).
 *
 * INVARIANTES:
 *  - `modelId` es OBLIGATORIO: no hay fallback. Un modelId vacio lanza
 *    `AgentConfigurationError`. El mensaje nombra la VARIABLE, nunca su valor
 *    (un ARN contiene el id de cuenta AWS).
 *  - `stream: false` selecciona el API `Converse` en lugar de `ConverseStream`.
 *  - `region` toma `AWS_REGION` del entorno; si no existe, usa `us-east-1` como
 *    unico fallback documentado. No se lee ninguna otra variable de region.
 *  - Las credenciales provienen de la cadena estandar del AWS SDK
 *    (`AWS_ACCESS_KEY_ID`, rol de Lambda, Instance Metadata, etc.). NO se
 *    hardcodean ni se imprimen.
 *  - El config se imprime sin modelId (log) porque un ARN es dato sensible de
 *    infraestructura; solo se indica si esta presente.
 */
export interface BedrockProviderConfig {
  readonly modelId: string;
  readonly region: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly stream: false;
}

/** Temperatura determinista para clasificacion: 0 reduce la varianza. */
const DEFAULT_TEMPERATURE = 0;
/** 1 024 tokens de salida para la evaluacion estructurada y la explicacion. */
const DEFAULT_MAX_TOKENS = 1024;
/** La variable de region estandar del AWS SDK. */
const REGION_VAR = "AWS_REGION";
/** Fallback documentado: solo si la variable no existe. */
const FALLBACK_REGION = "us-east-1";

/**
 * Construye la configuracion del proveedor Bedrock desde variables de entorno.
 *
 * @throws AgentConfigurationError si `BEDROCK_MODEL_ID` no esta definido o
 *   esta vacio. El mensaje menciona el nombre de la variable, no su valor.
 */
export function buildBedrockProviderConfig(): BedrockProviderConfig {
  const modelId = process.env["BEDROCK_MODEL_ID"];
  if (typeof modelId !== "string" || modelId.trim() === "") {
    throw new AgentConfigurationError(
      "BEDROCK_MODEL_ID no esta definido o esta vacio. " +
        "Proporciona un model ID, ARN o perfil de inferencia de Bedrock.",
    );
  }

  const rawRegion = process.env[REGION_VAR];
  const region =
    typeof rawRegion === "string" && rawRegion.trim() !== ""
      ? rawRegion.trim()
      : FALLBACK_REGION;

  return {
    modelId: modelId.trim(),
    region,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    stream: false,
  };
}

/**
 * Instancia un `BedrockModel` listo para pasar a `createAnalysisAgent`.
 *
 * Las credenciales no se tocan aqui: el AWS SDK las resuelve desde su cadena
 * estandar (variables de entorno, archivo `~/.aws`, rol IAM de la Lambda,
 * IMDS). No se llama a ninguna API hasta que el agente invoca el modelo.
 */
export function createBedrockProvider(config: BedrockProviderConfig): ModelProvider {
  return new BedrockModel({
    modelId: config.modelId,
    region: config.region,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    stream: config.stream,
  });
}
