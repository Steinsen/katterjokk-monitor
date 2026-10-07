-- Katterjåkk Network Monitor – D1 schema
-- Kör: wrangler d1 execute katterjokk-monitor --remote --file schema.sql

CREATE TABLE IF NOT EXISTS samples (
  ts                 INTEGER PRIMARY KEY,   -- unix s, avrundat till hel 5-min
  source_ok          INTEGER NOT NULL,      -- 1 = Site Manager svarade
  connector_ok       INTEGER NOT NULL,      -- 1 = Cloud Connector/UDM-SE svarade
  wan_uptime         REAL,                  -- % (isp-metrics)
  wan_latency        REAL,                  -- avgLatency ms
  wan_latency_max    REAL,                  -- maxLatency ms
  wan_loss           REAL,                  -- packetLoss %
  wan_down_kbps      INTEGER,
  wan_up_kbps        INTEGER,
  isp_asn            TEXT,
  isp_name           TEXT,
  clients_total      INTEGER,
  clients_wifi       INTEGER,
  clients_wired      INTEGER,
  clients_guest_vlan INTEGER,               -- IP i GUEST_SUBNET
  dhcp_pool_size     INTEGER,
  aps_online         INTEGER,
  aps_total          INTEGER
);

CREATE TABLE IF NOT EXISTS ap_samples (
  ts            INTEGER NOT NULL,
  ap_id         TEXT NOT NULL,
  ap_name       TEXT NOT NULL,
  state         TEXT,
  clients       INTEGER,
  ch_2g         INTEGER,
  width_2g      INTEGER,
  retries_2g    REAL,
  ch_5g         INTEGER,
  width_5g      INTEGER,
  retries_5g    REAL,
  uplink_rx_bps INTEGER,
  uplink_tx_bps INTEGER,
  cpu_pct       REAL,
  mem_pct       REAL,
  PRIMARY KEY (ts, ap_id)
);
CREATE INDEX IF NOT EXISTS ap_samples_ts ON ap_samples(ts);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  severity TEXT NOT NULL,     -- critical | warning | info
  rule     TEXT NOT NULL,
  subject  TEXT NOT NULL,     -- ap-namn eller 'wan'
  state    TEXT NOT NULL,     -- open | resolved
  message  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS alert_state (
  rule    TEXT NOT NULL,
  subject TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 0,
  since   INTEGER,
  streak  INTEGER NOT NULL DEFAULT 0,   -- >0: brott i rad, <0: ok i rad
  PRIMARY KEY (rule, subject)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
