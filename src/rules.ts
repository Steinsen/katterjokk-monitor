/**
 * Larmregler. Rena funktioner utan I/O så att de går att testa.
 *
 *  evaluate(snapshot, thresholds)  -> vilka (regel, subjekt) som bryter just nu
 *  step(states, violations, ts)    -> nya tillstånd + de byten (open/resolved) som ska notifieras
 *
 * OBS: UniFi:s isp-metrics rapporterar WAN1 (inte aktiv WAN) och download_kbps/upload_kbps är den
 * abonnerade hastigheten, inte trafik. Därför finns ingen trafikbaserad regel (f.d. wan_silent).
 *
 * Ett larm öppnas när villkoret brutits `required` körningar i rad, och stängs
 * när det varit ok lika många körningar i rad. Däremellan: tyst.
 */
import type { AlertChange, AlertState, ApSample, Severity, Snapshot, Thresholds } from "./types.ts";

export interface Violation {
  rule: string;
  subject: string;
  severity: Severity;
  message: string;
}

export interface RuleDef {
  rule: string;
  severity: Severity;
  required: number; // körningar i rad (à 5 min)
  check: (s: Snapshot, t: Thresholds) => Violation[];
}

const v = (rule: string, severity: Severity, subject: string, message: string): Violation => ({
  rule,
  severity,
  subject,
  message,
});

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

const fmt = (x: number | null, unit = "") => (isNum(x) ? `${Math.round(x * 10) / 10}${unit}` : "–");

export const RULES: RuleDef[] = [
  {
    rule: "wan_down",
    severity: "critical",
    required: 2,
    check: ({ sample: s }) =>
      isNum(s.wan_uptime) && s.wan_uptime < 50
        ? [v("wan_down", "critical", "wan", `WAN uptime ${fmt(s.wan_uptime, " %")} senaste 5 min`)]
        : [],
  },
  {
    rule: "wan_failover",
    severity: "critical",
    required: 1,
    check: ({ sample: s }, t) => {
      const byName = Boolean(t.backupIspMatch) && typeof s.isp_name === "string" && s.isp_name.toLowerCase().includes(t.backupIspMatch.toLowerCase());
      const byAsn = Boolean(t.fiberAsn) && Boolean(s.isp_asn) && s.isp_asn !== t.fiberAsn;
      const byIp = Boolean(t.fiberIpPrefix) && typeof s.wan_public_ip === "string" && !s.wan_public_ip.startsWith(t.fiberIpPrefix);
      if (byIp) return [v("wan_failover", "critical", "wan", `Konsolens publika IP är ${s.wan_public_ip} (utanför ${t.fiberIpPrefix}*) – 5G-backup aktiv`)];
      return byName || byAsn
        ? [v("wan_failover", "critical", "wan", `Trafik går via ${s.isp_name ?? "okänd ISP"} (AS${s.isp_asn ?? "?"}) – 5G-backup aktiv`)]
        : [];
    },
  },
  {
    rule: "ap_offline",
    severity: "critical",
    required: 2,
    check: ({ aps }) =>
      aps
        .filter((a) => a.state !== null && a.state !== "ONLINE")
        .map((a) => v("ap_offline", "critical", a.ap_name, `AP ${a.ap_name} är ${a.state}`)),
  },
  {
    rule: "wan_loss",
    severity: "warning",
    required: 3,
    check: ({ sample: s }, t) =>
      isNum(s.wan_loss) && s.wan_loss > t.lossPct
        ? [v("wan_loss", "warning", "wan", `WAN packet loss ${fmt(s.wan_loss, " %")} (> ${t.lossPct} %)`)]
        : [],
  },
  {
    rule: "wan_latency",
    severity: "warning",
    required: 3,
    check: ({ sample: s }, t) =>
      isNum(s.wan_latency) && s.wan_latency > t.latencyMs
        ? [v("wan_latency", "warning", "wan", `WAN latency ${fmt(s.wan_latency, " ms")} (> ${t.latencyMs} ms)`)]
        : [],
  },
  {
    rule: "ap_retries",
    severity: "warning",
    required: 3,
    check: ({ aps }, t) =>
      aps.flatMap((a) => {
        const bands = [
          ["2.4 GHz", a.retries_2g],
          ["5 GHz", a.retries_5g],
        ] as const;
        const bad = bands.filter(([, r]) => isNum(r) && r > t.retriesPct);
        return bad.length
          ? [v("ap_retries", "warning", a.ap_name, `AP ${a.ap_name}: TX retries ${bad.map(([b, r]) => `${b} ${fmt(r, " %")}`).join(", ")} (> ${t.retriesPct} %)`)]
          : [];
      }),
  },
  {
    rule: "dhcp_pool",
    severity: "warning",
    required: 2,
    check: ({ sample: s }, t) => {
      if (!isNum(s.clients_guest_vlan) || !isNum(s.dhcp_pool_size) || s.dhcp_pool_size === 0) return [];
      const pct = (100 * s.clients_guest_vlan) / s.dhcp_pool_size;
      return pct > t.dhcpPct
        ? [v("dhcp_pool", "warning", "dhcp", `Guest-DHCP: ${s.clients_guest_vlan}/${s.dhcp_pool_size} adresser i bruk (${fmt(pct, " %")})`)]
        : [];
    },
  },
  {
    rule: "ap_skew",
    severity: "warning",
    required: 3,
    check: ({ aps }, t) => {
      const online = aps.filter((a) => a.state === "ONLINE" && isNum(a.clients)) as (ApSample & { clients: number })[];
      if (online.length < 3) return [];
      const counts = online.map((a) => a.clients).sort((a, b) => a - b);
      const median = counts[Math.floor(counts.length / 2)];
      const top = online.reduce((m, a) => (a.clients > m.clients ? a : m));
      return top.clients >= t.skewMinClients && top.clients > t.skewFactor * Math.max(median, 1)
        ? [v("ap_skew", "warning", top.ap_name, `AP ${top.ap_name} har ${top.clients} klienter, median ${median}`)]
        : [];
    },
  },
];

export function evaluate(snapshot: Snapshot, t: Thresholds): Violation[] {
  return RULES.flatMap((r) => r.check(snapshot, t));
}

const key = (rule: string, subject: string) => `${rule}\u0000${subject}`;

/**
 * Stega tillståndsmaskinen en körning framåt.
 * `states` är alla rader i alert_state; `violations` det evaluate() gav nu.
 */
export function step(
  states: AlertState[],
  violations: Violation[],
  ts: number,
): { states: AlertState[]; changes: AlertChange[] } {
  const required = new Map(RULES.map((r) => [r.rule, r.required]));
  const severity = new Map(RULES.map((r) => [r.rule, r.severity]));
  const byKey = new Map(states.map((s) => [key(s.rule, s.subject), { ...s }]));
  const nowViolating = new Map(violations.map((x) => [key(x.rule, x.subject), x]));
  const changes: AlertChange[] = [];

  // 1. Alla brott: öka streak, öppna när required nås.
  for (const [k, x] of nowViolating) {
    const st = byKey.get(k) ?? { rule: x.rule, subject: x.subject, active: 0 as const, since: null, streak: 0 };
    st.streak = st.streak > 0 ? st.streak + 1 : 1;
    const need = required.get(x.rule) ?? 1;
    if (!st.active && st.streak >= need) {
      st.active = 1;
      st.since = ts;
      changes.push({ rule: x.rule, subject: x.subject, severity: x.severity, state: "open", message: x.message, ts });
    }
    byKey.set(k, st);
  }

  // 2. Alla kända tillstånd som inte bryter nu: räkna ner, stäng när required nås.
  for (const [k, st] of byKey) {
    if (nowViolating.has(k)) continue;
    st.streak = st.streak < 0 ? st.streak - 1 : -1;
    const need = required.get(st.rule) ?? 1;
    if (st.active && -st.streak >= need) {
      st.active = 0;
      const mins = st.since ? Math.round((ts - st.since) / 60) : null;
      changes.push({
        rule: st.rule,
        subject: st.subject,
        severity: severity.get(st.rule) ?? "info",
        state: "resolved",
        message: `${st.rule} ${st.subject} åter OK${mins !== null ? ` efter ${mins} min` : ""}`,
        ts,
      });
      st.since = null;
    }
  }

  // Glöm inaktiva rader som varit OK länge, så tabellen inte växer.
  const kept = [...byKey.values()].filter((s) => s.active || s.streak > 0 || s.streak > -24);
  return { states: kept, changes };
}

export function formatNotification(c: AlertChange): string {
  const sev = c.state === "resolved" ? "OK" : c.severity.toUpperCase();
  const when = new Date(c.ts * 1000).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
  return `${sev} ${c.rule} ${c.subject} – ${c.message} (${when})`;
}
