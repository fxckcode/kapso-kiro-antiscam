# Ubiquitous Language — AntiScamBot

> Glosario DDD del dominio de detección de estafas en LATAM.
> Proyecto: Hackathon AWS x Código Facilito — Kiro, Reto 3.

---

## Actores

| Término | Definición | Aliases a evitar |
|---------|-----------|-----------------|
| **Usuario** | Persona que usa WhatsApp y envía mensajes al bot para verificar si son estafa | Víctima, destinatario, afectado |
| **Estafador** | Persona o entidad que envía mensajes fraudulentos con intención de engañar | Scammer, delincuente, atacante |
| **Bot** | Asistente automatizado en WhatsApp que analiza mensajes y responde con veredictos | AntiScamBot, asistente, el sistema |

## Mensajes y Contenido

| Término | Definición | Aliases a evitar |
|---------|-----------|-----------------|
| **Mensaje** | Texto enviado por el usuario al bot para análisis | Consulta, reporte, input |
| **Captura** | Imagen (screenshot) que el usuario envía al bot para análisis | Screenshot, foto, imagen de estafa |
| **Link** | URL incluida en un mensaje que requiere verificación de reputación | Enlace, URL, link sospechoso |
| **Mensaje original** | Versión del mensaje recibido con datos sensibles ya redactados antes de persistir | Mensaje crudo, raw message |
| **Dato sensible** | Información personal o financiera (CBU, tarjetas, DNI) que debe redactarse antes de almacenar | PII, secreto, credencial |

## Procesamiento

| Término | Definición | Aliases a evitar |
|---------|-----------|-----------------|
| **Análisis** | Proceso completo de evaluar un mensaje (reglas + LLM + RAG) para determinar si es estafa | Procesamiento, revisión, escaneo |
| **Regla** | Condición determinística (blacklist, regex, VirusTotal) que clasifica un mensaje sin usar el LLM | Heurística, filtro, checker |
| **Veredicto** | Resultado del análisis: scam, legítimo, o no_seguro | Decisión, diagnóstico, resultado |
| **Confianza** | Valor numérico (0.0–1.0) que indica qué tan seguro está el bot de su veredicto | Score, probabilidad, certeza |
| **Nivel de riesgo** | Categoría derivada de la confianza: alto, medio, bajo | Severidad, peligrosidad |
| **Evidencia** | Lista de razones concretas que sustentan el veredicto | Fundamentos, argumentos, prueba |
| **Recomendación** | Acción específica que el bot sugiere al usuario ante una estafa | Consejo, instructivo, paso a seguir |

## Categorías de Estafa

| Término | Definición | Aliases a evitar |
|---------|-----------|-----------------|
| **Phishing bancario** | Mensaje que suplanta a un banco o billetera virtual para robar credenciales | Phishing, estafa bancaria, suplantación de banco |
| **Premio falso** | Mensaje que informa al usuario que ganó un sorteo o herencia para obtener datos o dinero | Sorteo falso, herencia falsa, lottery scam |
| **Suplantación** | Mensaje que se hace pasar por una empresa tecnológica, soporte de cuenta, o servicio | Impersonation, soporte falso, suplantación de identidad corporativa |
| **Inversión falsa** | Oferta de inversión con rendimientos irreales (cryptoscams, pyramid schemes) | Esquema Ponzi, crypto scam, inversión milagrosa |
| **Familiar en apuros** | Mensaje que suplanta a un familiar pidiendo ayuda urgente con transferencia | Emergencia falsa, familiar en peligro, estafa del secuestro virtual |
| **URL maliciosa** | Link que dirige a una página de phishing, malware o formulario falso | Phishing link, web falsa, página de login falsa |

## Infraestructura

| Término | Definición | Aliases a evitar |
|---------|-----------|-----------------|
| **Webhook** | Endpoint HTTP que recibe mensajes entrantes desde Kapso | Callback, endpoint de entrada |
| **Cola** | SQS Queue que bufferiza mensajes pendientes de procesar | Buffer, SQS, message queue |
| **Pipeline** | Secuencia completa de procesamiento: preprocesar → reglas → RAG → LLM → postprocesar → responder | Flujo, cadena de procesamiento |
| **Capa de reglas** | Conjunto de reglas determinísticas que se ejecutan ANTES del LLM para filtrar casos claros | Pre-filtro, rule engine, fast path |
| **Historial** | Registro persistente en DynamoDB de mensajes analizados con sus veredictos | Log, registro, historial de análisis |

## Interacciones

| Término | Definición | Aliases a evitar |
|---------|-----------|-----------------|
| **Onboarding** | Mensaje inicial del bot presentándose y obteniendo consentimiento implícito | Bienvenida, primer mensaje, registro |
| **Falso positivo** | Cuando el usuario corrige al bot indicando que un mensaje marcado como estafa no lo era | Corrección, error del bot, false positive |
| **Veredicto corto** | Respuesta inicial del bot con una línea de diagnóstico + recomendación | Resumen, respuesta rápida |
| **Vista expandida** | Respuesta detallada que el bot da cuando el usuario pide "más info" | Detalle, análisis completo, expandir |

## Relaciones

- Un **Usuario** envía uno o más **Mensajes** al **Bot**
- Un **Mensaje** puede contener cero o más **Capturas** y cero o más **Links**
- Un **Mensaje** produce exactamente un **Veredicto** con una **Confianza** asociada
- Un **Veredicto** tiene exactamente una **Categoría de estafa** (o `otro`)
- Un **Veredicto** incluye cero o más **Evidencias** y cero o más **Recomendaciones**
- Un **Mensaje** puede ser procesado por la **Capa de reglas** (fast path) O por el **Pipeline** completo (slow path), no ambos
- Un **Usuario** puede reportar un **Falso positivo** por cada **Mensaje** analizado
- Un **Historial** contiene todos los **Mensajes** de un **Usuario** ordenados por timestamp

## Reglas de negocio destacadas

- Si la **Confianza** ≥ 0.8 → veredicto `scam` (🚨). Si está entre 0.5 y 0.8 → `no_seguro` (⚠️). Si es < 0.5 → `legitimo` (✅) con advertencia precautoria.
- El **Mensaje original** nunca se persiste con **Datos sensibles**. Se redactan antes de almacenar.
- Los **Falsos positivos** se registran pero no retroalimentan automáticamente el **RAG** en el MVP (se revisan post-hackathon).
- El **Rate limiting** se aplica por **Usuario**: 10 **Mensajes** por minuto y un límite diario.
- El **Onboarding** ocurre una sola vez por **Usuario**. Se detecta porque el **Historial** no tiene registros previos.

## Ambigüedades flagged

- **"Estafa"** se usa tanto para el mensaje fraudulento como para la categoría. En el dominio, "estafa" es el concepto general; los tipos específicos son las **Categorías de estafa** (phishing bancario, premio falso, etc.).
- **"Análisis"** vs **"procesamiento"**: "procesamiento" es el término técnico (lo que hace el pipeline); "análisis" es el término de dominio (lo que percibe el usuario). Usar **Análisis** en la comunicación con usuarios y **Pipeline** en la técnica.
- **"Reporte"** puede confundirse con "falso positivo". El usuario no "reporta" estafas, envía **Mensajes** para **Análisis**. Si corrige el veredicto, es un **Falso positivo**.

## Ejemplo de diálogo

> **Dev:** "Cuando el **Usuario** nos envía un **Mensaje** con un **Link**, ¿el **Pipeline** siempre pasa por la **Capa de reglas** antes de tocar el LLM?"

> **Domain expert:** "Sí. La **Capa de reglas** chequea primero: si el **Link** está en la blacklist o el patrón del mensaje dispara una **Regla**, respondemos directo sin invocar Bedrock. Solo los casos sin certeza escalan al **Pipeline** completo."

> **Dev:** "Y si el **Usuario** manda una **Captura** en vez de texto, ¿cambia algo?"

> **Domain expert:** "La **Captura** no pasa por regex porque no hay texto estructurado. Va directo al LLM con el contexto visual. El **Veredicto** se genera igual, pero el **Nivel de riesgo** puede ser más conservador porque hay menos **Evidencia** estructurada."

> **Dev:** "Si el **Usuario** responde 'falso positivo', ¿el **Bot** usa esa corrección para mejorar futuros análisis del mismo tipo de **Mensaje**?"

> **Domain expert:** "En el MVP no — solo lo registramos en el **Historial** con `usuarioCorrigio: true`. La retroalimentación al **RAG** es post-hackathon. Pero el dato queda para revisión manual."
