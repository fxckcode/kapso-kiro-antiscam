#!/usr/bin/env bash
# Imprime la URL del webhook desde los outputs del stack desplegado.
set -euo pipefail
STACK="${STACK_NAME:-AntiScamBotStack}"
aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" \
  --output text
