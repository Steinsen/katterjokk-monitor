#!/usr/bin/env bash
# Hämtar de id:n som ska in i wrangler.toml [vars]. Kör: UNIFI_API_KEY=... ./scripts/discover.sh
set -euo pipefail
: "${UNIFI_API_KEY:?Sätt UNIFI_API_KEY (Site Manager API-nyckel från konsolens ägarkonto)}"
H=(-H "X-API-Key: $UNIFI_API_KEY" -H "Accept: application/json")
API=https://api.ui.com/v1

echo "== Hosts (HOST_ID) =="
curl -sS "${H[@]}" "$API/hosts" | jq -r '.data[] | "\(.id)  type=\(.type)  ip=\(.ipAddress)  owner=\(.owner)"'

echo; echo "== Site Manager sites (SM_SITE_ID) =="
curl -sS "${H[@]}" "$API/sites" | jq -r '.data[] | "\(.siteId)  \(.meta.desc)  wifiClients=\(.statistics.counts.wifiClient)  wanUptime=\(.statistics.percentages.wanUptime)"'

HOST_ID=$(curl -sS "${H[@]}" "$API/hosts" | jq -r '.data[0].id')
echo; echo "== Cloud Connector → Network sites (NET_SITE_ID), host $HOST_ID =="
NET=$(curl -sS -w '\n%{http_code}' "${H[@]}" "$API/connector/consoles/$HOST_ID/network/integration/v1/sites")
CODE=$(tail -n1 <<<"$NET"); BODY=$(sed '$d' <<<"$NET")
if [[ "$CODE" != "200" ]]; then
  echo "Connector svarade $CODE: $BODY"
  echo "403 = nyckeln är inte från konsolens ägarkonto. 408 = konsolen offline eller UniFi OS < 5.0.3."
  exit 1
fi
jq -r '.data[] | "\(.id)  \(.name)"' <<<"$BODY"
NET_SITE_ID=$(jq -r '.data[0].id' <<<"$BODY")

echo; echo "== Networks (GUEST_NETWORK_ID = raden med vlan 30) =="
curl -sS "${H[@]}" "$API/connector/consoles/$HOST_ID/network/integration/v1/sites/$NET_SITE_ID/networks?limit=100" \
  | jq -r '.data[] | "\(.id)  vlan=\(.vlanId // "-")  \(.name)"'

echo; echo "== Devices (kontrollera att AP-modellerna börjar på AP_MODEL_PREFIX) =="
curl -sS "${H[@]}" "$API/connector/consoles/$HOST_ID/network/integration/v1/sites/$NET_SITE_ID/devices?limit=100" \
  | jq -r '.data[] | "\(.model)  \(.state)  \(.name)"'

echo; echo "== ISP just nu (FIBER_ASN – kör medan fibern är aktiv) =="
curl -sS "${H[@]}" "$API/isp-metrics/5m?duration=24h" \
  | jq -r '.data[0].periods | sort_by(.metricTime) | last | "asn=\(.data.wan.ispAsn)  isp=\(.data.wan.ispName)  latency=\(.data.wan.avgLatency)ms  loss=\(.data.wan.packetLoss)%  down=\(.data.wan.download_kbps)kbps"'
