# Project Structure

Monorepo-style layout. The root holds planning/documentation; `landing/` holds the only implemented code today.

```
kiro-hact/
├── .kiro/
│   └── steering/            # These guidance files
├── PRD.md                   # Product requirements (backend architecture + decisions)
├── UBIQUITOUS_LANGUAGE.md   # DDD glossary — source of truth for domain terms
├── SITEMAP.md               # Landing page sitemap
├── TASKS.md                 # Task breakdown
├── README.md                # Landing page docs
└── landing/                 # Next.js landing page (implemented)
```

## Root documentation

- **PRD.md** — the canonical spec for the WhatsApp bot: problem, solution, pipeline, rules layer, LLM/RAG design, infra, testing, scope. Read this before working on backend features.
- **UBIQUITOUS_LANGUAGE.md** — domain glossary. Use these terms consistently in code, comments, and specs.
- Note: some docs have duplicated variants (`SITEMAP (1).md`, `TASKS (1).md`). Prefer the non-suffixed files unless told otherwise.

## Landing page (`landing/`)

Next.js App Router. Single-page, mobile-first, section-based landing.

```
landing/
├── app/
│   ├── layout.tsx     # SEO/OpenGraph metadata, lang="es", fonts
│   ├── page.tsx       # Composes the landing sections
│   ├── globals.css    # Base styles + Tailwind directives
│   └── icon.svg       # Favicon (shield)
├── components/        # One component per landing section
│   ├── Header.tsx        # Sticky nav + mobile menu
│   ├── Hero.tsx          # Hero + SVG/CSS illustration
│   ├── Steps.tsx         # 3 usage steps
│   ├── HowItWorks.tsx    # Bot internal flow (#como-funciona)
│   ├── TryIt.tsx         # QR + WhatsApp CTA (#probalo)
│   ├── Privacy.tsx       # Privacy cards (#privacidad)
│   ├── Footer.tsx        # GitHub link + disclaimer
│   └── WhatsAppQR.tsx    # Dynamic QR (qrcode.react)
├── lib/
│   └── config.ts      # Public config + buildWhatsAppLink helper
├── package.json
├── tailwind.config.ts
└── tsconfig.json
```

### Landing conventions

- One React component per landing section, named after its purpose, in `components/`.
- Section anchors are in Spanish (`#como-funciona`, `#probalo`, `#privacidad`) — keep nav links and section IDs in sync.
- Read all public config from `lib/config.ts`; never hardcode the WhatsApp number or repo URL in components.
- User-facing copy is in **Spanish**. Keep it mobile-first and accessible.

## Backend (when created)

Not yet scaffolded. Per PRD, use AWS CDK (TypeScript) for IaC and organize by feature vertical:
- `feat/whatsapp-connection` — Kapso webhook + infra
- `feat/scam-detection` — rules layer + LLM pipeline
- `feat/rag-database` — vector store + RAG

## Git conventions

- Feature branches with descriptive `feat/...` names.
- PRs require at least one approval.
- Keep the full process (specs → tasks → code) versioned as hackathon evidence.
