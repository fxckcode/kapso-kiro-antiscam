#!/usr/bin/env bash
# Despliega el stack dev de AntiScamBot.
# Requiere: AWS CLI configurado, credenciales con permisos y `cdk bootstrap` hecho.
set -euo pipefail
cd "$(dirname "$0")/.."   # raiz del repo

STACK="${STACK_NAME:-AntiScamBotStack}"

echo ">> 1/4 build backend (tsc)"
npm run build

echo ">> 2/4 test backend"
npm test

echo ">> 3/4 install infra deps"
(cd infra && npm install)

echo ">> 4/4 cdk deploy ${STACK}"
(cd infra && npx cdk deploy "${STACK}" --require-approval never --outputs-file cdk-outputs.json)

echo
echo "OK. Outputs en infra/cdk-outputs.json"
echo "URL del webhook:"
(cd infra && node -e "const o=require('./cdk-outputs.json'); const s=Object.values(o)[0]||{}; console.log(s.WebhookUrl||'(no WebhookUrl)')")
