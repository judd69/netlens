# NetLens — X-ray any domain or IP

Checking a domain's DNS, its mail setup, or an IP's location usually means
juggling several ad-heavy, scattered lookup sites. NetLens puts it on one clean
page, in the browser. No signup, no API key, no server.

## What it does

- **One search box** — accepts a domain (`example.com`), a URL (scheme and path
  are stripped), or an IPv4/IPv6 address. Input type is auto-detected, and
  invalid input gets a plain-language error.
- **Domain mode** — queries Google DNS-over-HTTPS for A, AAAA, MX, TXT, NS,
  CNAME, SOA, and CAA records, grouped by type with TTLs, plus a raw-answer
  view. NXDOMAIN, no-records, and network-error states are explained in plain
  language.
- **Email health** — parses TXT records and reports SPF and DMARC as
  Found/Missing with the raw record shown. DKIM is **not** faked: it lives
  under a selector subdomain, so NetLens says so honestly instead of guessing.
- **IP mode** — looks up city/region/country (+ flag), coordinates, timezone,
  ISP, and ASN/org. Private/reserved IPs get a clear explanation instead of a
  failed lookup.
- **What's my IP** — shows your public IP on load, with a one-click
  "inspect it" button.
- **Extras** — shareable URLs (`?q=example.com`), recent-search history
  (localStorage, clickable, clearable), copy-result buttons, JSON export
  download, and per-query timing.

## How to run

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build (output: dist/)
npm test         # Vitest unit tests (pure logic only, no network)
```

The production build is copied to `docs/` so GitHub Pages can serve it at
https://judd69.github.io/netlens/ (enable Pages: Settings → Pages → branch
`main`, folder `/docs`).

## Public APIs used (all keyless, called from the browser)

| Purpose | Endpoint |
|---|---|
| DNS records | `https://dns.google/resolve?name=<domain>&type=<TYPE>` |
| IP lookup | `https://ipwho.is/<ip>` |
| Visitor IP | `https://api.ipify.org?format=json` (+ `api64.ipify.org` for an IPv6 attempt) |

## Example output

Searching `example.com` shows grouped cards like:

```
A     93.184.216.34        TTL 3600s
MX    0 .                  TTL 3600s
TXT   v=spf1 -all          TTL 3600s
```

plus an email-health panel: SPF ✓ Found, DMARC ✕ Missing, DKIM — cannot be
checked without a selector.

## Honest limitations

- **Browser-side only.** There is no server, so there is no WHOIS/RDAP lookup.
- **ipwho.is free tier is rate-limited.** If lookups start failing, wait a bit
  and retry; NetLens surfaces the API's error message.
- **DNS-over-HTTPS answers come from Google's resolver**, not the visitor's
  own resolver, so results can differ from a local `dig`.
- **DKIM cannot be checked** without knowing the sender's selector.
- Results depend on the visitor's network: ad-blockers or firewalls that block
  `dns.google` / `ipwho.is` / `ipify.org` will break lookups, and NetLens says
  so rather than showing empty results.

## Stack

Vanilla TypeScript + CSS, built with Vite. Zero runtime dependencies.
Tests: Vitest (pure-logic unit tests only — nothing in the test suite touches
the network).
