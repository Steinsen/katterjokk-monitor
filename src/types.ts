export interface Env {
  DB: D1Database;
  UNIFI_API_KEY: string;
  ALERT_WEBHOOK?: string;

  HOST_ID: string;
  SM_SITE_ID: string;
  NET_SITE_ID: string;
  GUEST_NETWORK_ID: string;
  GUEST_SUBNET: string;
  FIBER_ASN: string;
  BACKUP_ISP_MATCH?: string;
  AP_MODEL_PREFIX: string;

  THRESH_LOSS_PCT: string;
  THRESH_LATENCY_MS: string;
  THRESH_RETRIES_PCT: string;
  THRESH_DHCP_PCT: string;
  SILENT_MIN_CLIENTS: string;
  SILENT_MAX_KBPS: string;
  SKEW_FACTOR: string;
  SKEW_MIN_CLIENTS: string;
  RETENTION_DAYS: string;
}

/** En rad i `samples`. null = värdet fanns inte i API:t den här körningen. */
export interface Sample {
  ts: number;
  source_ok: 0 | 1;
  connector_ok: 0 | 1;
  wan_uptime: number | null;
  wan_latency: number | null;
  wan_latency_max: number | null;
  wan_loss: number | null;
  wan_down_kbps: number | null;
  wan_up_kbps: number | null;
  isp_asn: string | null;
  isp_name: string | null;
  wan_public_ip: string | null;
  clients_total: number | null;
  clients_wifi: number | null;
  clients_wired: number | null;
  clients_guest_vlan: number | null;
  dhcp_pool_size: number | null;
  aps_online: number | null;
  aps_total: number | null;
}

/** En rad i `ap_samples`. */
export interface ApSample {
  ts: number;
  ap_id: string;
  ap_name: string;
  state: string | null;
  clients: number | null;
  ch_2g: number | null;
  width_2g: number | null;
  retries_2g: number | null;
  ch_5g: number | null;
  width_5g: number | null;
  retries_5g: number | null;
  uplink_rx_bps: number | null;
  uplink_tx_bps: number | null;
  cpu_pct: number | null;
  mem_pct: number | null;
}

export interface Snapshot {
  sample: Sample;
  aps: ApSample[];
}

export type Severity = "critical" | "warning" | "info";

export interface Thresholds {
  lossPct: number;
  latencyMs: number;
  retriesPct: number;
  dhcpPct: number;
  silentMinClients: number;
  silentMaxKbps: number;
  skewFactor: number;
  skewMinClients: number;
  fiberAsn: string;
  backupIspMatch: string;
}

export interface AlertState {
  rule: string;
  subject: string;
  active: 0 | 1;
  since: number | null;
  streak: number;
}

export interface AlertChange {
  rule: string;
  subject: string;
  severity: Severity;
  state: "open" | "resolved";
  message: string;
  ts: number;
}

export function thresholdsFromEnv(env: Env): Thresholds {
  const n = (v: string, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && v !== "" ? x : d;
  };
  return {
    lossPct: n(env.THRESH_LOSS_PCT, 5),
    latencyMs: n(env.THRESH_LATENCY_MS, 100),
    retriesPct: n(env.THRESH_RETRIES_PCT, 20),
    dhcpPct: n(env.THRESH_DHCP_PCT, 80),
    silentMinClients: n(env.SILENT_MIN_CLIENTS, 20),
    silentMaxKbps: n(env.SILENT_MAX_KBPS, 500),
    skewFactor: n(env.SKEW_FACTOR, 2.5),
    skewMinClients: n(env.SKEW_MIN_CLIENTS, 25),
    fiberAsn: env.FIBER_ASN ?? "",
    backupIspMatch: (env.BACKUP_ISP_MATCH ?? "").trim(),
  };
}
