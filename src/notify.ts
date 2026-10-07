import { formatNotification } from "./rules.ts";
import type { AlertChange, Env } from "./types.ts";

/**
 * Skickar en notis per tillståndsbyte till alla kanaler som är konfigurerade (secrets).
 *
 *  ALERT_WEBHOOK                       generisk POST med text-body (ntfy-format). OBS: ntfy.sh gratis räknar
 *                                      kvot per avsändar-IP och Workers delar IP – räkna med 429.
 *  RESEND_API_KEY + ALERT_EMAIL_TO     e-post via https://resend.com (gratis 100/dag). Utan egen domän kan
 *                                      Resend bara skicka till kontots egen adress – vilket räcker för larm till dig själv.
 *  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  Telegram-bot (gratis, ingen praktisk kvot).
 *  PUSHOVER_TOKEN + PUSHOVER_USER      Pushover (engångsköp).
 */
export interface ChannelResult {
  channel: string;
  delivered: boolean;
  status: number | null;
  response: string | null;
  error?: string;
}

const title = (c: AlertChange) =>
  c.state === "resolved" ? `Katterjåkk: ${c.rule} OK` : `Katterjåkk ${c.severity.toUpperCase()}: ${c.rule}`;

async function send(channel: string, req: () => Promise<Response>): Promise<ChannelResult> {
  try {
    const r = await req();
    const body = (await r.text()).slice(0, 500);
    if (!r.ok) console.warn(`notify ${channel} failed`, r.status, body);
    return { channel, delivered: r.ok, status: r.status, response: body };
  } catch (e) {
    console.warn(`notify ${channel} error`, String(e));
    return { channel, delivered: false, status: null, response: null, error: String(e) };
  }
}

export function channels(env: Env): string[] {
  const out: string[] = [];
  if (env.ALERT_WEBHOOK) out.push("webhook");
  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) out.push("email");
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.push("telegram");
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) out.push("pushover");
  return out;
}

export async function notify(env: Env, change: AlertChange): Promise<ChannelResult[]> {
  const text = formatNotification(change);
  const ttl = title(change);
  const critical = change.state === "open" && change.severity === "critical";
  const timeout = () => AbortSignal.timeout(10_000);
  const jobs: Promise<ChannelResult>[] = [];

  if (env.ALERT_WEBHOOK) {
    jobs.push(
      send("webhook", () =>
        fetch(env.ALERT_WEBHOOK!, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Title: ttl,
            Priority: change.state === "resolved" ? "default" : critical ? "urgent" : "high",
            Tags: change.state === "resolved" ? "white_check_mark" : critical ? "rotating_light" : "warning",
          },
          body: text,
          signal: timeout(),
        }),
      ),
    );
  }

  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    jobs.push(
      send("email", () =>
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: env.ALERT_EMAIL_FROM || "Katterjåkk Monitor <onboarding@resend.dev>",
            to: (env.ALERT_EMAIL_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean),
            subject: ttl,
            text: `${text}\n\n${change.message}\n\nDashboard: ${env.DASHBOARD_URL ?? ""}`.trim(),
          }),
          signal: timeout(),
        }),
      ),
    );
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      send("telegram", () =>
        fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `${critical ? "🚨" : change.state === "resolved" ? "✅" : "⚠️"} ${ttl}\n${text}`,
            disable_notification: change.state === "resolved",
          }),
          signal: timeout(),
        }),
      ),
    );
  }

  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) {
    const form = new URLSearchParams({
      token: env.PUSHOVER_TOKEN,
      user: env.PUSHOVER_USER,
      title: ttl,
      message: text,
      priority: critical ? "1" : change.state === "resolved" ? "-1" : "0",
    });
    jobs.push(send("pushover", () => fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form, signal: timeout() })));
  }

  if (!jobs.length) {
    console.log("notify (ingen kanal konfigurerad):", text);
    return [];
  }
  return Promise.all(jobs);
}
