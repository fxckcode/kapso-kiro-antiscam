/**
 * Clasificacion de direcciones IP para la defensa SSRF. Codigo puro y sin red.
 *
 * Politica (PR04-01): solo se permiten destinos GLOBALMENTE ENRUTABLES. Por eso
 * se bloquean tambien rangos que no son "privados" en el sentido tradicional
 * (documentacion, benchmarking, asignaciones de protocolo IETF, broadcast): un
 * destino de reputacion legitimo nunca vive ahi, y permitirlos amplia la
 * superficie SSRF sin beneficio.
 *
 * La clasificacion IPv4 NO es textual: la direccion se valida y se convierte a
 * entero sin signo de 32 bits y se compara contra rangos CIDR. Ver prompt
 * maestro sec. 5 y SITEMAP.md sec. 9.
 */

export type IpCategory =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "multicast"
  | "unspecified"
  | "metadata" // 169.254.169.254 (AWS IMDS)
  | "documentation" // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
  | "benchmarking" // 198.18.0.0/15
  | "protocol_assignment" // 192.0.0.0/24
  | "broadcast" // 255.255.255.255
  | "reserved";

export type IpVersion = 4 | 6;

export interface IpClassification {
  readonly version: IpVersion;
  readonly category: IpCategory;
  /** true si la IP es segura para una conexion saliente. */
  readonly safe: boolean;
}

/** Unica categoria permitida. Cualquier otra cosa se bloquea. */
const SAFE_CATEGORIES: ReadonlySet<IpCategory> = new Set<IpCategory>(["public"]);

/** 169.254.169.254 como entero, para distinguir IMDS dentro de link-local. */
const AWS_METADATA_U32 = 0xa9fea9fe;
/** 255.255.255.255 broadcast limitado. */
const BROADCAST_U32 = 0xffffffff;

interface Cidr {
  readonly base: number; // entero sin signo de la direccion base
  readonly prefix: number; // longitud de prefijo (bits)
  readonly category: IpCategory;
}

/** Convierte "a.b.c.d" (ya validada) a entero sin signo de 32 bits. */
function octetsToU32(o: readonly [number, number, number, number]): number {
  // `>>> 0` fuerza interpretacion sin signo.
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function cidr(dotted: string, prefix: number, category: IpCategory): Cidr {
  const parsed = parseIpv4Strict(dotted);
  if (!parsed) throw new Error(`CIDR base invalida: ${dotted}`);
  return { base: octetsToU32(parsed), prefix, category };
}

/**
 * Rangos IPv4 bloqueados. El orden importa solo para legibilidad: las
 * comprobaciones son disjuntas salvo metadata, que se resuelve antes.
 */
const BLOCKED_IPV4_CIDRS: readonly Cidr[] = [
  cidr("0.0.0.0", 8, "unspecified"),
  cidr("10.0.0.0", 8, "private"),
  cidr("100.64.0.0", 10, "private"), // CGNAT
  cidr("127.0.0.0", 8, "loopback"),
  cidr("169.254.0.0", 16, "link_local"),
  cidr("172.16.0.0", 12, "private"),
  cidr("192.0.0.0", 24, "protocol_assignment"),
  cidr("192.0.2.0", 24, "documentation"),
  cidr("192.168.0.0", 16, "private"),
  cidr("198.18.0.0", 15, "benchmarking"),
  cidr("198.51.100.0", 24, "documentation"),
  cidr("203.0.113.0", 24, "documentation"),
  cidr("224.0.0.0", 4, "multicast"),
  cidr("240.0.0.0", 4, "reserved"),
];

/** true si `value` cae dentro del CIDR. Comparacion aritmetica, no textual. */
function inCidr(value: number, range: Cidr): boolean {
  if (range.prefix === 0) return true;
  // Mascara sin signo para el prefijo dado.
  const mask = (0xffffffff << (32 - range.prefix)) >>> 0;
  return (value & mask) >>> 0 === (range.base & mask) >>> 0;
}

/**
 * Parsea IPv4 en formato dotted-quad ESTRICTO (4 octetos decimales, sin ceros
 * a la izquierda, sin hex/octal). Las formas alternativas (`127.1`, `0x7f000001`,
 * `2130706433`, `0177.0.0.1`) las canonicaliza WHATWG `URL` antes de llegar aqui;
 * si alguna llega sin canonicalizar, este parser devuelve null y el llamador la
 * trata como NO publica (nunca como publica).
 */
function parseIpv4Strict(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Ceros a la izquierda son ambiguos (octal): se rechazan.
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** Clasifica un IPv4 ya parseado usando aritmetica de enteros. */
function classifyIpv4Octets(o: readonly [number, number, number, number]): IpCategory {
  const value = octetsToU32(o);
  // Metadata de AWS tiene prioridad sobre link-local para trazabilidad.
  if (value === AWS_METADATA_U32) return "metadata";
  if (value === BROADCAST_U32) return "broadcast";
  for (const range of BLOCKED_IPV4_CIDRS) {
    if (inCidr(value, range)) return range.category;
  }
  return "public";
}

/**
 * Expande un IPv6 a 8 grupos de 16 bits. Acepta forma comprimida (`::`),
 * expandida y IPv4-embebida (`::ffff:1.2.3.4`). Devuelve null si es invalida.
 * NO acepta zona de scope (`%eth0`): un host de URL nunca deberia traerla.
 */
function parseIpv6Groups(host: string): number[] | null {
  let text = host;
  if (text === "") return null;
  if (text.includes("%")) return null;

  // IPv4 embebido en la cola (::ffff:1.2.3.4). Node normalmente ya lo convierte
  // a hex, pero una respuesta DNS puede traerlo en forma mixta.
  let tailV4: [number, number, number, number] | null = null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Strict(text.slice(lastColon + 1));
    if (!v4) return null;
    tailV4 = v4;
    // Sustituye la cola v4 por dos grupos placeholder.
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const parts = s.split(":");
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0]!);
    const tail = toGroups(halves[1]!);
    if (head === null || tail === null) return null;
    const missing = 8 - (head.length + tail.length);
    // `::` debe representar al menos un grupo cero.
    if (missing < 1) return null;
    groups = [...head, ...(Array(missing).fill(0) as number[]), ...tail];
  } else {
    const all = toGroups(text);
    if (all === null) return null;
    groups = all;
  }

  if (tailV4) {
    groups[6] = ((tailV4[0] << 8) | tailV4[1]) & 0xffff;
    groups[7] = ((tailV4[2] << 8) | tailV4[3]) & 0xffff;
  }

  if (groups.length !== 8) return null;
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** true si los 6 primeros grupos son el prefijo IPv4-mapped ::ffff:0:0/96. */
function isIpv4Mapped(g: readonly number[]): boolean {
  return (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  );
}

/**
 * true si es IPv4-compatible ::0:0/96 con IPv4 embebido no trivial
 * (`::a.b.c.d`). Se clasifica por la IPv4 embebida, igual que mapped.
 */
function isIpv4Compatible(g: readonly number[]): boolean {
  return (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0 &&
    !(g[6] === 0 && (g[7] === 0 || g[7] === 1)) // excluye :: y ::1
  );
}

/** Extrae la IPv4 embebida de los dos ultimos grupos. */
function embeddedIpv4(g: readonly number[]): [number, number, number, number] {
  return [
    (g[6]! >> 8) & 0xff,
    g[6]! & 0xff,
    (g[7]! >> 8) & 0xff,
    g[7]! & 0xff,
  ];
}

function classifyIpv6Groups(g: readonly number[]): IpCategory {
  if (g.every((x) => x === 0)) return "unspecified"; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback"; // ::1

  // IPv4-mapped / IPv4-compatible: clasificar por la IPv4 EMBEBIDA para que
  // ::ffff:127.0.0.1 y ::ffff:169.254.169.254 queden bloqueadas.
  if (isIpv4Mapped(g) || isIpv4Compatible(g)) {
    return classifyIpv4Octets(embeddedIpv4(g));
  }

  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
  if ((first & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return "reserved"; // 100::/64 discard
  if (first === 0x2001 && g[1] === 0x0db8) return "documentation"; // 2001:db8::/32
  return "public";
}

/**
 * Clasifica una IP literal (v4 o v6). Acepta IPv6 con o sin corchetes.
 * Devuelve null si `ip` no es una IP valida (p. ej. es un hostname): el
 * llamador debe tratar ese caso como NO seguro.
 */
export function classifyIp(ip: string): IpClassification | null {
  const text = stripBrackets(ip.trim());
  if (text === "") return null;

  const v4 = parseIpv4Strict(text);
  if (v4) {
    const category = classifyIpv4Octets(v4);
    return { version: 4, category, safe: SAFE_CATEGORIES.has(category) };
  }
  // Solo intentamos IPv6 si hay `:`; asi un hostname nunca se confunde con IP.
  if (text.includes(":")) {
    const groups = parseIpv6Groups(text);
    if (groups) {
      const category = classifyIpv6Groups(groups);
      return { version: 6, category, safe: SAFE_CATEGORIES.has(category) };
    }
  }
  return null;
}

/**
 * Quita `[` y `]` SOLO cuando encierran una IPv6 sintacticamente valida.
 *
 * Los corchetes son sintaxis de autoridad reservada a IPv6 (RFC 3986 seccion
 * 3.2.2). Retirarlos de cualquier valor entre corchetes convertiria
 * `[example.com]` (autoridad invalida) en un hostname aparentemente legitimo, y
 * `[]` en un host vacio. Se conservan intactos para que la validacion posterior
 * los rechace. (Hallazgo PR04-R05.)
 */
export function stripBrackets(host: string): string {
  if (host.length < 2 || !host.startsWith("[") || !host.endsWith("]")) {
    return host;
  }
  const inner = host.slice(1, -1);
  // `parseIpv6Groups` solo acepta IPv6; el `includes(":")` evita tratar un
  // hostname como candidato y mantiene el mismo criterio que `classifyIp`.
  if (!inner.includes(":") || parseIpv6Groups(inner) === null) {
    return host;
  }
  return inner;
}

/** true si la IP es valida y pertenece a un rango bloqueado. */
export function isBlockedIp(ip: string): boolean {
  const c = classifyIp(ip);
  return c !== null && !c.safe;
}

/**
 * true si el valor es una IP valida y PUBLICA. Una direccion invalida devuelve
 * false (nunca se considera publica).
 */
export function isPublicIp(ip: string): boolean {
  const c = classifyIp(ip);
  return c !== null && c.safe;
}
