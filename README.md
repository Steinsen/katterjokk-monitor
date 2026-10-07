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

## Kom igång – helt från webbläsaren

Allt körs via GitHub Actions; inget behöver installeras lokalt. Förutsättning: UniFi OS ≥ 5.0.3 på UDM-SE.

**1. Hemligheter i GitHub** – repot → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Var du hämtar den |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare-dashboarden → Workers & Pages → Account ID i högerspalten |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → mallen **Edit Cloudflare Workers**, lägg till permission **D1: Edit** |
| `UNIFI_API_KEY` | unifi.ui.com → API → Create API Key. **Från konsolens ägarkonto** – Cloud Connector fungerar inte med en nyckel från ett extra admin-konto |
| `ALERT_WEBHOOK` | t.ex. `https://ntfy.sh/<långt-slumpat-topic>` (installera ntfy-appen och prenumerera på samma topic) |

**2. Hämta id:n** – Actions-fliken → *Discover* → Run workflow. Öppna loggen: den listar HOST_ID, SM_SITE_ID, NET_SITE_ID, nätverken (ta raden med `vlan=30` som GUEST_NETWORK_ID), nuvarande ISP-ASN (FIBER_ASN) och skapar D1-databasen med dess `database_id`. Går connector-steget fel säger loggen varför (403 = fel konto, 408 = konsolen nere eller för gammal firmware).

**3. Fyll i `wrangler.toml`** direkt på GitHub (penn-ikonen): `database_id` och de fem värdena under `[vars]`. Commit till `main`.

**4. Klart.** Commiten triggar *Deploy*: typecheck, tester, schema, deploy, secrets. Första mätningen kommer inom 5 minuter; första körningen backfyller också 30 dagars WAN-historik från UniFi.

Dashboarden ligger på `https://katterjokk-monitor.<ditt-subdomän>.workers.dev` (adressen syns i Cloudflare → Workers & Pages → katterjokk-monitor).

Ändrar du en tröskel i `wrangler.toml` eller koden räcker det att committa till `main` igen.

### Provköra lokalt (valfritt, om du har en maskin där det går)

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
