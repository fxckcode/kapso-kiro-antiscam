/**
 * Fallback local del puerto UrlSanitizer.
 *
 * Se usa SOLO si src/url aun no expone un sanitizador real. Aplica las
 * validaciones minimas de PRD §7: acepta solo HTTP/HTTPS y bloquea loopback,
 * rangos privados, localhost y el endpoint de metadata de AWS. NO expande
 * acortadores ni renderiza paginas (eso es responsabilidad del processor real).
 */
import type { UrlSanitizer, SanitizedUrl } from '../ports/url';

const BLOCKED_HOSTNAMES = new Set<string>([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata (IMDS)
  'metadata.google.internal',
]);

export class FallbackUrlSanitizer implements UrlSanitizer {
  sanitize(candidate: string): SanitizedUrl | null {
    let url: URL;
    try {
      url = new URL(candidate.trim());
    } catch {
      return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    const host = url.hostname.toLowerCase();
    if (host.length === 0 || BLOCKED_HOSTNAMES.has(host)) {
      return null;
    }
    if (isPrivateOrReservedIp(host)) {
      return null;
    }

    // Normaliza: quita fragmento, conserva query (puede ser relevante).
    url.hash = '';

    return { sanitizedUrl: url.toString(), domain: host };
  }
}

/** Detecta IPv4 en rangos privados/reservados y cualquier IPv6 (conservador). */
function isPrivateOrReservedIp(host: string): boolean {
  // IPv6 literal (llega entre corchetes en href, pero hostname los quita).
  if (host.includes(':')) {
    return true;
  }

  const parts = host.split('.');
  if (parts.length !== 4) {
    return false; // no es IPv4 -> es un dominio
  }

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false; // no es una IPv4 valida -> tratar como dominio
  }

  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 0) return true; // 0.0.0.0/8

  return false;
}
