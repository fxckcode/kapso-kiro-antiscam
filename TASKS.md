# AntiScamBot — Plan de Implementación

> **Hackathon**: AWS x Código Facilito — Kiro, Reto 3: Agentes Especializados
> **Equipo**: 3 personas | **Timeline**: 20–27 julio 2026

**Goal:** Construir un asistente WhatsApp que analiza mensajes y detecta estafas usando reglas + LLM + RAG, con landing page de presentación e infraestructura 100% serverless en AWS.

**Arquitectura:** Kapso (WhatsApp Gateway) → SQS → Lambda (rules + Bedrock LLM + RAG) → DynamoDB. IaC con CDK TypeScript. Landing page en Vercel (Next.js).

**Tres entregables:**
1. **Web** — Landing page de presentación del producto
2. **Asistente WhatsApp** — Core del bot (procesamiento, reglas, LLM, RAG)
3. **Infraestructura** — AWS CDK stacks + config + despliegue

---

## Entregable 1: Web de Presentación

Landing page del producto desplegada en Vercel. Una página escueta: qué es, cómo funciona, probalo escaneando el QR, política de privacidad.

### Tarea 1.1: Scaffold landing page

- Crear proyecto Next.js con App Router en `landing/`
- Desplegar en Vercel (o dejar ready para deploy)

### Tarea 1.2: Hero + propuesta de valor

- Sección hero: nombre "AntiScamBot", tagline, ilustración conceptual
- Explicación de 3 pasos: "Recibiste un mensaje → Reenvialo al bot → Obtene el veredicto"

### Tarea 1.3: Cómo funciona (Diagrama simple)

- Sección visual con el flujo: WhatsApp → Bot → Análisis → Respuesta
- Iconos + descripciones cortas

### Tarea 1.4: Probalo (QR + instrucciones)

- QR code del número de WhatsApp del bot
- Instrucciones: "Escanéa el QR o agregá el número +54 11 XXX-XXXX"
- Disclaimer: MVP temporal, demo del hackathon

### Tarea 1.5: Privacidad + footer

- Sección de privacidad: qué datos se guardan, por cuánto tiempo, cifrado
- Footer con créditos del equipo, link al repo de GitHub

---

## Entregable 2: Asistente WhatsApp

Core del bot en TypeScript. Procesa mensajes entrantes, aplica reglas, invoca Bedrock, responde al usuario.

### Tarea 2.1: Handler principal de Lambda

- `src/handler.ts` — entry point que recibe eventos de SQS
- Parseo del mensaje, extracción de userId (hash), timestamp, contenido
- Orquestador del pipeline: preprocesar → reglas → LLM → postprocesar → responder

### Tarea 2.2: Preprocesador

- `src/preprocessor.ts`
- Validar input: límite de caracteres, tipo de contenido
- Descargar imagen de URL de Kapso si viene multimedia
- Extraer texto de la imagen si es necesario (post-MVP)
- Subir imagen a S3 y obtener URL

### Tarea 2.3: Capa de reglas (fast path)

- `src/rules/index.ts` — orquestador que prueba cada regla en orden
- `src/rules/blacklist.ts` — blacklist de dominios conocidos (hardcodeada, seeds inicial)
- `src/rules/regex-patterns.ts` — patrones regex: "código de verificación", "CBU", "transferencia", "premio", "heredero", etc.
- `src/rules/url-expander.ts` — expandir short URLs (bitly, tinyurl) con fetch
- `src/rules/virustotal.ts` — consultar VirusTotal API por reputación del dominio
- Si una regla da certeza → responder directo con veredicto, NO invocar Bedrock

### Tarea 2.4: Integración Bedrock + Claude Sonnet 4

- `src/llm/bedrock.ts` — cliente AWS SDK para Bedrock Runtime
- `src/llm/prompt-template.ts` — system prompt + delimitadores `<user_message>`
- `src/llm/schema.ts` — definición del JSON de salida esperado
- Configurar Bedrock Guardrails

### Tarea 2.5: RAG + Vector Store

- `src/rag/embedder.ts` — generar embeddings con Bedrock Titan Embeddings
- `src/rag/vector-store.ts` — consultar base vectorial por similitud semántica
- Seed inicial con frases típicas de estafas en LATAM + dominios reportados
- Inyectar top-K resultados como contexto en el prompt

### Tarea 2.6: Postprocesador

- `src/postprocessor.ts`
- Parsear y validar JSON de salida del LLM
- Si no parsea → respuesta default de seguridad
- Redactar datos sensibles (CBU, tarjetas, DNI) detectados por regex ANTES de persistir
- Mapear confianza a nivel de riesgo (alto ≥ 0.8, medio 0.5-0.8, bajo < 0.5)

### Tarea 2.7: Persistencia DynamoDB + S3

- `src/persistence.ts`
- Guardar en DynamoDB: userId (hash), timestamp, mensaje redactado, veredicto, confianza, categoría, evidencia, etc.
- TTL de 30 días en DynamoDB
- Subir imágenes a S3 con lifecycle de 30 días
- No guardar número crudo, solo hash

### Tarea 2.8: Cliente Kapso (respuesta a usuario)

- `src/kapso.ts` — cliente HTTP para la API de Kapso
- Enviar mensajes de texto, imágenes (si aplica)
- Manejo de rate limits de Kapso, reintentos con jitter

### Tarea 2.9: Rate limiter

- `src/rate-limiter.ts`
- Contador por userId en DynamoDB con TTL de 1 minuto
- Límite: 10 requests/minuto + límite diario
- Cache de mensajes repetidos (mismo texto = no reprocesar)
- Truncamiento de texto (> límite de caracteres)

### Tarea 2.10: Manejo de onboarding + edge cases

- Detectar primer mensaje del usuario (userId no existe en DynamoDB)
- Enviar mensaje de onboarding con consentimiento implícito
- Detectar "falso positivo" / "más info" en respuesta del usuario
- Manejo de texto ininteligible o imagen borrosa
- Detección de uso malicioso (intento de diseñar estafas)
- Dead-letter: loggear error, no responder

### Tarea 2.11: Tests unitarios

- `test/unit/rules/` — tests para blacklist, regex, URL expander
- `test/unit/llm/` — tests de parseo de JSON de salida, prompt template
- `test/unit/rate-limiter.test.ts` — rate limiting contador y cache

### Tarea 2.12: Tests de integración

- `test/integration/pipeline.test.ts`
- Mockear Kapso y Bedrock
- Probar pipeline completo: input → reglas → LLM → output
- Probar cada nivel de confianza, cada categoría de estafa

---

## Entregable 3: Infraestructura AWS (CDK)

IaC con AWS CDK TypeScript. Define y despliega todos los recursos de AWS.

### Tarea 3.1: Setup CDK + proyecto

- `cdk/bin/app.ts` — entry point, instancia los stacks
- `cdk.json` — configuración de CDK
- `package.json` con dependencias: `aws-cdk`, `aws-cdk-lib`, etc.
- Variables de entorno en `cdk.context.json`

### Tarea 3.2: Stack API (ApiGateway + SQS)

- `cdk/lib/api-stack.ts`
- API Gateway HTTP: endpoint `POST /webhook/whatsapp`
- SQS Queue: cola principal + Dead-Letter Queue
- API Key validation para Kapso
- Outputs: queue URL, API endpoint

### Tarea 3.3: Stack Procesador (Lambda + Bedrock)

- `cdk/lib/processor-stack.ts`
- Lambda function desde `src/handler.ts`
- IAM Role con permisos: Bedrock InvokeModel, DynamoDB CRUD, S3 Get/Put, SQS Receive/Delete
- Environment variables: tabla DynamoDB, bucket S3, cola SQS, API keys de Kapso
- Timeout: 30s, memoria: 512MB
- Dead-letter queue config en el event source mapping

### Tarea 3.4: Stack Datos (DynamoDB + S3)

- `cdk/lib/data-stack.ts`
- DynamoDB: `antiscambot-history` con PK = userId (string), SK = timestamp (string)
- TTL enabled en columna `ttl`
- Auto-scaling: lectura/escritura bajo
- S3 bucket: `antiscambot-media` con lifecycle policy de 30 días
- CORS config para Kapso

### Tarea 3.5: Stack Monitoreo (CloudWatch + Budgets)

- `cdk/lib/monitoring-stack.ts`
- CloudWatch Alarm: DLQ con mensajes (notifica al equipo)
- Budget alerts: $0.01, $20, $50
- Log group de Lambda con retention de 7 días
- Dashboard básico de CloudWatch

### Tarea 3.6: Config + Secrets

- Secrets Manager: API key de Kapso, API key de VirusTotal
- SSM Parameter Store: modelo de Bedrock, región
- `.env.example` con todas las variables necesarias
- Script `scripts/setup-env.sh` para configurar secrets post-deploy

### Tarea 3.7: Deploy + verificación

- `cdk deploy --all` — desplegar todos los stacks
- Verificar outputs (API endpoint, queue URL)
- Configurar webhook de Kapso apuntando al API Gateway
- Test end-to-end: enviar mensaje por Kapso → ver Lambda log → ver DynamoDB item
- Script `scripts/verify-deploy.ts` que prueba el pipeline

---

## Dependencias entre entregables

```
Infraestructura (3.x) ──────┐
                             ├──> Asistente WhatsApp (2.x) ──> Web (1.x)
Kapso API / AWS ready ──────┘
```

**Orden sugerido:**

1. **Arrancar en paralelo**: Tarea 3.1 (setup CDK) + Tarea 1.1 (scaffold landing)
2. **Día 1-2**: Infraestructura básica (3.1-3.4) + webhook Kapso + Lambda que responde "recibido"
3. **Día 3-4**: Pipeline de análisis (2.3-2.6) + RAG (2.5)
4. **Día 5**: Edge cases (2.9-2.10) + seguridad + monitoreo (3.5)
5. **Día 6**: Tests (2.11-2.12) + landing page completa (1.2-1.5) + deploy final (3.7)
6. **Día 7**: Demo, video, presentación

**Asignación sugerida (3 personas):**

| Persona | Entregable principal | También |
|---------|---------------------|---------|
| A | Infraestructura (CDK) + Kapso webhook | Ayuda con deploy y tests de integración |
| B | Asistente WhatsApp (reglas, LLM, RAG) | Prompt engineering, schema, edge cases |
| C | Web (landing page) + DynamoDB schema + documentación | Tests unitarios, repo setup, README |
