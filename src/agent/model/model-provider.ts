import type { Model } from "@strands-agents/sdk";
import type { BaseModelConfig } from "@strands-agents/sdk";

/**
 * Puerto minimo que el agente necesita del proveedor de modelo (PR-06 sec. 7).
 *
 * Definir un puerto en lugar de acoplar directamente a `BedrockModel` permite:
 *  1. Inyectar un modelo falso en tests sin red ni credenciales (sec. 15).
 *  2. Cambiar el proveedor (p. ej. OpenAI via Strands) sin tocar `createAnalysisAgent`.
 *
 * `Model<BaseModelConfig>` es exactamente lo que acepta el constructor de `Agent`
 * (campo `model`); no hay que crear un adaptador adicional.
 */
export type ModelProvider = Model<BaseModelConfig>;
