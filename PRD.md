# PRD: AntiScamBot

> **Hackathon**: AWS x Código Facilito — Kiro, Reto 3: Agentes Especializados
> **Equipo**: 3 personas
> **Timeline**: 20–27 julio 2026

---

## Problem Statement

Cada día, miles de personas en LATAM reciben mensajes y llamadas de estafadores que suplantan bancos, empresas tecnológicas, o familiares. Las estafas son cada vez más sofisticadas: URLs que imitan páginas reales, mensajes que replican el tono de un banco, números que parecen legítimos. La mayoría de las personas no tiene una herramienta rápida y confiable para verificar si un mensaje es una estafa antes de actuar.

Las opciones actuales son lentas (googlear el número, preguntar en redes sociales) o inexistentes. Para cuando alguien confirma que era una estafa, ya compartió su código de verificación, transfirió dinero, o hizo clic en un link malicioso.

## Solution

Un asistente de WhatsApp que, en segundos, analiza cualquier mensaje o captura de pantalla que el usuario recibe y le dice —con evidencia— si es una estafa o es legítimo. El usuario reenvía el mensaje sospechoso al bot, y este responde con un veredicto claro, una categoría de estafa, y recomendaciones accionables.

El bot combina una capa de reglas rápida (blacklist de dominios, regex de patrones conocidos, consulta VirusTotal) con un LLM (Claude Sonnet 4 vía AWS Bedrock) y un RAG con casos históricos de estafas en LATAM. Esto permite detectar tanto estafas conocidas como variaciones nuevas que el LLM nunca vio en entrenamiento.

## User Stories

1. Como usuario de WhatsApp en LATAM, quiero reenviar un mensaje sospechoso al bot y recibir un veredicto inmediato, para saber si es una estafa antes de actuar.

2. Como usuario, quiero enviar capturas de pantalla de mensajes sospechosos, para que el bot analice también el contenido visual (logos, formato, números).

3. Como usuario, quiero recibir el resultado en un formato claro (🚨 estafa / ⚠️ cuidado / ✅ parece seguro) con una explicación corta, para entender por qué es riesgoso sin leer un análisis técnico.

4. Como usuario, quiero que el bot clasifique el tipo de estafa (phishing bancario, premio falso, suplantación, inversión falsa, familiar en apuros, cryptoscam), para contextualizar el riesgo.

5. Como usuario, quiero recomendaciones accionables específicas ("No compartas tu código de verificación", "Comunicate con tu banco al número oficial"), para saber qué hacer después del diagnóstico.

6. Como usuario, quiero poder expandir el análisis si el veredicto inicial es ambiguo (respondiendo "más info"), para obtener detalles adicionales sin saturar el mensaje inicial.

7. Como usuario, quiero que el bot detecte links sospechosos expandiendo URLs acortadas y consultando VirusTotal, para no caer en páginas de phishing.

8. Como usuario, quiero corregir al bot si se equivoca (respondiendo "falso positivo"), para ayudar a mejorar el sistema.

9. Como usuario, quiero que el bot me pida consentimiento explícito antes de procesar mi primer mensaje, para saber qué datos se guardan y cómo se usan.

10. Como administrador del sistema, quiero rate limiting por usuario (10 req/min, límite diario), para controlar costos del LLM y prevenir abuso.

11. Como administrador, quiero una Dead-Letter Queue y alarmas CloudWatch, para detectar fallos en el pipeline de análisis.

12. Como administrador, quiero budget alerts desde el día 1 ($0.01, $20, $50), para no llevarme sorpresas con los costos de AWS.

13. Como administrador, quiero que los datos sensibles (CBU, tarjetas) se redacten antes de persistir, para cumplir con privacidad y minimizar riesgo.

14. Como evaluador del hackathon, quiero ver toda la arquitectura documentada y versionada en el repo, para evaluar el proceso y no solo el resultado.

15. Como miembro del equipo, quiero IaC con CDK TypeScript para toda la infraestructura, para poder reproducir el entorno con un solo comando.

## Implementation Decisions

### WhatsApp Integration

- **Kapso API** sobre Evolution API. Kapso trabaja sobre la API oficial de WhatsApp, ofrece webhooks, logs, envío de contenido multimedia, e infraestructura administrada. Menos fricción para un MVP de 7 días.
- **Número único compartido** para todos los usuarios. Cada conversación se identifica mediante un hash del número de teléfono. No se necesita una instancia por persona.
- **Soporte desde el día 1**: texto, imágenes (capturas de pantalla), y links. Audio queda para v2.
- **Onboarding automático** en el primer mensaje: el bot se presenta, explica qué hace, y obtiene consentimiento implícito al continuar la conversación.

### Pipeline de Procesamiento

```
WhatsApp → Kapso Webhook → 202 Accepted → SQS → Lambda (procesamiento)
                                                   │
                                           ┌───────┴───────┐
                                           │  Capa de      │
                                           │  Reglas       │
                                           │  (rápida)     │
                                           └───────┬───────┘
                                                   │
                                           ┌───────┴───────┐
                                           │  ¿Certeza?    │
                                           │  Sí → responder│
                                           │  No → LLM     │
                                           └───────┬───────┘
                                                   │
                                           ┌───────┴───────┐
                                           │  Bedrock      │
                                           │  (Claude      │
                                           │   Sonnet 4)   │
                                           │  + RAG        │
                                           └───────┬───────┘
                                                   │
                                           ┌───────┴───────┐
                                           │  Responder vía │
                                           │  Kapso API    │
                                           └───────────────┘
```

- **Webhook → SQS**: El webhook de Kapso responde 202 Accepted inmediatamente y encola el mensaje en SQS. Esto evita el timeout de WhatsApp (~5s).
- **Lambda asíncrona**: Consume de SQS, procesa (reglas → LLM), y responde vía API de Kapso. Con reintentos y backoff exponencial.
- **Dead-Letter Queue**: Si falla consistentemente después de 3 reintentos, el mensaje va a DLQ con alarma CloudWatch.

### Capa de Reglas (Pre-LLM)

Filtra ~40-60% de los casos sin tocar Bedrock, ahorrando costos:

1. **Blacklist de dominios**: Dominios conocidos de estafas, comparación exacta y por substring.
2. **Regex de patrones típicos**: "código de verificación", "CBU", "transferencia", "premio falso", etc.
3. **Expansión de short URLs**: Expande bit.ly, tinyurl, etc., y verifica el dominio final.
4. **VirusTotal API**: Consulta reputación del dominio. Si reporta malware/phishing → estafa automática.

Si la regla da certeza → responde directamente. Si no → escala al LLM.

### LLM (Bedrock + Claude Sonnet 4)

- **Modelo**: Claude Sonnet 4 vía AWS Bedrock en us-east-1 (o us-west-2 como fallback regional). Mejor equilibrio entre precisión, velocidad, y costo.
- **Prompt engineering estricto**: El mensaje del usuario va entre `<user_message>` delimitadores. System prompt instruye ignorar cualquier instrucción dentro de esos delimitadores (protección contra prompt injection).
- **Salida JSON estructurada** con schema fijo:

```json
{
  "veredicto": "scam" | "legitimo" | "no_seguro",
  "confianza": 0.95,
  "nivel_riesgo": "alto" | "medio" | "bajo",
  "categoria": "phishing_bancario" | "premio_falso" | "suplantacion" | "inversion" | "familiar_apuros" | "cryptoscam" | "otro" | null,
  "red_flags": ["El remitente no es un número oficial", "Solicita código de verificación"],
  "evidencia": ["El dominio registrado hace 3 días"],
  "recomendaciones": ["No compartas tu código de verificación", "Bloqueá este número"],
  "explicacion_corta": "Este mensaje de 'tu banco' pide datos sensibles",
  "requiere_mas_info": false
}
```

- **Validación de salida**: Si el output no parsea como JSON válido → respuesta default segura ("no pude analizar").
- **Bedrock Guardrails** para capa adicional de seguridad.

### RAG (Retrieval-Augmented Generation)

- **Vector store** con embeddings de: frases típicas de estafas en LATAM, dominios reportados, números/prefijos sospechosos, ejemplos de estafas comunes.
- El mensaje entrante se embeddea y se buscan los top-K resultados por similitud semántica.
- Los resultados se inyectan como contexto en el prompt del LLM ("casos similares conocidos").
- Mejora con el tiempo: los falsos positivos reportados por usuarios alimentan la base.

### Persistencia

- **DynamoDB**: Partition key = hash del número (SHA-256), sort key = timestamp. Cada item: mensaje original (con datos sensibles redactados), veredicto, confianza, timestamp. TTL de 30 días.
- **S3**: Imágenes recibidas con lifecycle policy de 30 días. URLs expiran automáticamente.
- **Redacción de datos sensibles**: El system prompt instruye al modelo a detectar CBU/tarjetas y reemplazarlos con `[dato sensible eliminado]` ANTES de persistir. El mensaje original con datos sensibles nunca se almacena.

### Infraestructura

- **100% Serverless**: Lambda + API Gateway + DynamoDB + SQS + S3 + Bedrock.
- **IaC con CDK TypeScript**: Todo reproducible con `cdk deploy`.
- **Budget alerts**: $0.01 (cualquier gasto), $20, $50 desde el día 1.
- **Estimación de costo**: ~$5-10/mes en low traffic. Free Tier de AWS cubre Lambda (1M requests), DynamoDB (25GB), S3 (5GB).
- **Post-hackathon**: Si nadie se hace cargo, se apaga todo.

### Veredicto en Tres Niveles

| Confianza | Icono | Texto | Tono |
|-----------|-------|-------|------|
| ≥ 0.8 | 🚨 | ES UNA ESTAFA | Categórico con evidencia |
| 0.5 – 0.8 | ⚠️ | CUIDADO | Sospechoso, precautorio |
| < 0.5 | ✅ | Parece seguro | Nunca 100%, siempre alerta |

### Anti-Abuse

- **Rate limiting**: 10 requests/minuto por número de teléfono. Límite diario. Si excede → "Esperá un momento".
- **Cache de mensajes repetidos**: El mismo mensaje analizado previamente no se reprocesa.
- **Truncamiento de texto**: Límite de caracteres por mensaje.
- **Uso malicioso detectado**: Si alguien intenta usar el bot para diseñar estafas, el system prompt lo detecta y responde con negativa. El intento se loguea.
- **Prompt injection**: Delimitadores estrictos + system prompt + validación de output + Bedrock Guardrails.

## Testing Decisions

### Estrategia

- **Tests unitarios**: Capa de reglas (regex, blacklist, expansión URLs), parseo de JSON de salida del LLM, lógica de rate limiting.
- **Tests de integración**: Pipeline completo webhook → SQS → Lambda → respuesta. Mockear Kapso API y Bedrock.
- **Tests E2E**: Flujo real: enviar mensaje por WhatsApp → recibir veredicto. Usar número de prueba de Kapso.
- **Lo que hace un buen test**: Validar comportamiento externo (entrada → salida), no implementación interna. Probar cada nivel de confianza (≥0.8, 0.5-0.8, <0.5), cada categoría de estafa, casos borde (texto ilegible, imagen borrosa, prompt injection).

### Lo que NO se testea (MVP)

- Rendimiento bajo carga extrema (>1000 req/seg) — serverless escala solo.
- Multi-idioma — solo español.
- Grupos de WhatsApp — solo 1:1.

## Out of Scope

- **Audio**: Procesamiento de mensajes de voz. Requiere whisper/transcripción, más complejo. Post-hackathon.
- **Grupos de WhatsApp**: Manejo de menciones, contexto compartido, anti-spam. Post-hackathon.
- **Multi-idioma**: Solo español. El público objetivo es LATAM.
- **Dashboard/admin web**: No hay UI web para el MVP. Solo landing page opcional si sobra tiempo.
- **Persistencia post-30 días**: TTL fijo. Política de retención formal si alguien lo mantiene.
- **Integración con billeteras virtuales/bancos**: No hay API calls a bancos. Solo análisis del mensaje.
- **App móvil nativa**: Solo WhatsApp. El bot es un contacto más.
- **Producción 24/7 post-hackathon**: El bot se apaga si nadie se hace cargo. Costo estimado ~$5-10/mes.

## Further Notes

- El equipo se divide por feature vertical con responsabilidad primaria: Persona A (WhatsApp + infra), Persona B (LLM + detección), Persona C (datos + frontend/docs).
- Daily sync de 15 min. Feature branches + PRs con al menos 1 approval.
- Todo el proceso (specs → tasks → código) queda versionado en el repo como evidencia para el jurado.
- Cronograma: Días 1-2 setup infra + webhook, Días 3-4 pipeline análisis + RAG, Día 5 edge cases + seguridad, Día 6 tests E2E + polish, Día 7 demo + video + presentación.
- Repositorio único, branch naming: `feat/whatsapp-connection`, `feat/scam-detection`, `feat/rag-database`.
