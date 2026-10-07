import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, step } from "../src/rules.ts";
import type { AlertState, ApSample, Sample, Snapshot, Thresholds } from "../src/types.ts";

const T: Thresholds = {
  lossPct: 5, latencyMs: 100, retriesPct: 20, dhcpPct: 80,
  silentMinClients: 20, silentMaxKbps: 500, skewFactor: 2.5, skewMinClients: 25, fiberAsn: "12345", backupIspMatch: "Telia Mobile", fiberIpPrefix: "198.51.",
};

const sample = (o: Partial<Sample> = {}): Sample => ({
  ts: 1_700_000_000, source_ok: 1, connector_ok: 1,
  wan_uptime: 100, wan_latency: 24, wan_latency_max: 40, wan_loss: 0,
  wan_down_kbps: 80_000, wan_up_kbps: 20_000, isp_asn: "12345", isp_name: "Fiber AB", wan_public_ip: "198.51.100.7",
  clients_total: 60, clients_wifi: 55, clients_wired: 5, clients_guest_vlan: 50, dhcp_pool_size: 249,
  aps_online: 7, aps_total: 7, ...o,
});

const ap = (name: string, o: Partial<ApSample> = {}): ApSample => ({
  ts: 1_700_000_000, ap_id: name, ap_name: name, state: "ONLINE", clients: 10,
  ch_2g: 1, width_2g: 20, retries_2g: 5, ch_5g: 36, width_5g: 40, retries_5g: 8,
  uplink_rx_bps: 1e6, uplink_tx_bps: 1e6, cpu_pct: 10, mem_pct: 40, ...o,
});

const snap = (s: Partial<Sample> = {}, aps: ApSample[] = [ap("A"), ap("B"), ap("C")]): Snapshot => ({ sample: sample(s), aps });

test("friskt nät ger inga brott", () => {
  assert.deepEqual(evaluate(snap(), T), []);
});

test("failover upptäcks via ASN-byte", () => {
  const v = evaluate(snap({ isp_asn: "3301", isp_name: "Telia" }), T);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, "wan_failover");
});

test("failover via ISP-namn fungerar även när fiber och 5G delar ASN", () => {
  const t = { ...T, fiberAsn: "" };
  assert.ok(evaluate(snap({ isp_asn: "3301", isp_name: "Telia Mobile" }), t).some((x) => x.rule === "wan_failover"));
  assert.ok(!evaluate(snap({ isp_asn: "3301", isp_name: "Telia Company AB" }), t).some((x) => x.rule === "wan_failover"));
});

test("failover via publik IP utanför fiberprefixet, oavsett vad ISP-metriken säger", () => {
  const v = evaluate(snap({ wan_public_ip: "90.231.4.17", isp_name: "Azqtel", isp_asn: "12345" }), T);
  assert.ok(v.some((x) => x.rule === "wan_failover" && /90\.231\.4\.17/.test(x.message)));
});

test("failover-regeln är helt av utan någon av de tre signalerna", () => {
  assert.deepEqual(evaluate(snap({ isp_asn: "3301", isp_name: "Telia Mobile", wan_public_ip: "1.2.3.4" }), { ...T, fiberAsn: "", backupIspMatch: "", fiberIpPrefix: "" }), []);
});

test("null-värden bryter aldrig en tröskel", () => {
  const v = evaluate(snap({ wan_loss: null, wan_latency: null, wan_uptime: null, clients_guest_vlan: null }, [ap("A", { retries_5g: null, state: null })]), T);
  assert.deepEqual(v, []);
});

test("wan_silent: många klienter, ingen trafik, fiber uppe", () => {
  const v = evaluate(snap({ clients_total: 40, wan_down_kbps: 100, wan_up_kbps: 50 }), T);
  assert.ok(v.some((x) => x.rule === "wan_silent"));
  // nattetid med få klienter → inget
  assert.ok(!evaluate(snap({ clients_total: 5, wan_down_kbps: 0, wan_up_kbps: 0 }), T).some((x) => x.rule === "wan_silent"));
});

test("ap_skew kräver både faktor och absolut antal", () => {
  const aps = [ap("A", { clients: 30 }), ap("B", { clients: 8 }), ap("C", { clients: 9 })];
  assert.ok(evaluate(snap({}, aps), T).some((x) => x.rule === "ap_skew" && x.subject === "A"));
  const small = [ap("A", { clients: 12 }), ap("B", { clients: 2 }), ap("C", { clients: 3 })];
  assert.ok(!evaluate(snap({}, small), T).some((x) => x.rule === "ap_skew"));
});

test("ap_offline öppnar först efter 2 körningar och stänger efter 2 OK", () => {
  const bad = evaluate(snap({}, [ap("107-108-109", { state: "OFFLINE" })]), T);
  let st: AlertState[] = [];
  let r = step(st, bad, 1000);
  assert.equal(r.changes.length, 0, "en mätning räcker inte");
  r = step(r.states, bad, 1300);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0]!.state, "open");
  r = step(r.states, bad, 1600);
  assert.equal(r.changes.length, 0, "inget nytt larm medan det är aktivt");
  r = step(r.states, [], 1900);
  assert.equal(r.changes.length, 0, "en OK-mätning stänger inte");
  r = step(r.states, [], 2200);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0]!.state, "resolved");
  assert.match(r.changes[0]!.message, /efter 15 min/);
});

test("en kort spike ger inget larm", () => {
  const loss = evaluate(snap({ wan_loss: 30 }), T);
  let r = step([], loss, 0);
  r = step(r.states, loss, 300);
  r = step(r.states, [], 600);
  r = step(r.states, loss, 900);
  assert.equal(r.changes.length, 0);
});
