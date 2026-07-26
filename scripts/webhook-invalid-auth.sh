#!/usr/bin/env bash
# Firma invalida: debe responder 401 "unauthorized" y no procesar nada.
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
              { "id": "wamid.x", "from": "+5491100000000", "type": "text", "text": { "body": "hola" } }
            ]
          }
        }
      ]
    }
  ]
}
JSON

post_bad_signature "$BODY"
