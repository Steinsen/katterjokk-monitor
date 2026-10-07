/**
 * UniFi-insamling i två lager, båda via api.ui.com med samma read-only nyckel:
 *   1. Site Manager API      – sites, isp-metrics
 *   2. Cloud Connector       – proxar Network Integration API på UDM-SE
 * Inga anrop går direkt mot Katterjåkk.
 */
import type { ApSample, Env, Sample, Snapshot } from "./types.ts";

const SM_BASE = "https://api.ui.com/v1";
const TIMEOUT_MS = 28_000;

export class UnifiError extends Error {
  constructor(public path: string, public status: number, body: string) {
    super(`UniFi ${path} -> ${status}: ${body.slice(0, 200)}`);
  }
}

async function sm<T = any>(env: Env, path: string): Promise<T> {
  const r = await fetch(`${SM_BASE}${path}`, {
    headers: { "X-API-Key": env.UNIFI_API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new UnifiError(path, r.status, await r.text());
  return r.json() as Promise<T>;
}

/**
 * Host-id:t i Site Manager har formen "<hex>:<nummer>". Saknas suffixet (lätt att tappa vid kopiering)
 * slår vi upp det fulla id:t från /hosts en gång per isolat.
 */
let resolvedHostId: string | undefined;
export async function hostId(env: Env): Promise<string> {
  if (env.HOST_ID.includes(":")) return env.HOST_ID;
  if (resolvedHostId) return resolvedHostId;
  const hosts = await sm(env, "/hosts");
  const match = (hosts.data ?? []).find((h: any) => String(h.id).startsWith(env.HOST_ID)) ?? hosts.data?.[0];
  if (!match?.id) throw new Error(`HOST_ID ${env.HOST_ID} finns inte i /hosts`);
  console.warn(`HOST_ID saknar suffix – använder ${match.id} (rätta i wrangler.toml)`);
  resolvedHostId = String(match.id);
  return resolvedHostId;
}

/** Network Integration API på konsolen, via Cloud Connector. */
const net = async <T = any>(env: Env, path: string) =>
  sm<T>(env, `/connector/consoles/${await hostId(env)}/network/integration/v1${path}`);

async function allPages<T>(env: Env, path: string): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  const limit = 200;
  for (let i = 0; i < 10; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await net<{ data: T[]; totalCount?: number; count?: number }>(
      env,
      `${path}${sep}limit=${limit}&offset=${offset}`,
    );
    out.push(...(page.data ?? []));
    const total = page.totalCount ?? out.length;
    offset += page.data?.length ?? 0;
    if (offset >= total || !page.data?.length) break;
  }
  return out;
}

const ok = <T>(r: PromiseSettledResult<T>): T | undefined =>
  r.status === "fulfilled" ? r.value : undefined;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Avrunda till den 5-minutersperiod som just passerat (matchar metricTime). */
export const periodTs = (nowMs = Date.now()) => Math.floor(nowMs / 300_000) * 300;

interface IspPeriod {
  metricTime: string;
  data: { wan: Record<string, any> };
}

export function latestIspPeriod(isp: any, siteId: string): IspPeriod | undefined {
  const rows: any[] = isp?.data ?? isp?.data?.metrics ?? [];
  const site = rows.find((m) => m.siteId === siteId) ?? rows[0];
  const periods: IspPeriod[] = site?.periods ?? [];
  return periods.reduce<IspPeriod | undefined>(
    (best, p) => (!best || p.metricTime > best.metricTime ? p : best),
    undefined,
  );
}

function radio(radios: any[] | undefined, ghz: number) {
  return radios?.find((r) => Number(r.frequencyGHz) === ghz);
}

export async function collect(env: Env, nowMs = Date.now()): Promise<Snapshot> {
  const ts = periodTs(nowMs);
  const site = env.NET_SITE_ID;

  const [sitesR, ispR, devicesR, clientsR, guestNetR, hostR] = await Promise.allSettled([
    sm(env, "/sites"),
    sm(env, "/isp-metrics/5m?duration=24h"),
    allPages<any>(env, `/sites/${site}/devices`),
    allPages<any>(env, `/sites/${site}/clients`),
    env.GUEST_NETWORK_ID ? net(env, `/sites/${site}/networks/${env.GUEST_NETWORK_ID}`) : Promise.reject(new Error("no GUEST_NETWORK_ID")),
    hostId(env).then((id) => sm(env, `/hosts/${id}`)),
  ]);

  for (const r of [sitesR, ispR, devicesR, clientsR]) {
    if (r.status === "rejected") console.warn("collect:", String(r.reason));
  }

  const devices = ok(devicesR) ?? [];
  const prefix = env.AP_MODEL_PREFIX || "U7";
  const aps = devices.filter((d) => typeof d.model === "string" && d.model.startsWith(prefix));

  // Listan ger bara grunddata; kanal/bredd per radio finns i detaljanropet. Statistik i ett eget.
  const [statsR, detailR] = await Promise.all([
    Promise.allSettled(aps.map((ap) => net(env, `/sites/${site}/devices/${ap.id}/statistics/latest`))),
    Promise.allSettled(aps.map((ap) => net(env, `/sites/${site}/devices/${ap.id}`))),
  ]);

  const smSite = ok(sitesR)?.data?.find((s: any) => s.siteId === env.SM_SITE_ID);
  const wan = latestIspPeriod(ok(ispR), env.SM_SITE_ID)?.data?.wan;
  const clients = ok(clientsR) ?? [];

  const perAp = new Map<string, number>();
  for (const c of clients) {
    const id = c.uplinkDeviceId;
    if (id) perAp.set(id, (perAp.get(id) ?? 0) + 1);
  }

  const pool = poolSize(ok(guestNetR));

  const sample: Sample = {
    ts,
    source_ok: smSite ? 1 : 0,
    connector_ok: devicesR.status === "fulfilled" ? 1 : 0,
    wan_uptime: num(wan?.uptime),
    wan_latency: num(wan?.avgLatency),
    wan_latency_max: num(wan?.maxLatency),
    wan_loss: num(wan?.packetLoss),
    wan_down_kbps: num(wan?.download_kbps),
    wan_up_kbps: num(wan?.upload_kbps),
    isp_asn: wan?.ispAsn != null ? String(wan.ispAsn) : null,
    isp_name: wan?.ispName ?? null,
    wan_public_ip: ok(hostR)?.data?.ipAddress ?? null,
    clients_total: clientsR.status === "fulfilled" ? clients.length : num(smSite?.statistics?.counts?.wifiClient) ,
    clients_wifi: clientsR.status === "fulfilled" ? clients.filter((c) => c.type === "WIRELESS").length : null,
    clients_wired: clientsR.status === "fulfilled" ? clients.filter((c) => c.type === "WIRED").length : null,
    clients_guest_vlan:
      clientsR.status === "fulfilled"
        ? clients.filter((c) => typeof c.ipAddress === "string" && c.ipAddress.startsWith(env.GUEST_SUBNET)).length
        : null,
    dhcp_pool_size: pool,
    aps_online: devicesR.status === "fulfilled" ? aps.filter((a) => a.state === "ONLINE").length : null,
    aps_total: devicesR.status === "fulfilled" ? aps.length : num(smSite?.statistics?.counts?.wifiDevice),
  };

  const apSamples: ApSample[] = aps.map((ap, i) => {
    const st = ok(statsR[i]);
    const det = ok(detailR[i]);
    const radios = det?.interfaces?.radios ?? ap.interfaces?.radios;
    const r2 = radio(radios, 2.4);
    const r5 = radio(radios, 5);
    const s2 = radio(st?.interfaces?.radios, 2.4);
    const s5 = radio(st?.interfaces?.radios, 5);
    return {
      ts,
      ap_id: String(ap.id),
      ap_name: String(ap.name ?? ap.macAddress ?? ap.id),
      state: det?.state ?? ap.state ?? null,
      clients: perAp.get(ap.id) ?? 0,
      ch_2g: num(r2?.channel),
      width_2g: num(r2?.channelWidthMHz),
      retries_2g: num(s2?.txRetriesPct),
      ch_5g: num(r5?.channel),
      width_5g: num(r5?.channelWidthMHz),
      retries_5g: num(s5?.txRetriesPct),
      uplink_rx_bps: num(st?.uplink?.rxRateBps),
      uplink_tx_bps: num(st?.uplink?.txRateBps),
      cpu_pct: num(st?.cpuUtilizationPct),
      mem_pct: num(st?.memoryUtilizationPct),
    };
  });

  return { sample, aps: apSamples };
}

/** Antal adresser i DHCP-poolen, från networks/{id}. */
export function poolSize(network: any): number | null {
  const range = network?.ipv4Configuration?.dhcpConfiguration?.ipAddressRange;
  if (!range?.start || !range?.stop) return null;
  const toInt = (ip: string) =>
    ip.split(".").reduce((acc, oct) => acc * 256 + Number(oct), 0);
  const n = toInt(range.stop) - toInt(range.start) + 1;
  return n > 0 ? n : null;
}

/**
 * Setup-hjälp: allt som behövs för [vars] i wrangler.toml, i ett anrop.
 * Används av /setup tills NET_SITE_ID är satt. Inget här är hemligt.
 */
export async function discover(env: Env) {
  const out: Record<string, any> = {};
  const hosts = await sm(env, "/hosts").catch((e) => ({ error: String(e) }));
  out.hosts = (hosts.data ?? []).map((h: any) => ({
    HOST_ID: h.id, type: h.type, ip: h.ipAddress, owner: h.owner,
    connected: h.reportedState?.state ?? h.userData?.consoleGroupMembers?.[0]?.roleAttributes?.connectedState ?? null,
  }));
  if (hosts.error) out.hosts_error = hosts.error;

  const sites = await sm(env, "/sites").catch((e) => ({ error: String(e) }));
  out.sites = (sites.data ?? []).map((s: any) => ({
    SM_SITE_ID: s.siteId, name: s.meta?.desc, hostId: s.hostId,
    wifiClients: s.statistics?.counts?.wifiClient, wifiDevices: s.statistics?.counts?.wifiDevice,
    wanUptime: s.statistics?.percentages?.wanUptime, isp: s.statistics?.ispInfo?.name,
  }));
  if (sites.error) out.sites_error = sites.error;

  const isp = await sm(env, "/isp-metrics/5m?duration=24h").catch((e) => ({ error: String(e) }));
  const p = latestIspPeriod(isp, env.SM_SITE_ID);
  out.isp_now = p ? { metricTime: p.metricTime, note: "isp-metrics följer WAN1, inte aktiv WAN", ...p.data?.wan } : (isp.error ?? null);

  const hostId = env.HOST_ID || out.hosts?.[0]?.HOST_ID;
  if (!hostId) return out;
  const envH = { ...env, HOST_ID: hostId };
  const netSites = await net(envH, "/sites").catch((e) => ({ error: String(e) }));
  out.network_sites = (netSites.data ?? []).map((s: any) => ({ NET_SITE_ID: s.id, name: s.name }));
  if (netSites.error) {
    out.connector_error = netSites.error;
    out.connector_hint = "403 = API-nyckeln är inte från konsolens ägarkonto. 408 = konsolen är offline eller UniFi OS < 5.0.3.";
    return out;
  }
  const netSite = env.NET_SITE_ID || netSites.data?.[0]?.id;
  if (!netSite) return out;
  const [networks, devices] = await Promise.all([
    net(envH, `/sites/${netSite}/networks?limit=100`).catch((e) => ({ error: String(e) })),
    net(envH, `/sites/${netSite}/devices?limit=100`).catch((e) => ({ error: String(e) })),
  ]);
  out.networks = (networks.data ?? []).map((n: any) => ({
    GUEST_NETWORK_ID: n.id, name: n.name, vlan: n.vlanId ?? null,
    dhcpRange: n.ipv4Configuration?.dhcpConfiguration?.ipAddressRange ?? null,
  }));
  out.devices = (devices.data ?? []).map((d: any) => ({ model: d.model, name: d.name, state: d.state }));
  return out;
}

/** Felsökning: provar varje anrop monitorn gör och rapporterar status/fel per anrop. Inga hemligheter i svaret. */
export async function debugCalls(env: Env) {
  const site = env.NET_SITE_ID;
  const probe = async (name: string, fn: () => Promise<any>, pick: (r: any) => unknown) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      return { call: name, ok: true, ms: Date.now() - t0, summary: pick(r) };
    } catch (e) {
      const err = e as UnifiError;
      return { call: name, ok: false, ms: Date.now() - t0, status: err.status ?? null, error: String(err.message ?? e) };
    }
  };
  return {
    config: { HOST_ID: env.HOST_ID, SM_SITE_ID: env.SM_SITE_ID, NET_SITE_ID: site, GUEST_NETWORK_ID: env.GUEST_NETWORK_ID },
    calls: [
      await probe("GET /hosts", () => sm(env, "/hosts"), (r) => r.data?.map((h: any) => ({ id: h.id, ip: h.ipAddress, type: h.type }))),
      await probe("GET /hosts/{HOST_ID}", async () => sm(env, `/hosts/${await hostId(env)}`), (r) => ({ id: r.data?.id, ip: r.data?.ipAddress })),
      await probe("GET /sites", () => sm(env, "/sites"), (r) => r.data?.map((s: any) => ({ siteId: s.siteId, hostId: s.hostId, wifiClient: s.statistics?.counts?.wifiClient }))),
      await probe("connector /sites", () => net(env, "/sites"), (r) => r.data?.map((s: any) => ({ id: s.id, name: s.name }))),
      await probe("connector /devices", () => net(env, `/sites/${site}/devices?limit=100`), (r) => ({ count: r.data?.length, sample: r.data?.slice(0, 3).map((d: any) => ({ model: d.model, name: d.name, state: d.state })) })),
      await probe("connector /clients", () => net(env, `/sites/${site}/clients?limit=5`), (r) => ({ totalCount: r.totalCount, sample: r.data?.slice(0, 2).map((c: any) => ({ type: c.type, ip: c.ipAddress, uplink: c.uplinkDeviceId })) })),
    ],
  };
}

/** Rådata från isp-metrics, för att verifiera vilken WAN UniFi rapporterar. */
export const rawIspMetrics = (env: Env, type: "5m" | "1h" = "5m") =>
  sm(env, `/isp-metrics/${type}?duration=${type === "5m" ? "24h" : "7d"}`);

/** 30 dagars WAN-historik (timupplösning) för första starten. */
export async function backfillIsp(env: Env): Promise<Partial<Sample>[]> {
  const isp = await sm(env, "/isp-metrics/1h?duration=30d");
  const rows: any[] = isp?.data ?? [];
  const site = rows.find((m) => m.siteId === env.SM_SITE_ID) ?? rows[0];
  return (site?.periods ?? []).map((p: any) => ({
    ts: Math.floor(Date.parse(p.metricTime) / 1000),
    source_ok: 1 as const,
    connector_ok: 0 as const,
    wan_uptime: num(p.data?.wan?.uptime),
    wan_latency: num(p.data?.wan?.avgLatency),
    wan_latency_max: num(p.data?.wan?.maxLatency),
    wan_loss: num(p.data?.wan?.packetLoss),
    wan_down_kbps: num(p.data?.wan?.download_kbps),
    wan_up_kbps: num(p.data?.wan?.upload_kbps),
    isp_asn: p.data?.wan?.ispAsn != null ? String(p.data.wan.ispAsn) : null,
    isp_name: p.data?.wan?.ispName ?? null,
    wan_public_ip: null,
  }));
}
