import { describe, expect, it } from "vitest";
import {
  addToHistory,
  classifyInput,
  decodeShareQuery,
  detectMailHealth,
  encodeShareUrl,
  extractHost,
  groupRecords,
  isPrivateOrReservedIp,
  joinTxtChunks,
  normaliseAnswer,
} from "../src/logic";

describe("classifyInput", () => {
  it.each([
    ["example.com", "domain", "example.com"],
    ["EXAMPLE.COM", "domain", "example.com"],
    ["example.com.", "domain", "example.com"],
    ["https://example.com/some/path?x=1#frag", "domain", "example.com"],
    ["http://user@example.com:8080/", "domain", "example.com"],
    ["sub.domain-example.co.uk", "domain", "sub.domain-example.co.uk"],
    ["8.8.8.8", "ipv4", "8.8.8.8"],
    ["https://8.8.8.8/", "ipv4", "8.8.8.8"],
    ["2001:4860:4860::8888", "ipv6", "2001:4860:4860::8888"],
    ["[2001:db8::1]:443", "ipv6", "2001:db8::1"],
    ["::1", "ipv6", "::1"],
    ["::ffff:192.0.2.1", "ipv6", "::ffff:192.0.2.1"],
  ])("classifies %s as %s (%s)", (raw, kind, value) => {
    const r = classifyInput(raw);
    expect(r.kind).toBe(kind);
    expect(r.value).toBe(value);
  });

  it.each([
    ["", "Enter a domain"],
    ["   ", "Enter a domain"],
    ["not a domain!!", "valid domain"],
    ["999.1.1.1", "out-of-range"],
    ["256.256.256.256", "out-of-range"],
    ["example", "valid domain"],
    ["-bad-.com", "valid domain"],
    ["example..com", "valid domain"],
    ["12345::6789::1", "valid IPv6"],
    ["gggg::1", "valid IPv6"],
  ])("rejects %s", (raw, reasonPart) => {
    const r = classifyInput(raw);
    expect(r.kind).toBe("invalid");
    expect(r.reason).toContain(reasonPart);
  });
});

describe("extractHost", () => {
  it("keeps a bare IPv6 intact (does not strip colons as a port)", () => {
    expect(extractHost("2001:db8::1")).toBe("2001:db8::1");
  });
  it("strips a single port from a domain", () => {
    expect(extractHost("example.com:8080")).toBe("example.com");
  });
});

describe("DNS normalisation", () => {
  it("joins quoted TXT chunks into one string", () => {
    expect(joinTxtChunks('"v=spf1 include:" "example.com -all"')).toBe("v=spf1 include:example.com -all");
  });
  it("leaves unquoted TXT data alone", () => {
    expect(joinTxtChunks("v=spf1 -all")).toBe("v=spf1 -all");
  });
  it("trims trailing dots from hostnames but keeps TXT intact", () => {
    expect(normaliseAnswer({ name: "x", type: 1, ttl: 300, data: "93.184.216.34" }).value).toBe("93.184.216.34");
    expect(normaliseAnswer({ name: "x", type: 2, ttl: 300, data: "ns.example.com." }).value).toBe("ns.example.com");
  });
  it("groups answers by type name", () => {
    const groups = groupRecords([
      { name: "x", type: 1, ttl: 300, data: "1.2.3.4" },
      { name: "x", type: 1, ttl: 300, data: "5.6.7.8" },
      { name: "x", type: 15, ttl: 300, data: "10 mail.example.com." },
    ]);
    expect([...groups.keys()].sort()).toEqual(["A", "MX"]);
    expect(groups.get("A")).toHaveLength(2);
    expect(groups.get("MX")![0].value).toBe("10 mail.example.com");
  });
});

describe("mail health", () => {
  const txt = ['"v=spf1 include:_spf.google.com ~all"', '"v=DMARC1; p=reject"'];
  it("finds SPF and DMARC (case-insensitive for DMARC tag)", () => {
    const h = detectMailHealth(txt);
    expect(h.spf.found).toBe(true);
    expect(h.spf.record).toContain("v=spf1");
    expect(h.dmarc.found).toBe(true);
  });
  it("reports missing records honestly", () => {
    const h = detectMailHealth(['"google-site-verification=abc"']);
    expect(h.spf).toEqual({ found: false, record: null });
    expect(h.dmarc).toEqual({ found: false, record: null });
  });
  it("does not mistake a mention of spf inside other text for an SPF record", () => {
    const h = detectMailHealth(['"we love spf records"']);
    expect(h.spf.found).toBe(false);
  });
  it("handles an empty TXT list", () => {
    expect(detectMailHealth([]).spf.found).toBe(false);
  });
});

describe("shareable URLs", () => {
  it("round-trips a query through encode/decode, including spaces and &", () => {
    const encoded = encodeShareUrl("https://judd69.github.io/netlens/", "example.com");
    expect(encoded).toContain("q=example.com");
    expect(decodeShareQuery(new URL(encoded, "https://x.invalid").search)).toBe("example.com");
  });
  it("returns null for a missing or blank q", () => {
    expect(decodeShareQuery("")).toBeNull();
    expect(decodeShareQuery("?q=%20%20")).toBeNull();
    expect(decodeShareQuery("?other=1")).toBeNull();
  });
});

describe("private / reserved IPs", () => {
  it.each(["10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1"])(
    "flags %s as private/reserved", (ip) => expect(isPrivateOrReservedIp(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860:4860::8888"])(
    "treats %s as public", (ip) => expect(isPrivateOrReservedIp(ip)).toBe(false),
  );
});

describe("history", () => {
  it("prepends, dedupes case-insensitively, and caps at 10", () => {
    let h = addToHistory([], "Example.com");
    h = addToHistory(h, "example.com");
    expect(h).toEqual(["example.com"]);
    for (let i = 0; i < 12; i++) h = addToHistory(h, `site${i}.com`);
    expect(h).toHaveLength(10);
    expect(h[0]).toBe("site11.com");
  });
  it("ignores blank entries", () => {
    expect(addToHistory(["a.com"], "   ")).toEqual(["a.com"]);
  });
});
