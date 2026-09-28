const webpush = require('web-push');
const prisma = require('./db');
const { docTotal, docPaid, docBalance, upcomingDueDocs } = require('./invoiceLogic');

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

function buildReminderBody(upcoming) {
  const overdue = upcoming.filter((x) => x.daysLeft < 0).length;
  const dueSoon = upcoming.length - overdue;
  if (overdue && dueSoon) return `${overdue} invoice${overdue === 1 ? '' : 's'} overdue, ${dueSoon} due within 10 days.`;
  if (overdue) return `${overdue} invoice${overdue === 1 ? '' : 's'} overdue.`;
  return `${dueSoon} invoice${dueSoon === 1 ? '' : 's'} due within the next 10 days.`;
}

// Checks every business account's upcoming due invoices and pushes a
// reminder to every device that subscribed, for accounts that actually
// have something due soon. Removes subscriptions the push service reports
// as gone (uninstalled app, expired, etc).
async function runDueDateReminders() {
  if (!ensureConfigured()) {
    console.log('[reminders] Skipped — VAPID keys are not set.');
    return { sent: 0, skipped: true };
  }

  const users = await prisma.user.findMany({ include: { pushSubscriptions: true } });
  let sent = 0;

  for (const user of users) {
    if (!user.pushSubscriptions.length) continue;

    const docs = await prisma.document.findMany({
      where: { userId: user.id },
      include: { payments: true },
    });
    const shaped = docs.map((d) => ({
      status: d.status,
      due: d.due,
      amount: d.amount,
      payments: d.payments,
    }));
    const upcoming = upcomingDueDocs(shaped);
    if (!upcoming.length) continue;

    const payload = JSON.stringify({
      title: 'BillBolt — Upcoming due dates',
      body: buildReminderBody(upcoming),
    });

    for (const sub of user.pushSubscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Subscription no longer valid (uninstalled, expired) — clean it up.
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error(`[reminders] Failed to send to subscription ${sub.id}:`, err.message);
        }
      }
    }
  }

  console.log(`[reminders] Sent ${sent} notification(s).`);
  return { sent, skipped: false };
}

module.exports = { runDueDateReminders };
