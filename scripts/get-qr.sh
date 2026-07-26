#!/usr/bin/env bash
# Obtiene el QR / estado de vinculacion de Kapso.
#
# Variables:
#   KAPSO_API_BASE_URL   ej. https://api.kapso.example/v1
#   KAPSO_API_KEY        API key
#   KAPSO_QR_PATH        ruta del endpoint (default: /qr)
#
# ⚠️ El endpoint real de Kapso es un PENDIENTE: ajustar KAPSO_QR_PATH cuando se
# confirme el contrato. Para probar sin red, usa el modo mock en el código
# (KAPSO_QR_MOCK=true) o el test test/kapso/qr.test.ts.
set -euo pipefail

: "${KAPSO_API_BASE_URL:?falta KAPSO_API_BASE_URL}"
: "${KAPSO_API_KEY:?falta KAPSO_API_KEY}"
QR_PATH="${KAPSO_QR_PATH:-/qr}"
BASE="${KAPSO_API_BASE_URL%/}"

echo ">> GET ${BASE}${QR_PATH}"
curl -sS -i "${BASE}${QR_PATH}" -H "X-API-Key: ${KAPSO_API_KEY}"
echo
