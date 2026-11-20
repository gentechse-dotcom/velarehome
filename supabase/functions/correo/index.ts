// Función de Supabase: bandeja de entrada de paco@velarehome.com (IONOS).
// Solo responde a usuarios autenticados con el email del admin.
// Secretos (se ponen en Supabase → Edge Functions → Secrets, nunca en el código):
//   MAIL_USER  = paco@velarehome.com
//   MAIL_PASS  = contraseña del buzón de IONOS
//   ADMIN_EMAIL = paco@velarehome.com
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { ImapFlow } from "npm:imapflow@1.0.164";
import { simpleParser } from "npm:mailparser@3.7.1";
import nodemailer from "npm:nodemailer@6.9.15";

const IMAP = { host: "imap.ionos.es", port: 993, secure: true };
const SMTP = { host: "smtp.ionos.es", port: 465, secure: true };
const cors = {
  "Access-Control-Allow-Origin": "https://velarehome.com",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function adminOk(req: Request) {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data } = await sb.auth.getUser();
  return data.user?.email?.toLowerCase() === (Deno.env.get("ADMIN_EMAIL") ?? "").toLowerCase();
}

async function withImap<T>(fn: (c: ImapFlow) => Promise<T>) {
  const c = new ImapFlow({ ...IMAP, auth: { user: Deno.env.get("MAIL_USER")!, pass: Deno.env.get("MAIL_PASS")! }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => {}); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await adminOk(req))) return json({ error: "No autorizado" }, 401);
  const body = await req.json().catch(() => ({}));
  const folder = body.folder || "INBOX";
  try {
    switch (body.action) {
      case "list": {
        const page = Math.max(1, body.page || 1), per = 30;
        return json(await withImap(async (c) => {
          const lock = await c.getMailboxLock(folder);
          try {
            const total = (c.mailbox as any).exists as number;
            if (!total) return { total, items: [] };
            const end = Math.max(1, total - (page - 1) * per), start = Math.max(1, end - per + 1);
            const items: unknown[] = [];
            for await (const m of c.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, internalDate: true })) {
              items.push({ uid: m.uid, subject: m.envelope?.subject || "(sin asunto)", from: m.envelope?.from?.[0] ?? null,
                date: m.internalDate, seen: m.flags?.has("\\Seen") ?? false });
            }
            return { total, items: items.reverse() };
          } finally { lock.release(); }
        }));
      }
      case "read": {
        return json(await withImap(async (c) => {
          const lock = await c.getMailboxLock(folder);
          try {
            const msg = await c.fetchOne(String(body.uid), { source: true }, { uid: true });
            await c.messageFlagsAdd(String(body.uid), ["\\Seen"], { uid: true });
            const p = await simpleParser(msg.source);
            return { uid: body.uid, subject: p.subject, from: p.from?.value?.[0], to: p.to, date: p.date,
              messageId: p.messageId, text: p.text, html: p.html || null,
              attachments: (p.attachments || []).map((a) => ({ name: a.filename, size: a.size })) };
          } finally { lock.release(); }
        }));
      }
      case "send": {
        const t = nodemailer.createTransport({ ...SMTP, auth: { user: Deno.env.get("MAIL_USER")!, pass: Deno.env.get("MAIL_PASS")! } });
        const info = await t.sendMail({ from: `Paco Gatell · Velarehome <${Deno.env.get("MAIL_USER")}>`, to: body.to, subject: body.subject,
          text: body.text, inReplyTo: body.inReplyTo, references: body.inReplyTo });
        return json({ ok: true, id: info.messageId });
      }
      case "delete": {
        return json(await withImap(async (c) => {
          const lock = await c.getMailboxLock(folder);
          try { await c.messageMove(String(body.uid), "Papelera", { uid: true }).catch(() => c.messageDelete(String(body.uid), { uid: true })); return { ok: true }; }
          finally { lock.release(); }
        }));
      }
      default: return json({ error: "Acción desconocida" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
