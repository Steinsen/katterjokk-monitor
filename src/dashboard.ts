// Statisk dashboard. Läser /api/status, /api/series?range=, /api/events.
// Inga externa beroenden; graferna ritas som inline-SVG.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Katterjåkk Network Status</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1b1f24; --muted:#6b7280; --line:#e5e7eb;
          --ok:#1a9a4a; --warn:#d98c00; --crit:#d1313d; --acc:#2a66c8; --acc2:#7a3fc8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1216; --card:#171b21; --ink:#e6e8eb; --muted:#9aa3ad; --line:#2a3039; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px,1fr)); gap: 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 10px; }
  .kv { display:grid; grid-template-columns: 1fr auto; gap: 4px 12px; }
  .kv b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .pill { display:inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; color:#fff; }
  .ok { background: var(--ok); } .warn { background: var(--warn); } .crit { background: var(--crit); } .na { background: var(--muted); }
  table { width:100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  .muted { color: var(--muted); }
  .tabs button { background: none; border: 1px solid var(--line); color: var(--ink); padding: 4px 10px; border-radius: 6px; cursor: pointer; margin-right: 4px; }
  .tabs button.on { background: var(--acc); color: #fff; border-color: var(--acc); }
  svg { width: 100%; height: auto; display: block; }
  .legend { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin: 0 4px 0 10px; vertical-align: -1px; }
  .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; background: var(--crit); color:#fff; display:none; }
  .ev { font-size: 13px; } .ev time { color: var(--muted); margin-right: 8px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<main>
  <h1>Katterjåkk Network Status</h1>
  <div class="sub" id="asof">Laddar …</div>
  <div class="banner" id="stale">Ingen ny mätning på över 20 minuter – monitorn eller UniFi-molnet svarar inte.</div>

  <div class="grid">
    <section class="card"><h2>Internet</h2><div class="kv" id="internet"></div></section>
    <section class="card"><h2>WiFi</h2><div class="kv" id="wifi"></div></section>
    <section class="card"><h2>Aktiva larm</h2><div id="alerts" class="muted">–</div></section>
  </div>

  <section class="card" style="margin-top:12px">
    <h2>Accesspunkter</h2>
    <div style="overflow-x:auto"><table id="aps"></table></div>
    <div class="muted" style="font-size:12px;margin-top:8px">Channel utilization, WiFi Experience och signal per klient finns inte i UniFis officiella API och visas därför inte.</div>
  </section>

  <section class="card" style="margin-top:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h2 style="margin:0">Historik</h2>
      <div class="tabs" id="tabs"><button data-r="1h">1 h</button><button data-r="24h" class="on">24 h</button><button data-r="7d">7 d</button></div>
    </div>
    <div class="grid">
      <div><div class="muted">Klienter</div><div id="c_clients"></div></div>
      <div><div class="muted">WAN latency (ms) och packet loss (%)</div><div id="c_wan"></div></div>
      <div><div class="muted">WAN-trafik (Mbit/s)</div><div id="c_kbps"></div></div>
      <div><div class="muted">TX retries 5 GHz per AP (%)</div><div id="c_retries"></div></div>
    </div>
  </section>

  <section class="card" style="margin-top:12px"><h2>Händelser</h2><div id="events" class="ev muted">–</div></section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const fmt = (v, d=0, unit='') => (v==null || Number.isNaN(v)) ? '<span class="muted">–</span>' : Number(v).toFixed(d)+unit;
const tz = { timeZone: 'Europe/Stockholm' };
const hhmm = (ts) => new Date(ts*1000).toLocaleTimeString('sv-SE', {...tz, hour:'2-digit', minute:'2-digit'});
const dt = (ts) => new Date(ts*1000).toLocaleString('sv-SE', {...tz, month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
const pill = (cls, text) => '<span class="pill '+cls+'">'+text+'</span>';

async function loadStatus() {
  const s = await (await fetch('/api/status')).json();
  const x = s.sample;
  if (!x) { $('asof').textContent = 'Inga mätningar ännu – vänta på första cron-körningen.'; return; }
  $('asof').textContent = 'Senaste mätning ' + dt(x.ts) + (x.connector_ok ? '' : ' · Cloud Connector svarade inte (AP-data saknas)');
  $('stale').style.display = s.stale ? 'block' : 'none';

  const fiber = x.wan_uptime == null ? pill('na','ej data') : x.wan_uptime >= 99 ? pill('ok','ONLINE') : x.wan_uptime >= 50 ? pill('warn', fmt(x.wan_uptime,0,' %')) : pill('crit','OFFLINE');
  const failover = s.active.some(a => a.rule === 'wan_failover');
  $('internet').innerHTML =
    '<span>Fiber</span>'+fiber+
    '<span>Aktiv väg</span>'+(failover ? pill('crit','5G backup') : pill('ok', x.isp_name || 'fiber'))+
    '<span>WAN latency</span><b>'+fmt(x.wan_latency,0,' ms')+' <span class="muted">(max '+fmt(x.wan_latency_max,0)+')</span></b>'+
    '<span>Packet loss</span><b>'+fmt(x.wan_loss,1,' %')+'</b>'+
    '<span>Trafik nu</span><b>'+fmt(x.wan_down_kbps/1000,1)+' / '+fmt(x.wan_up_kbps/1000,1)+' Mbit/s</b>'+
    '<span>Failovers 24 h</span><b>'+s.failovers24h+'</b>';

  const dhcpPct = (x.clients_guest_vlan!=null && x.dhcp_pool_size) ? 100*x.clients_guest_vlan/x.dhcp_pool_size : null;
  $('wifi').innerHTML =
    '<span>APs</span><b>'+fmt(x.aps_online)+' / '+fmt(x.aps_total)+'</b>'+
    '<span>Klienter</span><b>'+fmt(x.clients_total)+' <span class="muted">('+fmt(x.clients_wifi)+' WiFi, '+fmt(x.clients_wired)+' kabel)</span></b>'+
    '<span>Guest-VLAN (anslutna)</span><b>'+fmt(x.clients_guest_vlan)+' / '+fmt(x.dhcp_pool_size)+' <span class="muted">('+fmt(dhcpPct,0,' %')+')</span></b>';

  $('alerts').innerHTML = s.active.length
    ? s.active.map(a => '<div>'+pill(a.rule.startsWith('ap_offline')||a.rule.startsWith('wan_down')||a.rule==='wan_failover'?'crit':'warn', a.rule)+' '+a.subject+' <span class="muted">sedan '+hhmm(a.since)+'</span></div>').join('')
    : pill('ok','Inga');

  const rows = s.aps.map(a =>
    '<tr><td>'+a.ap_name+'</td><td>'+(a.state==='ONLINE'?pill('ok','online'):pill('crit',a.state||'?'))+'</td>'+
    '<td>'+fmt(a.clients)+'</td><td>'+fmt(a.ch_2g)+'/'+fmt(a.width_2g)+'</td><td>'+fmt(a.retries_2g,0,' %')+'</td>'+
    '<td>'+fmt(a.ch_5g)+'/'+fmt(a.width_5g)+'</td><td>'+fmt(a.retries_5g,0,' %')+'</td>'+
    '<td>'+fmt((a.uplink_rx_bps+a.uplink_tx_bps)/1e6,1)+'</td><td>'+fmt(a.cpu_pct,0,' %')+'</td></tr>').join('');
  $('aps').innerHTML = '<tr><th>AP</th><th>Status</th><th>Klienter</th><th>2,4 GHz kanal/MHz</th><th>Retries 2,4</th><th>5 GHz kanal/MHz</th><th>Retries 5</th><th>Uplink Mbit/s</th><th>CPU</th></tr>'+rows;
}

// --- liten SVG-linjegraf ---
function chart(series, opts) {
  const W=520, H=180, L=40, R=opts.right?40:10, T=10, B=24;
  const xs = series.flatMap(s => s.pts.map(p => p.x));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const scaleY = (vals, max) => { const m = max ?? Math.max(1, ...vals.filter(v=>v!=null)); return v => T + (H-T-B) * (1 - v/m); };
  const left = series.filter(s=>!s.right), right = series.filter(s=>s.right);
  const yL = scaleY(left.flatMap(s=>s.pts.map(p=>p.y)), opts.maxL);
  const yR = scaleY(right.flatMap(s=>s.pts.map(p=>p.y)), opts.maxR);
  const X = x => L + (W-L-R) * (x1===x0 ? 0 : (x-x0)/(x1-x0));
  const maxL = Math.max(1, ...left.flatMap(s=>s.pts.map(p=>p.y).filter(v=>v!=null)), opts.maxL||0);
  const maxR = Math.max(1, ...right.flatMap(s=>s.pts.map(p=>p.y).filter(v=>v!=null)), opts.maxR||0);
  let g = '<svg viewBox="0 0 '+W+' '+H+'">';
  for (let i=0;i<=4;i++){ const y=T+(H-T-B)*i/4; g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line)"/>';
    g+='<text x="'+(L-4)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="var(--muted)">'+Math.round(maxL*(1-i/4))+'</text>';
    if (right.length) g+='<text x="'+(W-R+4)+'" y="'+(y+4)+'" font-size="10" fill="var(--muted)">'+Math.round(maxR*(1-i/4)*10)/10+'</text>'; }
  const ticks = 6;
  for (let i=0;i<=ticks;i++){ const x=x0+(x1-x0)*i/ticks; g+='<text x="'+X(x)+'" y="'+(H-6)+'" text-anchor="middle" font-size="10" fill="var(--muted)">'+(opts.days?dt(x):hhmm(x))+'</text>'; }
  for (const s of series) {
    const Y = s.right ? yR : yL;
    let d='', pen=false;
    for (const p of s.pts) { if (p.y==null) { pen=false; continue; } d += (pen?'L':'M')+X(p.x).toFixed(1)+' '+Y(p.y).toFixed(1); pen=true; }
    g += '<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="1.6" stroke-linejoin="round"/>';
  }
  g += '</svg><div class="legend">'+series.map(s=>'<i style="background:'+s.color+'"></i>'+s.name).join('')+'</div>';
  return g;
}

const palette = ['#2a66c8','#7a3fc8','#1a9a4a','#d98c00','#d1313d','#0e9aa7','#8a6d3b','#555'];

async function loadSeries(range) {
  const s = await (await fetch('/api/series?range='+range)).json();
  const days = range === '7d';
  const w = s.wan;
  if (!w.length) { ['c_clients','c_wan','c_kbps','c_retries'].forEach(id=>$(id).innerHTML='<div class="muted">ingen data</div>'); return; }
  $('c_clients').innerHTML = chart([
    { name:'Totalt', color:palette[0], pts: w.map(r=>({x:r.t, y:r.clients})) },
    { name:'Guest-VLAN', color:palette[1], pts: w.map(r=>({x:r.t, y:r.guest})) },
  ], {days});
  $('c_wan').innerHTML = chart([
    { name:'Latency ms', color:palette[0], pts: w.map(r=>({x:r.t, y:r.latency})) },
    { name:'Loss % (höger)', color:palette[4], right:true, pts: w.map(r=>({x:r.t, y:r.loss})) },
  ], {days, right:true, maxR:10});
  $('c_kbps').innerHTML = chart([
    { name:'Ned', color:palette[0], pts: w.map(r=>({x:r.t, y:r.down_kbps==null?null:r.down_kbps/1000})) },
    { name:'Upp', color:palette[2], pts: w.map(r=>({x:r.t, y:r.up_kbps==null?null:r.up_kbps/1000})) },
  ], {days});
  const byAp = {};
  for (const r of s.aps) (byAp[r.ap_name] ??= []).push({x:r.t, y:r.retries_5g});
  $('c_retries').innerHTML = chart(Object.entries(byAp).map(([n, pts], i)=>({name:n, color:palette[i%palette.length], pts})), {days, maxL:50});
}

async function loadEvents() {
  const ev = await (await fetch('/api/events')).json();
  $('events').innerHTML = ev.length ? ev.map(e =>
    '<div><time>'+dt(e.ts)+'</time>'+pill(e.state==='resolved'?'ok':e.severity==='critical'?'crit':'warn', e.state==='resolved'?'OK':e.severity)+' '+e.message+'</div>').join('')
    : 'Inga händelser.';
}

let range = '24h';
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  range = b.dataset.r; [...$('tabs').children].forEach(x=>x.classList.toggle('on', x===b)); loadSeries(range);
});
function refresh(){ loadStatus().catch(console.error); loadSeries(range).catch(console.error); loadEvents().catch(console.error); }
refresh(); setInterval(refresh, 60_000);
</script>
</body>
</html>`;
