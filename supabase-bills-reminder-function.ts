// Supabase Edge Function: bills-reminder
// Deploy name: bills-reminder
// Runs once a day (see the SQL cron job below) and sends a real push
// notification for:
//  - bills due in BILLS_REMINDER_DAYS_BEFORE days
//  - garage documents (vignette, insurance, inspection, ...) expiring in
//    DOCS_REMINDER_DAYS_BEFORE days

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const BILLS_REMINDER_DAYS_BEFORE = 3; // how many days before a bill is due to notify
const DOCS_REMINDER_DAYS_BEFORE = 7;  // how many days before a document expires to notify

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:dobrimahovofficial@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function dateKey(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseKey(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysInMonth(y: number, m: number) {
  return new Date(y, m + 1, 0).getDate();
}
function labelOf(d: Date) {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Returns true if `item` has a bill occurrence exactly on `target`, and it
// isn't already marked paid and isn't past its stop date (endKey).
function billOccursOn(item: any, target: Date): boolean {
  const first = parseKey(item.date);
  if (target < first) return false;
  if (item.endKey && target > parseKey(item.endKey)) return false;

  const key = dateKey(target.getFullYear(), target.getMonth(), target.getDate());
  if (item.paid && item.paid[key]) return false;

  if (item.repeat === 'monthly') {
    const day = item.day || first.getDate();
    return target.getDate() === Math.min(day, daysInMonth(target.getFullYear(), target.getMonth()));
  }
  if (item.repeat === 'weekly') {
    const diffDays = Math.round((target.getTime() - first.getTime()) / 86400000);
    return diffDays >= 0 && diffDays % 7 === 0;
  }
  if (item.repeat === 'yearly') {
    const day = Math.min(first.getDate(), daysInMonth(target.getFullYear(), first.getMonth()));
    return target.getMonth() === first.getMonth() && target.getDate() === day;
  }
  // 'none' — one-time
  return key === item.date;
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const billTarget = new Date();
  billTarget.setDate(billTarget.getDate() + BILLS_REMINDER_DAYS_BEFORE);
  billTarget.setHours(0, 0, 0, 0);
  const billTargetKey = dateKey(billTarget.getFullYear(), billTarget.getMonth(), billTarget.getDate());

  const docTarget = new Date();
  docTarget.setDate(docTarget.getDate() + DOCS_REMINDER_DAYS_BEFORE);
  docTarget.setHours(0, 0, 0, 0);
  const docTargetKey = dateKey(docTarget.getFullYear(), docTarget.getMonth(), docTarget.getDate());

  const { data: rows, error } = await sb.from('app_state').select('user_id, data');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let sent = 0;
  for (const row of rows || []) {
    const lines: string[] = [];

    const billItems = row.data?.bills?.items || [];
    const dueBills = billItems.filter((it: any) => billOccursOn(it, billTarget));
    dueBills.forEach((b: any) => {
      lines.push(`💳 ${b.title}${b.amount ? ' — ' + b.amount + ' €' : ''} (${labelOf(billTarget)})`);
    });

    const vehicles = row.data?.garage?.vehicles || [];
    const records = row.data?.garage?.records || {};
    vehicles.forEach((v: any) => {
      const docs = (records[v.id] && records[v.id].documents) || [];
      docs.forEach((d: any) => {
        if (d.expiry === docTargetKey) {
          lines.push(`📄 ${d.type} (${v.name}) изтича на ${labelOf(docTarget)}`);
        }
      });
    });

    if (!lines.length) continue;

    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('user_id', row.user_id);
    if (!subs || !subs.length) continue;

    const title = lines.length === 1 ? 'LifeOS напомняне' : `LifeOS — ${lines.length} напомняния`;
    const payload = JSON.stringify({ title, body: lines.join('\n'), url: './' });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent++;
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }
  }

  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
});
