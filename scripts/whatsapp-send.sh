#!/usr/bin/env bash
# Prueba directa del envio saliente por Kapso (sin pasar por el webhook).
# Util para validar credenciales y el contrato de envio de Kapso.
#
# Variables:
#   KAPSO_API_BASE_URL    ej. https://api.kapso.ai/meta/whatsapp/v24.0
#   KAPSO_API_KEY         API key de Kapso (Integrations -> API keys)
#   KAPSO_PHONE_NUMBER_ID id del numero (requerido por el endpoint Meta de Kapso)
#   TO                    destino (telefono E.164, ej. 5491100000000)
set -euo pipefail

: "${KAPSO_API_BASE_URL:?falta KAPSO_API_BASE_URL}"
: "${KAPSO_API_KEY:?falta KAPSO_API_KEY}"
: "${KAPSO_PHONE_NUMBER_ID:?falta KAPSO_PHONE_NUMBER_ID}"
TO="${TO:-5491100000000}"

BASE="${KAPSO_API_BASE_URL%/}"
URL="${BASE}/${KAPSO_PHONE_NUMBER_ID}/messages"

BODY=$(printf '{"messaging_product":"whatsapp","to":"%s","type":"text","text":{"body":"Prueba de envio AntiScamBot"}}' "$TO")

echo ">> POST ${URL}"
curl -sS -i -X POST "$URL" \
  -H 'content-type: application/json' \
  -H "X-API-Key: ${KAPSO_API_KEY}" \
  --data "$BODY"
echo
