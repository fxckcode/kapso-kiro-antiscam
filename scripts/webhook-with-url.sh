#!/usr/bin/env bash
# Mensaje con enlace sospechoso y un OTP (para ver redaccion + sanitizacion de URL).
# Requiere consentimiento previo (correr webhook-consent.sh) para que se encole.
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
                "id": "wamid.url.1",
                "from": "+5491100000000",
                "type": "text",
                "text": { "body": "Tu cuenta fue bloqueada. Validá en https://banco-seguro-login.example/ingreso con tu codigo 483920" }
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
