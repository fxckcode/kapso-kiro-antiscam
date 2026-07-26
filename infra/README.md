# Infra (AWS CDK) — AntiScamBot

Esqueleto de infraestructura como código para el MVP. Despliega el frente de
Kapso/WhatsApp: API Gateway → LambdaWebhook → SQS (+DLQ) → LambdaProcessor.

> No toca `src/domain`, `src/detection`, `src/url` ni `src/reputation`. Solo
> empaqueta los handlers de `src/lambda/*` y crea la infra alrededor.

## Recursos

- **SQS** `AnalysisQueue` (Standard) + **DLQ** con `maxReceiveCount = 3`.
- **LambdaWebhook** (`src/lambda/webhook.ts`) tras API Gateway `POST /webhook`.
- **LambdaProcessor** (`src/lambda/processor.ts`) con `SqsEventSource` y
  `reportBatchItemFailures: true`; concurrencia reservada para acotar costos.
- **DynamoDB** `ConsentTable` (PK `userId`, TTL `ttl`) para el consentimiento.
- **Secrets Manager**: secreto del webhook, secreto HMAC y API key de Kapso.
- **KMS** (opcional): key para el routing token, solo si
  `-c antiscambot:enableRoutingToken=true`. Desactivado por defecto.
- **CloudWatch Alarms**: DLQ no vacía, errores de cada Lambda.
- IAM de mínimo privilegio vía `grant*` (send a la cola, consume de la cola,
  read de secretos, read/write de `ConsentTable`, y encrypt/decrypt de KMS si
  aplica).

## Comandos

```bash
cd infra
npm install
npm run build          # tsc
npx cdk bootstrap      # una vez por cuenta/region
npm run synth          # revisar el template
npm run diff
npm run deploy
npm run destroy        # limpiar todo al terminar el hackathon
```

## Flujo E2E dev

Ver `scripts/README.md`. Resumen:

```bash
npm run build
npm test
./scripts/deploy-dev.sh          # cdk deploy + outputs
./scripts/set-secrets.sh         # cargar valores reales de los secretos
export WEBHOOK_URL="$(./scripts/get-webhook-url.sh)"
./scripts/webhook-consent.sh
./scripts/webhook-with-url.sh
```

## Contrato de Kapso (confirmado por docs)

- **Webhook**: usar tipo `Kapso (events)` con evento `Message received`. Viene
  firmado en `x-webhook-signature` (lo valida `auth.ts`). El payload es el
  formato nativo de Kapso (`whatsapp.message.received`), ya soportado por el
  parser (autodetecta nativo vs Meta).
- **Envío**: endpoint Meta-compatible `POST /meta/whatsapp/v24.0/{phone_number_id}/messages`
  con header `X-API-Key`. Requiere el **número destino** en `to`.
- Como el envío necesita el número, para el E2E hay que **habilitar el routing
  token** (`-c antiscambot:enableRoutingToken=true`): el webhook cifra el teléfono
  con KMS y el processor lo descifra. Nunca en claro en SQS, logs ni DynamoDB.

## Estado del roadmap

1. ✅ Resolutor de secretos (`src/lambda/shared/secrets.ts`).
2. ✅ QR configurable (`src/kapso/qr.ts`, `KAPSO_QR_PATH` + modo mock).
3. ✅ Persistencia de consentimiento (`ConsentTable` DynamoDB + TTL).
4. ✅ Contrato de Kapso confirmado (webhook firmado nativo + envío por número).
5. ✅ KMS + routing token implementado. **Para el E2E real: activarlo** con
   `-c antiscambot:enableRoutingToken=true` (porque el envío requiere el número).
6. ✅ Deploy dev documentado (`scripts/deploy-dev.sh`).
7. ⏳ Prueba E2E real (desplegar con routing token activado y probar con Kapso).

Pendiente fuera de este frente: persistencia de análisis (DynamoDB + idempotencia
por `messageId`), puerto `AnalysisPipeline` (Strands + Bedrock), budgets.
