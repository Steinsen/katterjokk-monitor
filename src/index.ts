import { DASHBOARD_HTML } from "./dashboard.ts";
import * as db from "./db.ts";
import { notify } from "./notify.ts";
import { evaluate, step } from "./rules.ts";
import { thresholdsFromEnv, type Env } from "./types.ts";
import { backfillIsp, collect } from "./unifi.ts";

const CLEANUP_CRON = "17 3 * * *";

async function poll(env: Env, ctx: ExecutionContext) {
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
      await db.cleanup(env.DB, Number(env.RETENTION_DAYS) || 90);
      return;
    }
    await poll(env, ctx);
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/api/status":
          return json(await db.latest(env.DB));
        case "/api/series": {
          const r = url.searchParams.get("range");
          const range: db.Range = r === "1h" || r === "7d" ? r : "24h";
          return json(await db.series(env.DB, range));
        }
        case "/api/events":
          return json(await db.events(env.DB, 100));
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
