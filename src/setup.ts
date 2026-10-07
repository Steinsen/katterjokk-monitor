// /setup – visar de id:n som ska in i wrangler.toml. Aktiv tills NET_SITE_ID är satt.
export function setupHtml(data: Record<string, any>, configured: boolean): string {
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const table = (rows: any[] | undefined, cols: string[]) =>
    !rows?.length
      ? '<p class="muted">– inget –</p>'
      : `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows
          .map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c])}</td>`).join("")}</tr>`)
          .join("")}</table>`;
  const err = (k: string) => (data[k] ? `<p class="err">${esc(data[k])}</p>` : "");
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Katterjåkk Monitor – setup</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1b1f24}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-family:ui-monospace,monospace;font-size:13px}
th{background:#f6f7f9}.muted{color:#6b7280}.err{color:#b91c1c;background:#fef2f2;padding:8px;border-radius:6px}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}
.ok{color:#15803d;background:#f0fdf4;padding:8px;border-radius:6px}</style></head><body>
<h1>Setup – värden till <code>wrangler.toml [vars]</code></h1>
${configured ? '<p class="ok">NET_SITE_ID är satt – monitorn är konfigurerad. Den här sidan visas bara för att du öppnade den innan nästa deploy; efter att allt är ifyllt svarar /setup med 404.</p>' : '<p>Kopiera värdena nedan till <code>wrangler.toml</code> på GitHub och committa. Cloudflare bygger om Worker:n automatiskt.</p>'}
<h2>1. HOST_ID</h2>${err("hosts_error")}${table(data.hosts, ["HOST_ID", "type", "ip", "owner", "connected"])}
<h2>2. SM_SITE_ID</h2>${err("sites_error")}${table(data.sites, ["SM_SITE_ID", "name", "wifiClients", "wifiDevices", "wanUptime", "isp"])}
<h2>3. NET_SITE_ID (via Cloud Connector)</h2>${err("connector_error")}${data.connector_hint ? `<p class="muted">${esc(data.connector_hint)}</p>` : ""}${table(data.network_sites, ["NET_SITE_ID", "name"])}
<h2>4. GUEST_NETWORK_ID – ta raden med vlan 30</h2>${table(data.networks, ["GUEST_NETWORK_ID", "name", "vlan", "dhcpRange"])}
<h2>5. FIBER_IP_PREFIX – ta början på konsolens IP under 1. HOST_ID (fiberns publika IP). ISP-metriken nedan gäller WAN1:</h2><pre>${esc(JSON.stringify(data.isp_now, null, 2))}</pre>
<h2>Enheter (kontrollera att AP-modellerna börjar på AP_MODEL_PREFIX)</h2>${table(data.devices, ["model", "name", "state"])}
<p class="muted">Rådata: <a href="/setup?format=json">/setup?format=json</a></p>
</body></html>`;
}
