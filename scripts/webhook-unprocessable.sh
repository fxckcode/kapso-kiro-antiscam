#!/usr/bin/env bash
# Payload valido pero NO procesable: evento de status (entregado/leido).
# Debe responder 200 rapido con status "ignored", sin encolar.
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
            "statuses": [
              { "id": "wamid.text.1", "status": "delivered", "recipient_id": "5491100000000" }
            ]
          }
        }
      ]
    }
  ]
}
JSON

post_signed "$BODY"
