# Product

**AntiScamBot** is a WhatsApp assistant that helps people in LATAM detect scams. A user forwards a suspicious message, screenshot, or link to the bot and receives a fast, evidence-backed verdict with actionable recommendations, all in Spanish.

Built as a 7-day hackathon MVP (AWS x Código Facilito — Kiro, Reto 3).

## How it works

The bot combines a fast deterministic rules layer (domain blacklist, regex patterns, short-URL expansion, VirusTotal) with an LLM (Claude Sonnet 4 via AWS Bedrock) and a RAG store of known LATAM scam cases. The rules layer resolves clear cases without invoking the LLM to save cost; ambiguous cases escalate to the full pipeline.

## Verdict model

Three levels driven by a confidence score (0.0–1.0):

| Confidence | Icon | Verdict |
|-----------|------|---------|
| ≥ 0.8 | 🚨 | `scam` — es una estafa |
| 0.5–0.8 | ⚠️ | `no_seguro` — cuidado |
| < 0.5 | ✅ | `legitimo` — parece seguro (never 100%) |

Verdicts are **orientational**, not banking, legal, or security advice.

## Key principles

- **Privacy first**: sensitive data (CBU, card numbers, DNI) is redacted before any persistence. The raw message with sensitive data is never stored. Data has a 30-day TTL.
- **Cost-conscious**: rules layer filters ~40–60% of cases; budget alerts from day 1; rate limiting per user (10 req/min + daily cap).
- **Security-aware**: strict prompt-injection defenses (delimiters, system prompt, output validation, Bedrock Guardrails).
- **Spanish only, 1:1 chats only** for the MVP.

## Domain language

This project uses a defined ubiquitous language (see `UBIQUITOUS_LANGUAGE.md`). Prefer domain terms in Spanish: **Usuario, Bot, Mensaje, Captura, Link, Veredicto, Confianza, Regla, Capa de reglas, Pipeline, Análisis, Falso positivo, Onboarding**. Use **Análisis** when communicating with users and **Pipeline** for technical/internal discussion.

## Out of scope (MVP)

Audio/voice, WhatsApp groups, multi-language, web admin dashboard, bank/wallet integrations, native mobile app, 24/7 production hosting.
