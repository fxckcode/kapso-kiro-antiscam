/**
 * Sanitizador local de demo para la frontera SQS. No resuelve DNS ni abre
 * conexiones: el servicio PR-04 vuelve a validar SSRF antes de hacer red.
 */
import type { SanitizedUrl, UrlSanitizer } from '../ports/url';

const BLOCKED_HOSTNAMES = new Set<string>([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
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

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username.length > 0 || url.password.length > 0) return null;

    const host = url.hostname.toLowerCase();
    if (
      host.length === 0 ||
      BLOCKED_HOSTNAMES.has(host) ||
      host.endsWith('.localhost') ||
      isPrivateOrReservedIp(host)
    ) {
      return null;
    }
    if (hasEncodedDelimiter(url.pathname)) return null;

    // Detectar tracking params ANTES de limpiar la URL
    const searchParams = url.searchParams;
    const hasTracking = Array.from(searchParams.entries()).some(
      ([key]) => /^utm_|gclid|fbclid|qclid|gad_source|gad_campaignid/.test(key),
    );

    url.search = '';
    url.hash = '';
    return { reputationUrl: url.toString(), hasTrackingParams: hasTracking };
  }
}

/** Bloquea literales IPv4 no publicos y todo IPv6 en este adaptador sin DNS. */
function isPrivateOrReservedIp(host: string): boolean {
  if (host.includes(':')) return true;

  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;

  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/** Inspeccion limitada a dos decodificaciones; nunca se usa para navegar. */
function hasEncodedDelimiter(pathname: string): boolean {
  let value = pathname;
  for (let pass = 0; pass < 2; pass += 1) {
    if (/%(?:3f|3d|23|40)/i.test(value)) return true;
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) return false;
      value = decoded;
    } catch {
      return true;
    }
  }
  return /[?=#@]/.test(value);
}
