#!/usr/bin/env bash
# Carga los valores reales en los secretos de Secrets Manager creados por el stack.
#
# Variables requeridas (los VALORES reales de los secretos):
#   KAPSO_WEBHOOK_SECRET_VALUE   secreto para validar la firma del webhook
#   USER_ID_HMAC_SECRET_VALUE    secreto HMAC para seudonimizar el telefono
#   KAPSO_API_KEY_VALUE          API key de Kapso
#
# Requiere AWS CLI configurado.
set -euo pipefail
STACK="${STACK_NAME:-AntiScamBotStack}"

: "${KAPSO_WEBHOOK_SECRET_VALUE:?falta KAPSO_WEBHOOK_SECRET_VALUE}"
: "${USER_ID_HMAC_SECRET_VALUE:?falta USER_ID_HMAC_SECRET_VALUE}"
: "${KAPSO_API_KEY_VALUE:?falta KAPSO_API_KEY_VALUE}"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

WEBHOOK_ARN="$(output WebhookSecretArn)"
HMAC_ARN="$(output UserIdHmacSecretArn)"
APIKEY_ARN="$(output KapsoApiKeyArn)"

echo ">> set KAPSO_WEBHOOK_SECRET"
aws secretsmanager put-secret-value --secret-id "$WEBHOOK_ARN" --secret-string "$KAPSO_WEBHOOK_SECRET_VALUE" >/dev/null

echo ">> set USER_ID_HMAC_SECRET"
aws secretsmanager put-secret-value --secret-id "$HMAC_ARN" --secret-string "$USER_ID_HMAC_SECRET_VALUE" >/dev/null

echo ">> set KAPSO_API_KEY"
aws secretsmanager put-secret-value --secret-id "$APIKEY_ARN" --secret-string "$KAPSO_API_KEY_VALUE" >/dev/null

echo "OK. Secretos actualizados."
