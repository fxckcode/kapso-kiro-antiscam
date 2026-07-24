# AntiScamBot - Plan de implementacion del MVP

> Objetivo: entregar una demo end-to-end estable de texto y enlaces antes del 27 de julio de 2026.
> Regla operativa: ninguna capacidad stretch entra antes de completar el E2E real.

## 1. Orden de trabajo

```text
Contratos externos + acceso Bedrock
  -> webhook, SQS y respuesta fija
  -> contratos de dominio e idempotencia
  -> senales, URLs y reputacion
  -> Strands + Bedrock + esquema validado
  -> privacidad, operacion y E2E
  -> landing, video y demo
```

## 2. PRs propuestos

| PR | Responsable principal | Entrega | Criterio de aceptacion y prueba |
|---|---|---|---|
| PR-01 | B - Analisis | Tipos de dominio, esquema Zod/JSON Schema, redactor determinista y fixtures. | La evaluacion del agente no contiene `verdict`; PII, OTP y tarjetas no sobreviven la redaccion. |
| PR-02 | C - Plataforma | Scaffold TypeScript/CDK, LambdaWebhook, SQS, DLQ y LambdaProcessor con respuesta fija. | `cdk synth` pasa; SQS y el procesador reciben solo mensaje redactado y URLs sanitizadas. |
| PR-03 | A - Integracion | Spike y adaptadores Kapso: payload real, autenticacion, ID, reintentos y envio. | Test de contrato con payload capturado; mensaje de prueba recibe respuesta fija. |
| PR-04 | B - Analisis | Extraccion/validacion de URLs, reglas como senales, allowlist de referencias y adaptador VirusTotal degradable para herramientas. | Regex aislada no produce `scam`; tests SSRF, redirects, `referenceId`, cache y error de cuota. |
| PR-05 | C - Plataforma | DynamoDB, maquina de estados por `messageId`, GSI1, rate limiting y secretos. | Un reintento desde `RECEIVED` completa el enqueue; solo `RESPONDED` termina el mensaje; analisis incluye `GSI1PK` y `GSI1SK`. |
| PR-06 | B - Analisis | Agente Strands, `BedrockProvider`, prompt, `Signal[]` como contexto, herramientas cerradas y salida estructurada. | El agente solo recibe `checkUrlReputation(referenceId)` y `retrieveKnownCases`; el backend deriva `verdict` y descarta evidencia sin resultado real de herramienta. |
| PR-07 | A - Integracion | Consentimiento, comandos `mas info`, `falso positivo`, eliminacion y formato WhatsApp. | Sin consentimiento se descarta el contenido, se pide `ACEPTO` y se solicita reenviar despues de aceptar. |
| PR-08 | C - Plataforma | IAM minimo, observabilidad, alarmas, presupuesto, concurrencia y runbook de apagado. | Assertions CDK verifican permisos y alarmas; logs no contienen payload crudo. |
| PR-09 | A, B y C | E2E, landing, README, politica de privacidad, guion y video. | WhatsApp real con texto y URL llega a una respuesta estructurada y explicable. |

## 3. Responsabilidades equilibradas

### Persona A - Integracion y experiencia

- PR-03, PR-07 y coordinacion de PR-09.
- Landing, QR, politica de privacidad, README, narrativa de demo y video.
- Propietaria del contrato de Kapso y del flujo de consentimiento.

### Persona B - Agente y deteccion

- PR-01, PR-04 y PR-06.
- Reglas, seguridad de URL, VirusTotal, Strands, Bedrock, schema y pruebas unitarias.
- Esta asignacion contiene las antiguas tareas 2.3, 2.4, 2.6 y 2.11, pero en PRs pequenos y con dependencias explicitas.

### Persona C - Plataforma y confiabilidad

- PR-02, PR-05 y PR-08.
- CDK, SQS/DLQ, DynamoDB, idempotencia, rate limiting, secretos, permisos, costos y despliegue.

Todos revisan al menos un PR de otra persona. Las interfaces de `domain/` no se cambian sin consenso entre A, B y C.

## 4. Tareas detalladas

### 4.1 Contratos y privacidad

- Definir `InboundMessage`, `Signal`, `ExternalEvidence`, `AnalysisResult` y `StoredAnalysis`.
- Validar entradas antes de encolar y resultados antes de responder.
- Redactar con codigo OTP, contrasenas, tarjetas, cuentas y documentos en LambdaWebhook, antes de SQS.
- HMAC del telefono con secreto; nunca SHA-256 sin clave.
- Definir respuestas seguras para error de analisis, falta de consentimiento y limite excedido.

### 4.2 Ingreso y procesamiento asincrono

- LambdaWebhook: verificar el mecanismo real de Kapso, consultar consentimiento, manejar contenido crudo solo en memoria, redactar y sanitizar antes de crear/enviar el evento SQS.
- Sin consentimiento: descartar contenido, enviar onboarding, esperar `ACEPTO` y pedir reenviar; no crear mensaje pendiente.
- Maquina de estados: crear `RECEIVED`, publicar evento sanitizado, cambiar a `ENQUEUED`; la procesadora reclama `PROCESSING` y termina exclusivamente en `RESPONDED`.
- LambdaProcessor: procesar lotes SQS redactados, reportar fallos por item y no tener una ruta que acepte contenido crudo.
- Configurar visibilidad de SQS mayor al timeout de Lambda y DLQ despues de tres recepciones.

### 4.3 Deteccion y URLs

- Normalizar texto y extraer URLs HTTP/HTTPS.
- Bloquear loopback, localhost, rangos privados y metadata de AWS antes de expandir.
- Limitar a tres redirects, timeout corto y tamano de respuesta limitado; nunca ejecutar JavaScript.
- Entregar `Signal[]`; no permitir que una regla comun declare un veredicto.
- Generar una allowlist por invocacion que asocia cada URL validada a un `referenceId`; LambdaProcessor no consulta reputacion de forma previa al agente.

### 4.4 Agente especializado

- Crear el agente Strands dentro de la Lambda procesadora y entregar `Signal[]` calculado por el backend como contexto.
- Exponer solo herramientas de lectura: `checkUrlReputation(referenceId)`, que resuelve la allowlist, consulta cache y despues VirusTotal si es necesario, y `retrieveKnownCases`.
- Delimitar el contenido del usuario y prohibir seguir instrucciones incluidas en el.
- Configurar Bedrock con `BEDROCK_MODEL_ID` y `AWS_REGION`.
- Validar la evaluacion con Zod/JSON Schema, comprobar que cada evidencia corresponde a un resultado real de herramienta y descartar la que no tenga procedencia; normalizar `risk_score` y derivar `verdict` exclusivamente en backend: 80-100 `scam`, 55-79 `suspicious`, 30-54 `insufficient_information`, 0-29 `likely_legitimate`.

### 4.5 Datos y conversacion

- Persistir resultado redactado con TTL recomendado de siete dias.
- Usar `messageId` con los estados `RECEIVED`, `ENQUEUED`, `PROCESSING` y `RESPONDED`; un fallo de SQS desde `RECEIVED` debe poder reintentar el enqueue.
- Todo analisis incluye `GSI1PK=USER#<hmac>` y `GSI1SK=<createdAt>` para consultar el ultimo analisis, `mas info`, feedback y eliminacion.
- Aplicar limite por minuto y diario antes de gastar cuota del modelo.
- Registrar feedback sin reentrenar ni actualizar casos automaticamente.
- Consentimiento explicito: sin consentimiento se descarta el contenido y se pide `ACEPTO`; despues de aceptarlo se pide reenviar el mensaje sospechoso. La eliminacion desactiva la participacion y borra datos alcanzables.

### 4.6 Operacion y calidad

- Presupuestos, alarma de DLQ, retencion corta de logs, concurrency limit y modo degradado de proveedores.
- Unit tests: redactor en webhook, schema, derivacion de veredicto, reglas, URLs, `referenceId`, allowlist, cache/reputacion de herramienta, procedencia de evidencia, rate limit y maquina de estados.
- Integracion: webhook redactado -> SQS -> procesador -> persistencia -> adaptador Kapso, con mocks; cubrir reintento desde `RECEIVED` y onboarding sin contenido pendiente.
- E2E: numero de prueba autorizado, mensaje de texto y enlace; documentar evidencia de resultado.

## 5. No implementar antes del E2E

- Vector store, embeddings, Titan Embeddings o Bedrock Knowledge Bases.
- OCR, descarga/persistencia de capturas o analisis multimodal.
- Proxy multimodelo.
- Fast path automatico.
- Dashboard, grupos, audios y automatizacion de aprendizaje.

## 6. Go/no-go diario

| Fecha | Objetivo minimo | Si falla |
|---|---|---|
| 23-24 julio | Kapso y Bedrock verificados; respuesta fija real. | No continuar con RAG ni imagenes; resolver contrato externo. |
| 25 julio | Analisis de texto/enlace con Strands y schema valido. | Usar una sola configuracion Bedrock y desactivar optimizaciones. |
| 26 julio | E2E, privacidad, rate limit y monitoreo. | Congelar funcionalidades y corregir estabilidad. |
| 27 julio | Landing, video, ensayo y demo. | Solo arreglos bloqueantes. |

## 7. Definition of done

Un PR esta listo cuando compila, sus pruebas pasan, no introduce secretos ni logs de payload, actualiza la documentacion que afecta y cuenta con revision de otra persona.
