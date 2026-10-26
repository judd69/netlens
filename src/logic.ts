// Pure, network-free logic for NetLens. Everything here is unit-tested;
// all fetching lives in main.ts.

export type InputKind = "domain" | "ipv4" | "ipv6" | "invalid";

export interface ClassifiedInput {
  kind: InputKind;
  /** Normalised value to query: bare domain, or the IP as typed. */
  value: string;
  /** Human-readable reason when kind === "invalid". */
  reason?: string;
}

const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Accepts full, compressed (::), and IPv4-embedded forms; rejects lone colons
// and groups longer than 4 hex digits. Full RFC validation is the API's job.
const IPV4_PART = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const HEX = String.raw`[0-9a-fA-F]{1,4}`;
const IPV6_RE = new RegExp(
  `^(?:(?:${HEX}:){7}${HEX}|(?:${HEX}:){1,7}:|:(?::${HEX}){1,7}|(?:${HEX}:)+:(?:${HEX}:)*${HEX}|::(?:ffff:)?${IPV4_PART}(?:\\.${IPV4_PART}){3}|(?:${HEX}:){1,6}:${IPV4_PART}(?:\\.${IPV4_PART}){3})$`,
);
const DOMAIN_RE =
  /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}(?<!-)\.)+[a-zA-Z]{2,63}$/;

/** Strip scheme, credentials, port, path, query and fragment from a URL-ish string. */
export function extractHost(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // scheme://
  s = s.split(/[/?#]/)[0]; // path / query / fragment
  if (s.includes("@")) s = s.split("@").pop() ?? s; // userinfo@
  if (s.startsWith("[")) {
    // [ipv6] or [ipv6]:port
    const end = s.indexOf("]");
    if (end !== -1) return s.slice(1, end);
    return s;
  }
  // host:port — but a bare IPv6 has many colons, so only strip a single port colon
  const colonCount = (s.match(/:/g) ?? []).length;
  if (colonCount === 1) s = s.split(":")[0];
  return s.toLowerCase().replace(/\.$/, ""); // trailing dot
}

export function classifyInput(raw: string): ClassifiedInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "invalid", value: "", reason: "Enter a domain, URL, or IP address." };
  }
  const host = extractHost(trimmed);
  if (!host) {
    return { kind: "invalid", value: "", reason: "That doesn't look like a domain or IP address." };
  }
  if (IPV4_RE.test(host)) return { kind: "ipv4", value: host };
  if (IPV6_RE.test(host)) return { kind: "ipv6", value: host };
  if (DOMAIN_RE.test(host)) return { kind: "domain", value: host };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { kind: "invalid", value: host, reason: "That IPv4 address has an out-of-range octet (each part must be 0–255)." };
  }
  if (host.includes(":")) {
    return { kind: "invalid", value: host, reason: "That doesn't look like a valid IPv6 address." };
  }
  return {
    kind: "invalid",
    value: host,
    reason: "Enter a valid domain (like example.com), a URL, or an IP address.",
  };
}

/** Is this IP private / loopback / link-local / reserved (not publicly routable)? */
export function isPrivateOrReservedIp(ip: string): boolean {
  const kind = classifyInput(ip).kind;
  if (kind === "ipv4") {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0 ||
      a >= 224
    );
  }
  if (kind === "ipv6") {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // IPv4-mapped form ::ffff:a.b.c.d — judge the embedded IPv4 address.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }
  return false;
}

// --- DNS answer normalisation ------------------------------------------------

export interface DnsAnswer {
  name: string;
  type: number;
  ttl: number;
  data: string;
}

export interface NormalisedRecord {
  type: string;
  ttl: number;
  /** Display-ready value (TXT quotes joined, trailing dots trimmed). */
  value: string;
  raw: string;
}

export const DNS_TYPE_NAMES: Record<number, string> = {
  1: "A", 28: "AAAA", 15: "MX", 16: "TXT", 2: "NS", 5: "CNAME", 6: "SOA", 257: "CAA",
};

/** Join the quoted string chunks of a TXT record into one readable string. */
export function joinTxtChunks(data: string): string {
  const chunks = data.match(/"([^"]*)"/g);
  if (chunks) return chunks.map((c) => c.slice(1, -1)).join("");
  return data;
}

export function normaliseAnswer(answer: DnsAnswer): NormalisedRecord {
  const type = DNS_TYPE_NAMES[answer.type] ?? `TYPE${answer.type}`;
  let value = answer.data;
  if (answer.type === 16) value = joinTxtChunks(value);
  else value = value.replace(/\.$/, ""); // trim trailing dot on hostnames
  return { type, ttl: answer.ttl, value, raw: answer.data };
}

export function groupRecords(answers: DnsAnswer[]): Map<string, NormalisedRecord[]> {
  const groups = new Map<string, NormalisedRecord[]>();
  for (const a of answers) {
    const rec = normaliseAnswer(a);
    const list = groups.get(rec.type) ?? [];
    list.push(rec);
    groups.set(rec.type, list);
  }
  return groups;
}

// --- Mail health ---------------------------------------------------------------

export interface MailHealth {
  spf: { found: boolean; record: string | null };
  dmarc: { found: boolean; record: string | null };
}

export function detectMailHealth(txtRecords: string[]): MailHealth {
  const joined = txtRecords.map(joinTxtChunks);
  const spf = joined.find((t) => t.trimStart().toLowerCase().startsWith("v=spf1")) ?? null;
  const dmarc = joined.find((t) => t.trimStart().toLowerCase().startsWith("v=dmarc1")) ?? null;
  return {
    spf: { found: spf !== null, record: spf },
    dmarc: { found: dmarc !== null, record: dmarc },
  };
}

// --- Shareable URLs ------------------------------------------------------------

export function encodeShareUrl(base: string, query: string): string {
  const url = new URL(base, "https://netlens.invalid");
  url.searchParams.set("q", query);
  return url.pathname + url.search + url.hash;
}

export function decodeShareQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  const q = params.get("q");
  return q && q.trim() ? q.trim() : null;
}

// --- History -------------------------------------------------------------------

export function addToHistory(history: string[], entry: string, max = 10): string[] {
  const cleaned = entry.trim();
  if (!cleaned) return history;
  return [cleaned, ...history.filter((h) => h.toLowerCase() !== cleaned.toLowerCase())].slice(0, max);
}
