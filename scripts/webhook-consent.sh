#!/usr/bin/env bash
# Envia "ACEPTO" para otorgar consentimiento (200, status "consent_granted").
# Ejecutar ANTES de webhook-with-url.sh para que el mensaje se encole.
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
                "id": "wamid.consent.1",
                "from": "+5491100000000",
                "type": "text",
                "text": { "body": "ACEPTO" }
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
