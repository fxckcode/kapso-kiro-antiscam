/**
 * Logger estructurado y seguro.
 *
 * Reglas (PRD §10): los logs NUNCA incluyen payloads completos, contenido
 * crudo, telefonos, secretos ni URLs sospechosas completas. Este logger solo
 * acepta campos explicitos y aplica una lista de claves prohibidas como red de
 * seguridad; ante una clave sensible, elide el valor.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Claves cuyo valor jamas debe emitirse tal cual. */
const FORBIDDEN_KEYS = new Set<string>([
  'rawtext',
  'rawbody',
  'body',
  'text',
  'phone',
  'rawphone',
  'from',
  'secret',
  'apikey',
  'authorization',
  'signature',
  'token',
  'sanitizedurl',
  'url',
]);

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(
  minLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) || 'info',
): Logger {
  const threshold = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const record = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...sanitizeFields(fields),
    };
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

function sanitizeFields(fields: LogFields | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = FORBIDDEN_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}
