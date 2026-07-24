# Sitemap — AntiScamBot

> Mapa de arquitectura, endpoints, componentes y flujos del sistema.

---

## 1. Visión General del Sistema

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USUARIO                                      │
│                  (WhatsApp en su celular)                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ Mensaje / Captura
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      KAPSO API (WhatsApp Gateway)                   │
│  • Webhook entrante (mensajes, imágenes, links)                     │
│  • API de salida (enviar respuesta)                                 │
│  • Logs de entrega                                                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ Webhook POST
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    API GATEWAY (HTTP)                                │
│  • Endpoint: POST /webhook/whatsapp                                 │
│  • Valida firma/API key de Kapso                                    │
│  • Responde 202 Accepted                                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ Encola mensaje
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       SQS (Simple Queue Service)                    │
│  • Cola principal: antiscambot-queue                                │
│  • Dead-Letter Queue: antiscambot-dlq                               │
│  • Retry: 3 intentos con backoff exponencial                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ Lambda consume
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   LAMBDA (Procesador Principal)                     │
│                                                                     │
│  ┌─────────────────┐                                                │
│  │ 1. Preprocesar  │ → Validar input, extraer texto, descargar img │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ 2. Capa Reglas  │ → Blacklist, Regex, URL expand, VT            │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐    ┌─────────────────┐                        │
│  │ 3. Embed + RAG  │───▶│ Vector Store    │                        │
│  └────────┬────────┘    │ (Casos similares)│                       │
│           ▼             └─────────────────┘                        │
│  ┌─────────────────┐                                                │
│  │ 4. Bedrock LLM  │ → Claude Sonnet 4 + RAG context               │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ 5. Postprocesar │ → Validar JSON, redactar datos, formatear     │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ 6. Persistir    │ → DynamoDB + S3 (si imagen)                   │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ 7. Responder    │ → Kapso API / POST mensaje                    │
│  └─────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Endpoints y Componentes

### 2.1 API Gateway

| Endpoint | Método | Descripción | Response |
|----------|--------|-------------|----------|
| `/webhook/whatsapp` | POST | Recibe mensajes entrantes de Kapso | `202 Accepted` + messageId |
| `/webhook/status` | POST | Callback de estado de entrega (Kapso) | `200 OK` |

### 2.2 SQS

| Recurso | Nombre | Descripción |
|---------|--------|-------------|
| Cola principal | `antiscambot-queue` | Mensajes pendientes de procesar |
| DLQ | `antiscambot-dlq` | Mensajes que fallaron después de 3 reintentos |
| Alarmas | CloudWatch Alarm | Notifica si DLQ tiene mensajes |

### 2.3 Lambda (Procesador)

| Función | Trigger | Descripción | Timeout | Memoria |
|---------|---------|-------------|---------|---------|
| `antiscambot-processor` | SQS | Procesa mensaje completo (reglas → LLM → respuesta) | 30s | 512MB |

### 2.4 Bedrock

| Recurso | Modelo | Uso |
|---------|--------|-----|
| Bedrock Runtime | `claude-sonnet-4` (Anthropic) | Análisis de estafa con RAG context |
| Bedrock Guardrails | Reglas de seguridad | Capa extra contra prompt injection |

### 2.5 DynamoDB

| Tabla | PK | SK | TTL | Descripción |
|-------|----|----|-----|-------------|
| `antiscambot-history` | `userId` (hash SHA-256) | `timestamp` (ISO) | 30 días | Historial de análisis |

**Estructura del Item:**
```json
{
  "userId": "a1b2c3d4...",          // Hash SHA-256 del número
  "timestamp": "2026-07-22T12:00:00Z",
  "mensajeOriginal": "[dato sensible eliminado] Hola, soy tu banco...",
  "tieneMultimedia": true,
  "urlImagen": "s3://.../abc.jpg",   // Opcional, presigned URL
  "veredicto": "scam",
  "confianza": 0.95,
  "nivelRiesgo": "alto",
  "categoria": "phishing_bancario",
  "metodoAnalisis": "llm",           // "regla" | "llm"
  "reglaUsada": null,                // Si método=regla, cuál
  "evidencia": ["El dominio registrado hace 3 días"],
  "recomendaciones": ["No compartas tu código"],
  "usuarioCorrigio": false,          // Falso positivo reportado
  "ttl": 1768953600                  // Unix timestamp + 30 días
}
```

### 2.6 S3

| Bucket | Uso | Lifecycle |
|--------|-----|-----------|
| `antiscambot-media` | Imágenes recibidas de usuarios | Expire a los 30 días |

### 2.7 Vector Store (RAG)

| Recurso | Descripción |
|---------|-------------|
| Base de vectores | Embeddings de casos de estafa conocidos en LATAM |
| Población inicial | Frases típicas, dominios reportados, prefijos sospechosos, ejemplos de estafas comunes |
| Actualización | Nuevos casos confirmados por usuarios |

### 2.8 Kapso API (Salida)

| Endpoint | Descripción |
|----------|-------------|
| `POST /messages` | Enviar mensaje de texto al usuario |
| `POST /messages/media` | Enviar imagen/media al usuario |
| `POST /messages/template` | Enviar plantilla de mensaje |

---

## 3. Flujos Principales

### 3.1 Flujo: Usuario envía mensaje de texto

```
User → WhatsApp → Kapso Webhook → API Gateway (202) → SQS
→ Lambda:
  1. Preprocesar: validar input, extraer texto
  2. Capa Reglas:
     a. Blacklist match? → responde directo, no LLM
     b. Regex match? → responde directo, no LLM
     c. URL presente? → expandir + VirusTotal
     d. Si certeza ≥ threshold → responder. Si no → continuar.
  3. Embed mensaje → buscar en Vector Store (top-K)
  4. Construir prompt con RAG context
  5. Invocar Bedrock (Claude Sonnet 4)
  6. Validar JSON de salida
  7. Redactar datos sensibles
  8. Persistir en DynamoDB
  9. Responder vía Kapso API
```

### 3.2 Flujo: Usuario envía captura de pantalla

```
User → WhatsApp (imagen) → Kapso Webhook → API Gateway → SQS
→ Lambda:
  1. Kapso entrega URL de la imagen
  2. Lambda descarga la imagen de la URL (timeout corto)
  3. Sube a S3 (antiscambot-media)
  4. Pasa URL al LLM como contexto visual
  5. LLM analiza texto extraído + contexto
  6. Mismo pipeline de validación y respuesta
```

### 3.3 Flujo: Primer mensaje (onboarding)

```
User envía primer mensaje
→ Lambda detecta que userId no existe en DynamoDB
→ Responde mensaje de onboarding:
  "👋 Hola, soy AntiScamBot. Te ayudo a detectar estafas.
   Al enviarme un mensaje aceptás que lo procese para analizarlo.
   ¿Tenés algún mensaje sospechoso?"
→ Marca onboarding completado para ese userId
→ Si el usuario responde → pipeline normal
```

### 3.4 Flujo: Falso positivo

```
User: "falso positivo" o "esto no es estafa"
→ Lambda detecta keyword
→ Busca último mensaje analizado en DynamoDB
→ Actualiza item: { usuarioCorrigio: true, correccion: "falso_positivo" }
→ Responde: "Gracias, lo tenemos en cuenta para mejorar"
→ (Post-MVP: retroalimenta el RAG)
```

### 3.5 Flujo: Rate limit excedido

```
User envía mensaje
→ Lambda verifica contador de requests/minuto en DynamoDB (TTL 1 min)
→ Si excede 10 req/min:
  → Responde: "Esperá un momento antes de enviar más mensajes"
  → No procesa el mensaje
→ Si está dentro del límite:
  → Incrementa contador
  → Pipeline normal
```

### 3.6 Flujo: Error / Dead Letter

```
Lambda procesa mensaje → error (LLM timeout, Kapso down)
→ Primer retry (backoff 5s) → error
→ Segundo retry (backoff 20s) → error
→ Tercer retry (backoff 60s) → error
→ Mensaje → DLQ (antiscambot-dlq)
→ CloudWatch Alarm se dispara
→ Equipo revisa DLQ manualmente
```

---

## 4. Estructura del Proyecto (Repo)

```
antiscambot/
├── .github/
│   └── workflows/          # CI/CD (opcional)
├── cdk/                    # Infraestructura CDK TypeScript
│   ├── bin/
│   │   └── app.ts          # Entry point CDK
│   ├── lib/
│   │   ├── api-stack.ts         # API Gateway + SQS
│   │   ├── processor-stack.ts   # Lambda + Bedrock
│   │   ├── data-stack.ts        # DynamoDB + S3
│   │   └── monitoring-stack.ts  # CloudWatch alarms + budgets
│   └── test/
├── src/                    # Código de la Lambda
│   ├── handler.ts               # Entry point (SQS handler)
│   ├── preprocessor.ts          # Validación, extracción de texto
│   ├── rules/
│   │   ├── index.ts             # Orquestador de reglas
│   │   ├── blacklist.ts         # Blacklist de dominios
│   │   ├── regex-patterns.ts    # Patrones de texto conocidos
│   │   ├── url-expander.ts      # Expansión de short URLs
│   │   └── virustotal.ts        # Consulta VirusTotal API
│   ├── rag/
│   │   ├── embedder.ts          # Genera embeddings
│   │   └── vector-store.ts      # Consulta vector store
│   ├── llm/
│   │   ├── bedrock.ts           # Invocación Bedrock
│   │   ├── prompt-template.ts   # System + user prompt
│   │   └── schema.ts            # JSON schema de output
│   ├── postprocessor.ts         # Validación JSON, redacción datos
│   ├── persistence.ts           # DynamoDB + S3
│   ├── kapso.ts                 # Cliente Kapso API
│   ├── rate-limiter.ts          # Rate limiting
│   └── types.ts                 # Tipos compartidos
├── docs/
│   ├── PRD.md                   # (este documento)
│   ├── SITEMAP.md               # (este documento)
│   ├── UBIQUITOUS_LANGUAGE.md   # Glosario DDD
│   └── ADR.md                   # Decisiones arquitectónicas
├── landing/                 # Landing page (Vercel, opcional)
├── scripts/                 # Utilidades
├── test/
│   ├── unit/
│   │   ├── rules/
│   │   ├── llm/
│   │   └── rate-limiter.test.ts
│   ├── integration/
│   │   └── pipeline.test.ts
│   └── e2e/
│       └── whatsapp.test.ts
├── package.json
├── tsconfig.json
├── cdk.json
└── README.md
```

---

## 5. Stack CDK

| Stack | Recursos | Depende de |
|-------|----------|------------|
| `AntiScamBotApiStack` | API Gateway, SQS Queue, DLQ | — |
| `AntiScamBotProcessorStack` | Lambda, Bedrock IAM Role, Vector Store | ApiStack |
| `AntiScamBotDataStack` | DynamoDB Table, S3 Bucket | — |
| `AntiScamBotMonitoringStack` | CloudWatch Alarms, Budgets | Todos los stacks |

---

## 6. Variables de Entorno

| Variable | Descripción | Origen |
|----------|-------------|--------|
| `KAPSO_API_KEY` | API Key de Kapso | Secrets Manager |
| `KAPSO_PHONE_NUMBER` | Número del bot | CDK context / env |
| `VIRUSTOTAL_API_KEY` | API Key de VirusTotal | Secrets Manager |
| `BEDROCK_MODEL_ID` | ID del modelo Claude | Parámetro SSM |
| `BEDROCK_REGION` | Región de Bedrock | CDK env |
| `DYNAMODB_TABLE` | Nombre de tabla | CDK output |
| `S3_BUCKET` | Nombre del bucket | CDK output |
| `SQS_QUEUE_URL` | URL de la cola | CDK output |
| `RATE_LIMIT_PER_MIN` | Límite de requests/minuto | CDK context |
| `RATE_LIMIT_DAILY` | Límite de requests/día | CDK context |
| `MAX_MESSAGE_LENGTH` | Máximo de caracteres del mensaje | CDK context |
