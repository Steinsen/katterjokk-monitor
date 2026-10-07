import { formatNotification } from "./rules.ts";
import type { AlertChange, Env } from "./types.ts";

/**
 * Skickar en notis per tillståndsbyte till ALERT_WEBHOOK.
 * Fungerar direkt med ntfy (https://ntfy.sh/<topic>): body = text, Title/Priority som headers.
 * För andra webhookar (Pushover, Slack, Discord) – byt body-format här; resten påverkas inte.
 */
export async function notify(env: Env, change: AlertChange): Promise<void> {
  if (!env.ALERT_WEBHOOK) {
    console.log("notify (no webhook):", formatNotification(change));
    return;
  }
  const prio = change.state === "resolved" ? "default" : change.severity === "critical" ? "urgent" : "high";
  const title = change.state === "resolved" ? `Katterjåkk: ${change.rule} OK` : `Katterjåkk ${change.severity.toUpperCase()}: ${change.rule}`;
  try {
    const r = await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: title,
        Priority: prio,
        Tags: change.state === "resolved" ? "white_check_mark" : change.severity === "critical" ? "rotating_light" : "warning",
      },
      body: formatNotification(change),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.warn("notify failed", r.status, await r.text());
  } catch (e) {
    console.warn("notify error", String(e));
  }
}
