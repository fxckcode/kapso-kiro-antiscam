# SDD Proposal: Agente Conversacional AntiScamBot

## Problema
El bot actual usa bifurcación hardcodeada (greeting detector → respuesta fija, sino → análisis one-shot). No puede mantener conversaciones naturales ni decidir cuándo analizar.

## Solución
Reemplazar el greeting hardcodeado en el processor por un agente conversacional de Strands que:
1. Responde saludos de forma natural
2. Decide CUÁNDO activar la herramienta `analyzeScam`
3. Manda "⏳ Analizando..." cuando activa la tool
4. Tiene guardrails para mantenerse enfocado en anti-scam

## Arquitectura
- `processRecord()` → si es saludo simple → agente conversacional
- El agente usa system prompt + herramientas
- `analyzeScam` tool ejecuta `evaluateRules()` y devuelve resultado
- Antes de ejecutar la tool, envía "⏳ Analizando..." via `respondWithText`
- Para mensajes complejos → sigue yendo al analysisService actual

## Componentes existentes
- `createConversationAgent.ts` ✅
- `analyze-scam-tool.ts` ✅  
- `conversation-prompt.ts` ✅
- `processor.ts` greeting handler (hardcodeado) - a reemplazar

## Cambios necesarios
1. **processor.ts**: reemplazar greeting hardcodeado por agente conversacional
2. **analyze-scam-tool.ts**: añadir callback de "analyzing..." 
3. **tests**: actualizar tests del processor
