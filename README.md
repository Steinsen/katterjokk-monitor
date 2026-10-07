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

Repot är kopplat till Cloudflare Workers Builds: varje push till `main` bygger och deployar Worker:n.
Inget körs lokalt och inga Wrangler-kommandon behövs – Worker:n skapar sina D1-tabeller själv vid första körningen.

**1. Cloudflare-dashboarden** (Workers & Pages → katterjokk-monitor)
- Settings → Variables and Secrets: lägg `UNIFI_API_KEY` och `ALERT_WEBHOOK` som **Secret**.
  Nyckeln skapas på unifi.ui.com → API → Create API Key, **från konsolens ägarkonto** (Cloud Connector fungerar inte med en nyckel från ett extra admin-konto).
  Webhook t.ex. `https://ntfy.sh/<långt-slumpat-topic>`; prenumerera på samma topic i ntfy-appen.
- Settings → Bindings: D1 `DB` → `katterjokk-monitor` (skapa databasen under Storage & Databases → D1 om den saknas) och se till att `database_id` i `wrangler.toml` matchar.
- Settings → Domains & Routes: **Enable** workers.dev så att dashboarden får en adress.

**2. Öppna `https://katterjokk-monitor.<subdomän>.workers.dev/setup`.** Sidan hämtar HOST_ID, SM_SITE_ID, NET_SITE_ID,
nätverken (ta raden med vlan 30 som GUEST_NETWORK_ID) och konsolens publika IP (FIBER_IP_PREFIX = början på fiberns IP) via din API-nyckel.
Står det 403 under Cloud Connector är nyckeln från fel konto; 408 betyder att konsolen är offline eller har UniFi OS < 5.0.3.

**3. Fyll i `wrangler.toml`** på GitHub (penn-ikonen) under `[vars]` och committa till `main`. HOST_ID har formen `<hex>:<nummer>` – ta med suffixet efter kolon. Cloudflare bygger om.
När NET_SITE_ID är satt stängs `/setup` (svarar 404) och cron börjar polla var 5:e minut. Första körningen backfyller 30 dagars WAN-historik.

Ändrar du en tröskel i `wrangler.toml` räcker det att committa igen. OBS: `wrangler deploy` skriver över *variabler* med dem i `wrangler.toml`,
men rör inte *secrets* – så håll icke-hemliga värden i filen och hemligheter i dashboarden.

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
(Zero Trust → Access → Applications → Self-hosted, policy: Allow e-post = din; eller Worker-sidans flik **Access** → Enable). Gratis upp till 50 användare.
Gör det innan du delar länken; fram till dess är dashboarden publik (den innehåller inga hemligheter, men AP-namn och klientantal).

## Larm

Ett larm öppnas när villkoret brutits N körningar i rad och stängs när det varit OK N körningar i rad.
Trösklar ligger i `wrangler.toml` `[vars]`.

| Regel | Villkor | N × 5 min | Nivå |
|---|---|---|---|
| wan_down | WAN uptime < 50 % | 2 | critical |
| wan_failover | konsolens publika IP (från `/hosts`) ligger utanför `FIBER_IP_PREFIX` | 1 | critical |
| ap_offline | AP state ≠ ONLINE | 2 | critical |
| wan_loss | packet loss > 5 % | 3 | warning |
| wan_latency | latency > 100 ms | 3 | warning |
| ap_retries | TX retries > 20 % på något band | 3 | warning |
| dhcp_pool | anslutna i guest-subnätet > 80 % av poolen | 2 | warning |
| ap_skew | en AP har > 2,5× medianen och ≥ 25 klienter | 3 | warning |

## Notiskanaler

Alla kanaler är valfria och styrs av secrets i Cloudflare-dashboarden; larm går till alla som är konfigurerade.

| Kanal | Secrets | Så får du dem |
|---|---|---|
| E-post (Resend, gratis 100/dag) | `RESEND_API_KEY`, `ALERT_EMAIL_TO` | resend.com → API Keys. Utan verifierad domän kan Resend bara skicka till adressen kontot är registrerat på – sätt `ALERT_EMAIL_TO` till den. |
| Telegram (gratis) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Skriv till @BotFather → `/newbot` → token. Skicka ett meddelande till din nya bot, öppna sedan `https://api.telegram.org/bot<TOKEN>/getUpdates` och läs `chat.id`. |
| Pushover (engångsköp) | `PUSHOVER_TOKEN`, `PUSHOVER_USER` | pushover.net → Create an Application (token) + user key på startsidan. |
| Generisk webhook / ntfy | `ALERT_WEBHOOK` | Hela URL:en. **ntfy.sh gratis fungerar inte från Workers** – kvoten räknas per IP och Workers delar IP (429). Egen ntfy-server eller betalplan går bra. |

## Testa larmkedjan

`GET /api/test-alert` skickar en testnotis till `ALERT_WEBHOOK` och loggar den under Händelser.
Parametrar: `?severity=critical|warning|info` (default info), `?state=open|resolved`, `?msg=valfri text`.
Svaret listar konfigurerade kanaler och HTTP-status från var och en.

## Vad som inte finns i API:t

Channel utilization, WiFi Experience, signal/RSSI per klient, faktiska DHCP-leases, WAN-trafik och verklig throughput
exponeras inte av UniFis officiella API:er. Verifierat 2026-10-07 mot rådata: `isp-metrics` rapporterar **WAN1** oavsett
vilken WAN som är aktiv, och `download_kbps`/`upload_kbps` är den abonnerade hastigheten (konstant), inte trafik.
Med fibern på WAN2 mäter latency/loss alltså 5G-backupen – byt WAN-tilldelning i UDM-SE (fiber → WAN1) om du vill
att metriken ska gälla fibern. Aktiv väg avgörs i stället via konsolens publika IP (`FIBER_IP_PREFIX`). Dashboarden visar dem som saknade, inte som noll. Se designdokumentet för V2 (lokal probe).

## Utveckling

```bash
npm run typecheck
npm test
npm run tail        # loggar från riktiga körningar
```
