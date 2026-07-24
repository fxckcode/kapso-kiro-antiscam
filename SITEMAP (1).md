# Arquitectura y mapa del sistema - AntiScamBot

> Este archivo conserva el nombre `SITEMAP.md` por compatibilidad, pero describe arquitectura, componentes y flujos. Si se renombra mas adelante, el nombre recomendado es `ARCHITECTURE.md`.

## 1. Contexto de ejecucion

```text
WhatsApp
  -> Kapso / WhatsApp Cloud API
  -> API Gateway
  -> LambdaWebhook
  -> SQS principal ----> DLQ
  -> LambdaProcessor
  -> Kapso / WhatsApp Cloud API
  -> WhatsApp
```

Kapso es un sistema externo. Sus rutas, payloads, firma de webhook, reintentos y formato de envio se implementan solo despues de verificarlos en su documentacion y entorno de prueba.

## 2. Componentes

| Componente | Responsabilidad | Datos que puede manejar |
|---|---|---|
| API Gateway | Punto HTTP publico y protecciones de transporte. | Request sin loguear en bruto. |
| LambdaWebhook | Verifica autenticacion real de Kapso, consentimiento, maquina de estados y publica SQS. | Contenido crudo solo temporalmente en memoria; redacta y sanitiza antes de SQS. |
| SQS | Aisla el webhook del procesamiento pesado. | Evento minimizado con `messageId`, contenido redactado y referencias URL sanitizadas. |
| LambdaProcessor | Ejecuta el pipeline y controla reintentos. | Contenido redactado en memoria. |
| Strands Agent | Coordina herramientas de analisis cerradas. | Contenido delimitado y redactado. |
| Bedrock | Modelo principal de evaluacion. | Solo contexto redactado. |
| DynamoDB | Idempotencia, estado de usuario, limites, cache y analisis redactados. | Nunca telefono o contenido crudo. |
| S3 opcional | Solo stretch de imagenes temporales. | Se elimina tras procesar; lifecycle un dia. |
| Kapso adapter | Convierte la respuesta aprobada al formato real del proveedor. | Numero temporal, no persistido. |

## 3. Flujo de ingreso

```text
1. Kapso entrega un evento al endpoint publico. LambdaWebhook lo maneja temporalmente en memoria y nunca lo registra en bruto.
2. LambdaWebhook verifica firma/autenticacion segun contrato confirmado y consulta consentimiento por usuario seudonimizado.
3. Sin consentimiento, descarta el contenido, envia onboarding y solicita `ACEPTO`; no almacena, analiza, encola ni conserva un mensaje pendiente.
4. Al recibir `ACEPTO`, registra solo el consentimiento, solicita reenviar el mensaje sospechoso y descarta el texto de control.
5. Con consentimiento, valida tipo, tamano e `messageId`; redacta contenido y extrae, valida y sanitiza URLs antes de continuar.
6. Crea condicionalmente el estado `RECEIVED`, publica en SQS solo el evento sanitizado y cambia a `ENQUEUED`.
7. Si publicar falla despues de `RECEIVED`, un reintento puede publicar y completar `ENQUEUED`. Si ya esta `ENQUEUED`, no publica de nuevo.
```

La autenticacion no se resuelve suponiendo que una API key de API Gateway equivale a firma de webhook. El mecanismo debe venir de Kapso.

## 4. Flujo de procesamiento

```text
SQS record
  -> verificar consentimiento vigente y rate limit
  -> obtener senales deterministas
  -> validar/sanitizar URLs y crear allowlist de referenceId
  -> Strands con Signal[] como contexto y herramientas cerradas
  -> validar output estructurado
  -> descartar evidencia sin resultado real de herramienta
  -> derivar verdict desde risk_score
  -> persistir analisis redactado
  -> enviar respuesta por Kapso
```

Si Bedrock o VirusTotal falla, se devuelve una respuesta de informacion insuficiente o se reintenta conforme a la clase del error. Una falla permanente del item termina en DLQ tras tres recepciones.

La evaluacion validada del agente no incluye `verdict`. El backend deriva el resultado final desde `riskScore`: 80-100 `scam`, 55-79 `suspicious`, 30-54 `insufficient_information` y 0-29 `likely_legitimate`; `confidence` permanece independiente. El backend conserva los resultados de herramientas de la invocacion y descarta evidencia que no corresponda a uno de ellos.

## 5. Limite del agente

```text
LambdaProcessor
  |- reglas deterministas -> Signal[] como contexto
  |- URL validator -> allowlist de referenceId
  |- Strands AnalysisAgent
  |    |- checkUrlReputation(referenceId) -> allowlist -> cache -> VirusTotal
  |    `- retrieveKnownCases()
  |- schema validator
  |- persistence service
  `- Kapso sender
```

El agente no puede llamar HTTP arbitrario, seleccionar herramientas por texto del usuario, persistir ni enviar mensajes. `checkUrlReputation` solo acepta un `referenceId` existente en la allowlist de la invocacion; el agente nunca proporciona una URL. Esas acciones son responsabilidad del backend, que mantiene idempotencia, procedencia de evidencia y control de efectos.

## 6. Datos

### Tabla DynamoDB

Se recomienda una tabla principal con entidades separadas por prefijo:

| Entidad | Clave primaria | Uso |
|---|---|---|
| Estado de mensaje | `PK=MSG#<messageId>`, `SK=STATE` | Maquina `RECEIVED -> ENQUEUED -> PROCESSING -> RESPONDED`; solo `RESPONDED` termina el mensaje. |
| Analisis | `PK=MSG#<messageId>`, `SK=ANALYSIS` | Resultado y contenido redactados, con `GSI1PK` y `GSI1SK`. |
| Usuario | `PK=USER#<hmac>`, `SK=PROFILE` | Consentimiento y opt-out. |
| Limite | `PK=USER#<hmac>`, `SK=RATE#<periodo>` | Contadores con TTL. |
| Cache URL | `PK=URL#<hash>`, `SK=REPUTATION` | Cache con TTL y metadatos de fuente. |

El indice se define exactamente como `GSI1PK=USER#<hmac>` y `GSI1SK=<createdAt>`. Cada registro de analisis incluye ambos atributos; el GSI permite localizar el ultimo analisis para `mas info`, feedback y eliminacion. Todo item expirable contiene `ttl`; los analisis se retienen siete dias por defecto.

El registro de estado incluye `status`, `updatedAt` y una concesion temporal de procesamiento. El procesador cambia condicionalmente `ENQUEUED` a `PROCESSING`; si un intento se interrumpe, otro reintento puede reclamar una concesion expirada manteniendo el estado `PROCESSING`. Tras confirmacion del envio por Kapso, cambia a `RESPONDED`.

### Registro de analisis

```json
{
  "messageId": "id-del-proveedor",
  "userId": "HMAC-SHA256",
  "createdAt": "2026-07-23T12:00:00Z",
  "GSI1PK": "USER#<hmac>",
  "GSI1SK": "2026-07-23T12:00:00Z",
  "redactedMessage": "Tu codigo es [OTP_REDACTED]",
  "riskScore": 65,
  "confidence": 0.72,
  "verdict": "suspicious",
  "category": "phishing_bancario",
  "signals": [],
  "evidence": [],
  "analysisMethod": "agent; verdict derived by backend",
  "ttl": 0
}
```

## 7. Estructura recomendada del repositorio

```text
antiscambot/
├── cdk/
│   ├── bin/app.ts
│   ├── lib/api-stack.ts
│   ├── lib/processor-stack.ts
│   ├── lib/data-stack.ts
│   └── lib/monitoring-stack.ts
├── src/
│   ├── handlers/webhook.ts
│   ├── handlers/processor.ts
│   ├── application/analyze-message.ts
│   ├── domain/
│   │   ├── analysis-result.ts
│   │   ├── signal.ts
│   │   └── redaction.ts
│   ├── agent/
│   │   ├── create-analysis-agent.ts
│   │   ├── output-schema.ts
│   │   ├── prompt.ts
│   │   ├── model/create-model.ts
│   │   └── tools/
│   ├── adapters/
│   │   ├── kapso/
│   │   ├── virustotal/
│   │   ├── dynamodb/
│   │   └── bedrock/
│   └── known-cases/
├── landing/
├── test/unit/
├── test/integration/
├── test/e2e/
└── docs/
```

## 8. Configuracion

| Variable | Fuente | Uso |
|---|---|---|
| `BEDROCK_MODEL_ID` | SSM/configuracion de despliegue | Modelo Bedrock seleccionado. |
| `AWS_REGION` | CDK | Region de Bedrock y recursos. |
| `KAPSO_*` | Secrets Manager/configuracion | Solo valores confirmados por el proveedor. |
| `VIRUSTOTAL_API_KEY` | Secrets Manager | Reputacion de URL. |
| `USER_HASH_SECRET` | Secrets Manager | Clave HMAC de seudonimizacion. |
| `ANALYSIS_TTL_DAYS` | CDK/configuracion | Retencion de analisis redactados. |
| `RATE_LIMIT_PER_MIN` | CDK/configuracion | Limite por usuario. |
| `RATE_LIMIT_DAILY` | CDK/configuracion | Limite diario por usuario. |
| `IMAGES_ENABLED` | CDK/configuracion | Feature flag, `false` en MVP base. |
| `FAST_PATH_ENABLED` | CDK/configuracion | Feature flag, `false` en MVP base. |

## 9. Seguridad y operacion

- IAM minimo: cada Lambda solo accede a los recursos que necesita.
- Cifrado en reposo y en transito; secretos fuera de variables versionadas.
- No se registran payloads completos, telefonos, OTPs ni secretos.
- URLs: HTTP/HTTPS, DNS/IP seguro, tres redirects maximo, timeout, tamano maximo y sin JavaScript.
- Alarmas: DLQ no vacia, errores de Lambda, presupuesto y cuota/fallos de proveedores.
- Concurrencia limitada para no agotar Bedrock ni VirusTotal.
- El despliegue se elimina con CDK cuando finalice la demo.

## 10. Imagenes y base de casos

Las imagenes estan fuera del flujo base. Si se habilitan, deben usar contrato Kapso confirmado, formatos soportados por el modelo y eliminacion inmediata. No deben condicionar la demo de texto.

La base inicial de casos es un conjunto pequeno, revisado y versionado. RAG vectorial, embeddings y retroalimentacion automatica son post-MVP.
