import { formatNotification } from "./rules.ts";
import type { AlertChange, Env } from "./types.ts";

/**
 * Skickar en notis per tillståndsbyte till ALERT_WEBHOOK.
 * Fungerar direkt med ntfy (https://ntfy.sh/<topic>): body = text, Title/Priority som headers.
 * För andra webhookar (Pushover, Slack, Discord) – byt body-format här; resten påverkas inte.
 */
export interface NotifyResult {
  delivered: boolean;
  status: number | null;
  response: string | null;
  error?: string;
}

export async function notify(env: Env, change: AlertChange): Promise<NotifyResult> {
  if (!env.ALERT_WEBHOOK) {
    console.log("notify (no webhook):", formatNotification(change));
    return { delivered: false, status: null, response: null, error: "ALERT_WEBHOOK saknas" };
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
    const body = await r.text();
    if (!r.ok) console.warn("notify failed", r.status, body);
    return { delivered: r.ok, status: r.status, response: body.slice(0, 500) };
  } catch (e) {
    console.warn("notify error", String(e));
    return { delivered: false, status: null, response: null, error: String(e) };
  }
}
