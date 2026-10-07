import schemaSql from "../schema.sql";
import type { AlertChange, AlertState, ApSample, Sample, Snapshot } from "./types.ts";

let schemaReady = false;

/** Skapar tabellerna om de saknas. Körs en gång per isolat; idempotent (IF NOT EXISTS). */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  const stmts = schemaSql
    .split(";")
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean)
    .map((s) => db.prepare(s));
  await db.batch(stmts);
  schemaReady = true;
}

const SAMPLE_COLS: (keyof Sample)[] = [
  "ts", "source_ok", "connector_ok", "wan_uptime", "wan_latency", "wan_latency_max", "wan_loss",
  "wan_down_kbps", "wan_up_kbps", "isp_asn", "isp_name", "clients_total", "clients_wifi", "clients_wired",
  "clients_guest_vlan", "dhcp_pool_size", "aps_online", "aps_total",
];

const AP_COLS: (keyof ApSample)[] = [
  "ts", "ap_id", "ap_name", "state", "clients", "ch_2g", "width_2g", "retries_2g", "ch_5g", "width_5g",
  "retries_5g", "uplink_rx_bps", "uplink_tx_bps", "cpu_pct", "mem_pct",
];

const insertSql = (table: string, cols: string[]) =>
  `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;

export function writeSnapshot(db: D1Database, snap: Snapshot): D1PreparedStatement[] {
  const stmts = [db.prepare(insertSql("samples", SAMPLE_COLS)).bind(...SAMPLE_COLS.map((c) => snap.sample[c]))];
  for (const ap of snap.aps) {
    stmts.push(db.prepare(insertSql("ap_samples", AP_COLS)).bind(...AP_COLS.map((c) => ap[c])));
  }
  return stmts;
}

/** Backfill: skriv WAN-kolumner utan att skriva över rader som redan finns. */
export function writeBackfill(db: D1Database, rows: Partial<Sample>[]): D1PreparedStatement[] {
  const cols: (keyof Sample)[] = ["ts", "source_ok", "connector_ok", "wan_uptime", "wan_latency", "wan_latency_max", "wan_loss", "wan_down_kbps", "wan_up_kbps", "isp_asn", "isp_name"];
  const sql = `INSERT OR IGNORE INTO samples (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
  return rows.filter((r) => r.ts).map((r) => db.prepare(sql).bind(...cols.map((c) => r[c] ?? null)));
}

export async function readAlertStates(db: D1Database): Promise<AlertState[]> {
  const { results } = await db.prepare("SELECT rule, subject, active, since, streak FROM alert_state").all<AlertState>();
  return results ?? [];
}

export function writeAlertStates(db: D1Database, states: AlertState[], changes: AlertChange[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM alert_state")];
  for (const s of states) {
    stmts.push(
      db.prepare("INSERT INTO alert_state (rule, subject, active, since, streak) VALUES (?,?,?,?,?)").bind(s.rule, s.subject, s.active, s.since, s.streak),
    );
  }
  for (const c of changes) {
    stmts.push(
      db.prepare("INSERT INTO events (ts, severity, rule, subject, state, message) VALUES (?,?,?,?,?,?)").bind(c.ts, c.severity, c.rule, c.subject, c.state, c.message),
    );
  }
  return stmts;
}

export async function getMeta(db: D1Database, k: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(k).first<{ value: string }>();
  return row?.value ?? null;
}

export const setMeta = (db: D1Database, k: string, v: string) =>
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)").bind(k, v);

export async function cleanup(db: D1Database, retentionDays: number) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  await db.batch([
    db.prepare("DELETE FROM samples WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM ap_samples WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM events WHERE ts < ?").bind(cutoff),
  ]);
}

// ---------- läsningar för dashboarden ----------

export async function latest(db: D1Database) {
  const sample = await db.prepare("SELECT * FROM samples ORDER BY ts DESC LIMIT 1").first<Sample>();
  const aps = sample
    ? (await db.prepare("SELECT * FROM ap_samples WHERE ts = ? ORDER BY ap_name").bind(sample.ts).all<ApSample>()).results
    : [];
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const fail = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE rule = 'wan_failover' AND state = 'open' AND ts > ?")
    .bind(dayAgo)
    .first<{ n: number }>();
  const active = (await db.prepare("SELECT rule, subject, since FROM alert_state WHERE active = 1").all()).results;
  return { sample, aps, failovers24h: fail?.n ?? 0, active, stale: !sample || Date.now() / 1000 - sample.ts > 20 * 60 };
}

export type Range = "1h" | "24h" | "7d";

export async function series(db: D1Database, range: Range) {
  const now = Math.floor(Date.now() / 1000);
  const span = range === "1h" ? 3600 : range === "24h" ? 86400 : 7 * 86400;
  const from = now - span;
  // 7d: timupplösning så att svaret håller sig under ~170 punkter.
  const bucket = range === "7d" ? 3600 : 300;
  const wan = (
    await db
      .prepare(
        `SELECT (ts/?)*? AS t,
                AVG(wan_latency) AS latency, MAX(wan_latency_max) AS latency_max, AVG(wan_loss) AS loss,
                AVG(wan_uptime) AS uptime, AVG(wan_down_kbps) AS down_kbps, AVG(wan_up_kbps) AS up_kbps,
                AVG(clients_total) AS clients, AVG(clients_guest_vlan) AS guest, MIN(aps_online) AS aps_online,
                MIN(source_ok) AS source_ok
         FROM samples WHERE ts >= ? GROUP BY t ORDER BY t`,
      )
      .bind(bucket, bucket, from)
      .all()
  ).results;
  const aps = (
    await db
      .prepare(
        `SELECT (ts/?)*? AS t, ap_name,
                AVG(clients) AS clients, AVG(retries_2g) AS retries_2g, AVG(retries_5g) AS retries_5g,
                AVG(uplink_rx_bps + uplink_tx_bps) AS uplink_bps, MIN(CASE WHEN state='ONLINE' THEN 1 ELSE 0 END) AS online
         FROM ap_samples WHERE ts >= ? GROUP BY t, ap_name ORDER BY t`,
      )
      .bind(bucket, bucket, from)
      .all()
  ).results;
  return { range, bucket, from, to: now, wan, aps };
}

export async function events(db: D1Database, limit = 100) {
  return (await db.prepare("SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?").bind(limit).all()).results;
}
