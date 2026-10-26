import {
  addToHistory,
  classifyInput,
  decodeShareQuery,
  detectMailHealth,
  groupRecords,
  isPrivateOrReservedIp,
  type DnsAnswer,
  type NormalisedRecord,
} from "./logic";

const DNS_TYPES = ["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "CAA"] as const;
const HISTORY_KEY = "netlens-history";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const form = $("#search-form") as HTMLFormElement;
const input = $("#query") as HTMLInputElement;
const errorEl = $("#input-error");
const timingEl = $("#timing");
const resultsEl = $("#results");
const toastEl = $("#toast");
const historyList = $("#history-list");

let lastResult: { query: string; payload: unknown } | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function copyText(text: string, label: string) {
  navigator.clipboard?.writeText(text).then(() => toast(`${label} copied`)).catch(() => toast("Copy failed — select the text manually"));
}

function skeleton(): string {
  return `<div class="card"><div class="skel skel-title"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>`;
}

function recordCard(type: string, recs: NormalisedRecord[]): string {
  const rows = recs.map((r) => `<tr><td class="mono">${esc(r.value)}</td><td class="ttl">${r.ttl}s</td></tr>`).join("");
  return `<article class="rec-card"><h3>${esc(type)} <span class="count">${recs.length}</span></h3><table><tbody>${rows}</tbody></table></article>`;
}

function resultActions(query: string): string {
  return `<div class="actions">
    <button type="button" data-action="copy-json">Copy results as JSON</button>
    <button type="button" data-action="download-json">Download JSON</button>
    <button type="button" data-action="share">Copy share link</button>
  </div>`;
}

async function lookupDns(domain: string): Promise<{ groups: Map<string, NormalisedRecord[]>; raw: unknown[]; txt: string[]; errors: string[] }> {
  const groups = new Map<string, NormalisedRecord[]>();
  const raw: unknown[] = [];
  const errors: string[] = [];
  const results = await Promise.allSettled(
    DNS_TYPES.map(async (type) => {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { type, json: (await res.json()) as { Status?: number; Answer?: DnsAnswer[] } };
    }),
  );
  let anyNxdomain = false;
  for (const r of results) {
    if (r.status === "rejected") { errors.push("One record type failed to load — check your connection and retry."); continue; }
    const { type, json } = r.value;
    if (json.Status === 3) { anyNxdomain = true; continue; }
    if (!json.Answer?.length) continue;
    raw.push(...json.Answer);
    const grouped = groupRecords(json.Answer);
    for (const [k, v] of grouped) groups.set(k, [...(groups.get(k) ?? []), ...v]);
  }
  const txt = groups.get("TXT")?.map((r) => r.raw) ?? [];
  if (groups.size === 0 && anyNxdomain) errors.unshift("NXDOMAIN — this domain does not exist (no DNS records found).");
  else if (groups.size === 0) errors.unshift("No DNS records found for this domain.");
  return { groups, raw, txt, errors };
}

async function lookupIp(ip: string): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
    if (!res.ok) return { ok: false, error: `The IP lookup service returned HTTP ${res.status}.` };
    const json = (await res.json()) as { success?: boolean; message?: string } & Record<string, unknown>;
    if (json.success === false) return { ok: false, error: json.message ? String(json.message) : "That IP address could not be looked up." };
    return { ok: true, data: json };
  } catch {
    return { ok: false, error: "Could not reach the IP lookup service — check your connection and retry." };
  }
}

function renderDomain(domain: string, dns: Awaited<ReturnType<typeof lookupDns>>) {
  const health = detectMailHealth(dns.txt);
  const cards = [...dns.groups.entries()].map(([t, recs]) => recordCard(t, recs)).join("");
  const mailRows = (label: string, found: boolean, record: string | null, note?: string) => `
    <div class="mail-row ${found ? "ok" : "missing"}">
      <span class="badge">${found ? "✓ Found" : "✕ Missing"}</span>
      <strong>${label}</strong>
      <span class="mono">${record ? esc(record) : note ?? "No matching TXT record published."}</span>
    </div>`;
  resultsEl.innerHTML = `
    <div class="result-head"><h2>${esc(domain)}</h2><span class="kind-tag">Domain</span></div>
    ${dns.errors.map((e) => `<p class="notice">${esc(e)}</p>`).join("")}
    ${cards ? `<div class="rec-grid">${cards}</div>` : ""}
    <section class="card mail">
      <h2>✉ Email health</h2>
      ${mailRows("SPF", health.spf.found, health.spf.record)}
      ${mailRows("DMARC", health.dmarc.found, health.dmarc.record)}
      ${mailRows("DKIM", false, null, "Can't be checked here — DKIM lives under a selector subdomain (e.g. selector._domainkey), and NetLens doesn't guess one.")}
    </section>
    <details class="card raw"><summary>Raw DNS answers</summary><pre>${esc(JSON.stringify(dns.raw, null, 2))}</pre></details>
    ${resultActions(domain)}`;
  bindActions(domain, { domain, dns: dns.raw, mailHealth: health });
}

function renderIp(ip: string, lookup: Awaited<ReturnType<typeof lookupIp>>) {
  if (!lookup.ok || !lookup.data) {
    resultsEl.innerHTML = `<div class="result-head"><h2>${esc(ip)}</h2><span class="kind-tag">IP</span></div><p class="notice">${esc(lookup.error ?? "Lookup failed.")}</p>${resultActions(ip)}`;
    bindActions(ip, { ip, error: lookup.error });
    return;
  }
  const d = lookup.data;
  const flag = d.flag as { emoji?: string } | undefined;
  const conn = d.connection as { isp?: string; asn?: number; org?: string } | undefined;
  const tz = d.timezone as { id?: string; abbr?: string } | undefined;
  const rows: [string, string][] = [
    ["IP", String(d.ip ?? ip)],
    ["Location", `${flag?.emoji ?? ""} ${d.city ?? ""}, ${d.region ?? ""}, ${d.country ?? ""}`.trim()],
    ["Coordinates", d.latitude != null && d.longitude != null ? `${d.latitude}, ${d.longitude}` : "—"],
    ["Timezone", tz?.id ? `${tz.id} (${tz.abbr ?? ""})` : "—"],
    ["ISP", conn?.isp ?? "—"],
    ["ASN / Org", conn?.asn != null ? `AS${conn.asn} — ${conn.org ?? ""}` : "—"],
  ];
  resultsEl.innerHTML = `
    <div class="result-head"><h2>${esc(ip)}</h2><span class="kind-tag">IP address</span></div>
    <section class="card"><dl class="ip-grid">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="mono">${esc(v)}</dd></div>`).join("")}</dl></section>
    ${resultActions(ip)}`;
  bindActions(ip, { ip, ipInfo: d });
}

function bindActions(query: string, payload: unknown) {
  lastResult = { query, payload };
  resultsEl.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = (btn as HTMLElement).dataset.action;
      const json = JSON.stringify(lastResult, null, 2);
      if (action === "copy-json") copyText(json, "Results");
      else if (action === "download-json") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = `netlens-${query.replace(/[^a-z0-9.-]/gi, "_")}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast("JSON downloaded");
      } else if (action === "share") {
        const url = `${location.origin}${location.pathname}?q=${encodeURIComponent(query)}`;
        copyText(url, "Share link");
      }
    });
  });
}

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[]; } catch { return []; }
}
function renderHistory() {
  const h = loadHistory();
  historyList.innerHTML = h.length
    ? h.map((q) => `<li><button type="button" data-history="${esc(q)}">${esc(q)}</button></li>`).join("")
    : `<li class="muted">Nothing yet — your recent lookups will appear here.</li>`;
  historyList.querySelectorAll("[data-history]").forEach((b) =>
    b.addEventListener("click", () => { input.value = (b as HTMLElement).dataset.history ?? ""; void runSearch(); }));
}
function saveHistory(q: string) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(addToHistory(loadHistory(), q))); } catch { /* private mode */ }
  renderHistory();
}

async function runSearch(rawInput?: string) {
  const raw = (rawInput ?? input.value).trim();
  const classified = classifyInput(raw);
  errorEl.hidden = true;
  if (classified.kind === "invalid") {
    errorEl.textContent = classified.reason ?? "Invalid input.";
    errorEl.hidden = false;
    input.focus();
    return;
  }
  input.value = classified.value;
  const started = performance.now();
  resultsEl.innerHTML = skeleton();
  historyAdd(classified.value);
  const url = new URL(location.href);
  url.searchParams.set("q", classified.value);
  history.replaceState(null, "", url);
  try {
    if (classified.kind === "domain") {
      const dns = await lookupDns(classified.value);
      renderDomain(classified.value, dns);
    } else {
      if (isPrivateOrReservedIp(classified.value)) {
        resultsEl.innerHTML = `<div class="result-head"><h2>${esc(classified.value)}</h2><span class="kind-tag">IP</span></div>
          <p class="notice">That's a private or reserved address (like a home-network or loopback IP). Public lookup services only know about public IPs, so there's nothing to show for it.</p>${resultActions(classified.value)}`;
        bindActions(classified.value, { ip: classified.value, error: "private/reserved" });
      } else {
        renderIp(classified.value, await lookupIp(classified.value));
      }
    }
  } catch {
    resultsEl.innerHTML = `<p class="notice">Something went wrong while fetching results. Check your connection and try again.</p>`;
  }
  timingEl.textContent = `Done in ${((performance.now() - started) / 1000).toFixed(2)}s`;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}
function historyAdd(q: string) { saveHistory(q); }

form.addEventListener("submit", (e) => { e.preventDefault(); void runSearch(); });
document.querySelectorAll("[data-example]").forEach((b) =>
  b.addEventListener("click", () => { input.value = (b as HTMLElement).dataset.example ?? ""; void runSearch(); }));
$("#clear-history").addEventListener("click", () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* noop */ }
  renderHistory();
  toast("History cleared");
});

// "What's my IP" card
async function loadMyIp() {
  const valueEl = $("#my-ip-value");
  const noteEl = $("#my-ip-note");
  const btn = $("#inspect-my-ip") as HTMLButtonElement;
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const json = (await res.json()) as { ip?: string };
    if (!json.ip) throw new Error("no ip");
    const myIp = json.ip;
    valueEl.textContent = myIp;
    btn.disabled = false;
    btn.addEventListener("click", () => { input.value = myIp; void runSearch(); });
    // Best-effort IPv6 attempt (api64 returns v6 when available); never blocks the card.
    fetch("https://api64.ipify.org?format=json").then((r) => r.json()).then((j: { ip?: string }) => {
      if (j.ip && j.ip.includes(":")) noteEl.textContent = `IPv4: ${json.ip} · IPv6: ${j.ip}`;
    }).catch(() => undefined);
  } catch {
    valueEl.textContent = "Unavailable";
    noteEl.textContent = "Couldn't reach ipify — your connection or an ad-blocker may be blocking it.";
  }
}

renderHistory();
void loadMyIp();
const shared = decodeShareQuery(location.search);
if (shared) { input.value = shared; void runSearch(shared); }
