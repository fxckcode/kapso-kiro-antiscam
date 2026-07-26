#!/usr/bin/env bash
# Mensaje de imagen (stretch). Se normaliza como media; el analisis de imagen
# no forma parte del MVP base. Requiere consentimiento previo para encolar.
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
                "id": "wamid.image.1",
                "from": "+5491100000000",
                "type": "image",
                "image": {
                  "id": "media-abc-123",
                  "mime_type": "image/jpeg",
                  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                  "caption": "me llego esta captura"
                }
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
