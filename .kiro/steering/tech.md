# Tech Stack

The repo has two sides: a **planned serverless backend** (the WhatsApp bot) and an **implemented landing page**. Only the landing page currently exists as code.

## Backend (planned — see PRD.md)

- **Runtime**: AWS Lambda (async, consumes from SQS)
- **Language**: TypeScript
- **IaC**: AWS CDK (TypeScript) — everything reproducible via `cdk deploy`
- **Services**: API Gateway, SQS (+ Dead-Letter Queue), DynamoDB, S3, Amazon Bedrock
- **LLM**: Claude Sonnet 4 via Bedrock (`us-east-1`, fallback `us-west-2`) with Bedrock Guardrails
- **WhatsApp**: Kapso API (official WhatsApp API); single shared number, users identified by SHA-256 hash of phone number
- **External APIs**: VirusTotal (domain reputation)
- **Pattern**: 100% serverless. Webhook returns `202 Accepted` immediately, enqueues to SQS to avoid WhatsApp's ~5s timeout; Lambda processes with retries + exponential backoff.

### Persistence conventions
- **DynamoDB**: partition key = SHA-256 hash of phone number, sort key = timestamp. 30-day TTL.
- **S3**: received images, 30-day lifecycle policy, expiring URLs.
- Redact sensitive data (CBU, cards, DNI) **before** persisting — never store raw sensitive data.

### LLM output contract
The LLM must return structured JSON with a fixed schema (`veredicto`, `confianza`, `nivel_riesgo`, `categoria`, `red_flags`, `evidencia`, `recomendaciones`, `explicacion_corta`, `requiere_mas_info`). If output does not parse as valid JSON, fall back to a safe default response. Wrap user input in `<user_message>` delimiters and instruct the system prompt to ignore any instructions inside them.

## Landing page (implemented — `landing/`)

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript (strict mode)
- **UI**: React 18, Tailwind CSS 3
- **Icons**: `lucide-react`
- **QR**: `qrcode.react`
- **Deploy**: Vercel (root directory `landing`)
- **Node**: 18.18+
- Path alias: `@/*` maps to the `landing/` root.
- Public env vars use the `NEXT_PUBLIC_` prefix and fall back to safe placeholders (see `landing/lib/config.ts`).

### Common commands (run inside `landing/`)

```bash
npm install       # install deps
npm run dev       # local dev server at http://localhost:3000
npm run build     # production build
npm run start     # serve the production build
npm run lint      # ESLint (next lint)
```

> On Windows/cmd, do not chain long-running commands (`npm run dev`, `npm run start`) — run them in a dedicated terminal.

## Tailwind theme

Custom color palettes: `brand` (green, trust/success), `trust` (blue), `alert` (orange + `alert-danger` red). Custom animations: `fade-up`, `float`.
