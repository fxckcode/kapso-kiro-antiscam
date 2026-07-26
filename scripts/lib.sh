#!/usr/bin/env bash
# Utilidades compartidas para los scripts de prueba del webhook.
#
# Variables de entorno:
#   WEBHOOK_URL           URL del endpoint (default: http://localhost:3000/webhook)
#   KAPSO_WEBHOOK_SECRET  Secreto para firmar el body (default: replace-me)
#
# Requiere: curl y openssl.
set -euo pipefail

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000/webhook}"
KAPSO_WEBHOOK_SECRET="${KAPSO_WEBHOOK_SECRET:-replace-me}"

# Firma el body con HMAC-SHA256 y devuelve "sha256=<hex>".
sign_body() {
  local body="$1"
  local hex
  hex="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$KAPSO_WEBHOOK_SECRET" | sed 's/^.*= *//')"
  printf 'sha256=%s' "$hex"
}

# Envia un POST firmado al webhook. Uso: post_signed "<json>"
post_signed() {
  local body="$1"
  local signature
  signature="$(sign_body "$body")"
  echo ">> POST ${WEBHOOK_URL}"
  curl -sS -i -X POST "$WEBHOOK_URL" \
    -H 'content-type: application/json' \
    -H "x-hub-signature-256: ${signature}" \
    --data "$body"
  echo
}

# Envia un POST con firma invalida (para probar 401). Uso: post_unsigned "<json>"
post_bad_signature() {
  local body="$1"
  echo ">> POST ${WEBHOOK_URL} (firma invalida)"
  curl -sS -i -X POST "$WEBHOOK_URL" \
    -H 'content-type: application/json' \
    -H 'x-hub-signature-256: sha256=deadbeef' \
    --data "$body"
  echo
}
