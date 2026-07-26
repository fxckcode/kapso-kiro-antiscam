# Scripts — AntiScamBot (frente Kapso)

Scripts para probar el webhook localmente y para el flujo de deploy dev.
Requieren `curl` y `openssl` (en Windows: Git Bash o WSL). Los de deploy además
requieren AWS CLI configurado.

## Probar el webhook (local o desplegado)

```bash
export WEBHOOK_URL="http://localhost:3000/webhook"   # o la URL de API Gateway
export KAPSO_WEBHOOK_SECRET="replace-me"             # mismo secreto que valida auth.ts
```

Los scripts firman el body con HMAC-SHA256 (`x-hub-signature-256`), igual que
valida `src/kapso/auth.ts`.

### Flujo de demo

```bash
./webhook-text-valid.sh      # usuario nuevo -> onboarding (no encola)
./webhook-consent.sh         # responde ACEPTO -> consentimiento "accepted"
./webhook-with-url.sh        # mensaje con enlace + OTP -> se encola redactado
```

### Casos de borde

```bash
./webhook-unprocessable.sh   # evento de status -> 200 "ignored" (no encola)
./webhook-invalid-auth.sh    # firma inválida -> 401 "unauthorized"
./webhook-image.sh           # imagen (stretch) -> se normaliza como media
```

## Deploy dev (E2E)

```bash
# 0) build + test locales
npm run build
npm test

# 1) desplegar el stack (build + test + cdk deploy)
./scripts/deploy-dev.sh                 # deja infra/cdk-outputs.json

# 2) cargar los valores reales de los secretos
export KAPSO_WEBHOOK_SECRET_VALUE="..."
export USER_ID_HMAC_SECRET_VALUE="..."
export KAPSO_API_KEY_VALUE="..."
./scripts/set-secrets.sh

# 3) obtener la URL del webhook
./scripts/get-webhook-url.sh
export WEBHOOK_URL="$(./scripts/get-webhook-url.sh)"
export KAPSO_WEBHOOK_SECRET="$KAPSO_WEBHOOK_SECRET_VALUE"

# 4) probar el flujo end-to-end
./scripts/webhook-consent.sh
./scripts/webhook-with-url.sh
```

Comandos equivalentes manuales:

```bash
npm run build
npm test
cd infra && npx cdk deploy AntiScamBotStack
```

## QR de Kapso

```bash
export KAPSO_API_BASE_URL="https://api.kapso.example/v1"
export KAPSO_API_KEY="..."
export KAPSO_QR_PATH="/qr"     # ajustar cuando se confirme el contrato de Kapso
./get-qr.sh
```

## Envío saliente directo por Kapso

```bash
TO="+5491100000000" ./whatsapp-send.sh
```

## Notas

- **Consentimiento**: en dev sin `CONSENT_TABLE_NAME` se usa el fallback en
  memoria (se pierde entre invocaciones frías). El stack define `ConsentTable`
  (DynamoDB) y setea `CONSENT_TABLE_NAME`, así que en dev desplegado persiste.
- **Routing token (KMS)**: desactivado por defecto. Para habilitarlo, desplegar
  con `-c antiscambot:enableRoutingToken=true`.
- **QR**: el endpoint real de Kapso es un pendiente; `KAPSO_QR_PATH` es
  configurable y hay modo mock (`KAPSO_QR_MOCK=true`) para pruebas sin red.
```
