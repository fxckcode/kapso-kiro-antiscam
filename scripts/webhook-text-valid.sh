#!/usr/bin/env bash
# Mensaje de texto valido. Primer envio de un usuario nuevo -> deberia recibir
# onboarding (200, status "onboarding_sent"). Si el usuario ya dio consentimiento,
# el evento se encola (200, status "accepted").
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

read -r -d '' BODY <<'JSON' || true
{
  "entry": [
    {
      "changes": [
        {
          "value": {
            "conversation_id": "conv-demo-1",
            "messages": [
              {
                "id": "wamid.text.1",
                "from": "+5491100000000",
                "type": "text",
                "text": { "body": "Hola, me llego este mensaje raro de mi banco" }
              }
            ]
          }
        }
      ]
    }
  ]
}
JSON

post_signed "$BODY"
