# Katterjåkk Network Monitor

Liten övervakning av nätet i Katterjåkk (UDM-SE + U7 Lite, fiber + Telia 5G) som körs helt i Cloudflare.
Hämtar status var 5:e minut via UniFis officiella Site Manager API och dess Cloud Connector, sparar historik i D1,
larmar vid tillståndsbyten och visar en dashboard. **Ingen port öppnas mot Katterjåkk** – all trafik går till `api.ui.com`.

Designdokument: *Katterjåkk Network Monitor – design V1* (Claude Docs).

```
src/index.ts      scheduled() + fetch()
src/unifi.ts      insamling: Site Manager + Cloud Connector → Network Integration API
src/rules.ts      larmregler (rena funktioner, testade i test/)
src/db.ts         D1-skrivningar och dashboard-frågor
src/notify.ts     webhook (ntfy-format)
src/dashboard.ts  statisk HTML-dashboard
schema.sql        D1-schema
scripts/discover.sh  hämtar id:n till wrangler.toml
```

## Kom igång

Förutsättningar: Node 20+, ett Cloudflare-konto, UniFi OS ≥ 5.0.3 på UDM-SE.

```bash
npm install
npx wrangler login

# 1. API-nyckel: unifi.ui.com → API → Create API Key. Måste skapas från konsolens ÄGARKONTO
#    (Cloud Connector fungerar inte med en nyckel från ett extra admin-konto).
export UNIFI_API_KEY=...
./scripts/discover.sh                 # skriver ut HOST_ID, SM_SITE_ID, NET_SITE_ID, GUEST_NETWORK_ID, FIBER_ASN

# 2. Fyll i [vars] i wrangler.toml med värdena ovan.

# 3. Databas
npx wrangler d1 create katterjokk-monitor   # klistra in database_id i wrangler.toml
npm run db:init

# 4. Hemligheter (hamnar aldrig i repot)
npx wrangler secret put UNIFI_API_KEY
npx wrangler secret put ALERT_WEBHOOK       # t.ex. https://ntfy.sh/<långt-hemligt-topic>

# 5. Deploy
npm run deploy
```

Första cron-körningen gör backfill av 30 dagars WAN-historik från UniFi, så graferna är inte tomma från start.

### Provköra lokalt

```bash
npm run db:init:local
cp .dev.vars.example .dev.vars        # och fyll i nyckeln
npm run dev
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # kör en poll
open http://localhost:8787
```

### Skydda dashboarden

Worker:n har ingen egen inloggning. Lägg `katterjokk-monitor.<konto>.workers.dev` bakom **Cloudflare Access**
(Zero Trust → Access → Applications → Self-hosted, policy: Allow e-post = din). Gratis upp till 50 användare.
Gör det innan du delar länken; fram till dess är dashboarden publik (den innehåller inga hemligheter, men AP-namn och klientantal).

## Larm

Ett larm öppnas när villkoret brutits N körningar i rad och stängs när det varit OK N körningar i rad.
Trösklar ligger i `wrangler.toml` `[vars]`.

| Regel | Villkor | N × 5 min | Nivå |
|---|---|---|---|
| wan_down | WAN uptime < 50 % | 2 | critical |
| wan_failover | `ispAsn` ≠ `FIBER_ASN` | 1 | critical |
| ap_offline | AP state ≠ ONLINE | 2 | critical |
| wan_loss | packet loss > 5 % | 3 | warning |
| wan_latency | latency > 100 ms | 3 | warning |
| ap_retries | TX retries > 20 % på något band | 3 | warning |
| dhcp_pool | anslutna i guest-subnätet > 80 % av poolen | 2 | warning |
| ap_skew | en AP har > 2,5× medianen och ≥ 25 klienter | 3 | warning |
| wan_silent | ≥ 20 klienter men < 500 kbps WAN-trafik, fiber uppe | 6 | warning |

## Vad som inte finns i API:t

Channel utilization, WiFi Experience, signal/RSSI per klient, faktiska DHCP-leases och verklig throughput
exponeras inte av UniFis officiella API:er. Dashboarden visar dem som saknade, inte som noll. Se designdokumentet för V2 (lokal probe).

## Utveckling

```bash
npm run typecheck
npm test
npm run tail        # loggar från riktiga körningar
```
