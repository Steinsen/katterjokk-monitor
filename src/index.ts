import { DASHBOARD_HTML } from "./dashboard.ts";
import * as db from "./db.ts";
import { channels, notify } from "./notify.ts";
import { evaluate, step } from "./rules.ts";
import { setupHtml } from "./setup.ts";
import { thresholdsFromEnv, type Env } from "./types.ts";
import { backfillIsp, collect, debugCalls, discover, rawIspMetrics } from "./unifi.ts";

const CLEANUP_CRON = "17 3 * * *";

const configured = (env: Env) => Boolean(env.HOST_ID && env.SM_SITE_ID && env.NET_SITE_ID);

async function poll(env: Env, ctx: ExecutionContext) {
  if (!configured(env)) {
    console.warn("poll skipped: HOST_ID/SM_SITE_ID/NET_SITE_ID saknas i wrangler.toml – öppna /setup");
    return;
  }
  await db.ensureSchema(env.DB);
  const snap = await collect(env);

  // Första körningen: hämta 30 dagars WAN-historik så graferna inte börjar tomma.
  const stmts: D1PreparedStatement[] = [];
  if ((await db.getMeta(env.DB, "backfill_done")) !== "1") {
    try {
      stmts.push(...db.writeBackfill(env.DB, await backfillIsp(env)));
      stmts.push(db.setMeta(env.DB, "backfill_done", "1"));
    } catch (e) {
      console.warn("backfill skipped:", String(e));
    }
  }
  stmts.push(...db.writeSnapshot(env.DB, snap));

  const prev = await db.readAlertStates(env.DB);
  const { states, changes } = step(prev, evaluate(snap, thresholdsFromEnv(env)), snap.sample.ts);
  stmts.push(...db.writeAlertStates(env.DB, states, changes));

  // D1 batch tar max ~100 statements per anrop vid backfill; dela upp.
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));

  for (const c of changes) ctx.waitUntil(notify(env, c));
  console.log(`poll ok ts=${snap.sample.ts} clients=${snap.sample.clients_total} aps=${snap.sample.aps_online}/${snap.sample.aps_total} changes=${changes.length}`);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (ctrl.cron === CLEANUP_CRON) {
      await db.ensureSchema(env.DB);
      await db.cleanup(env.DB, Number(env.RETENTION_DAYS) || 90);
      return;
    }
    await poll(env, ctx);
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      // Setup-sidan: bara tills id:na är ifyllda, så att den inte ligger kvar öppen i onödan.
      if (url.pathname === "/setup") {
        if (configured(env)) return json({ error: "not found" }, 404);
        const data = await discover(env);
        if (url.searchParams.get("format") === "json") return json(data);
        return new Response(setupHtml(data, false), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname.startsWith("/api/")) await db.ensureSchema(env.DB);
      switch (url.pathname) {
        case "/api/status":
          return json({
            ...(await db.latest(env.DB)),
            config: {
              fiberIpPrefix: env.FIBER_IP_PREFIX ?? "",
              fiberLabel: env.FIBER_LABEL ?? "Fiber (WAN2, primär)",
              backupLabel: env.BACKUP_LABEL ?? "5G (WAN1, backup)",
            },
          });
        case "/api/series": {
          const r = url.searchParams.get("range");
          const range: db.Range = r === "1h" || r === "7d" ? r : "24h";
          return json(await db.series(env.DB, range));
        }
        case "/api/events":
          return json(await db.events(env.DB, 100));
        case "/api/debug":
          return json(await debugCalls(env));
        case "/api/raw/isp":
          // Felsökning: exakt vad UniFi:s isp-metrics returnerar (alla entries, alla fält).
          return json(await rawIspMetrics(env, url.searchParams.get("type") === "1h" ? "1h" : "5m"));
        case "/api/test-alert": {
          // Skickar en testnotis till ALERT_WEBHOOK och loggar den som info-händelse. GET räcker (lätt att öppna i mobilen).
          const sev = url.searchParams.get("severity");
          const change = {
            rule: "test",
            subject: "manuell",
            severity: (sev === "critical" || sev === "warning" ? sev : "info") as "critical" | "warning" | "info",
            state: (url.searchParams.get("state") === "resolved" ? "resolved" : "open") as "open" | "resolved",
            message: url.searchParams.get("msg") ?? "Testlarm från Katterjåkk Network Monitor",
            ts: Math.floor(Date.now() / 1000),
          };
          const results = await notify(env, change);
          await env.DB.prepare("INSERT INTO events (ts, severity, rule, subject, state, message) VALUES (?,?,?,?,?,?)")
            .bind(change.ts, change.severity, change.rule, change.subject, change.state, change.message).run();
          return json({ channels: channels(env), results, change });
        }
        case "/api/poll":
          // Manuell körning (skyddad av Cloudflare Access precis som resten).
          if (req.method !== "POST") return json({ error: "POST" }, 405);
          await poll(env, ctx);
          return json({ ok: true });
        case "/":
          return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      console.error(String(e));
      return json({ error: String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
