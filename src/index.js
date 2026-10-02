require('dotenv').config();
// Express 4 doesn't catch errors thrown inside async route handlers, which
// would crash the whole process (e.g. on a database hiccup). This patches it
// so those errors reach the error handler below and return a normal 500.
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const authRoutes = require('./routes/auth.routes');
const settingsRoutes = require('./routes/settings.routes');
const clientsRoutes = require('./routes/clients.routes');
const documentsRoutes = require('./routes/documents.routes');
const pushRoutes = require('./routes/push.routes');
const { runDueDateReminders } = require('./dueDateReminders');

const app = express();
app.use(express.json({ limit: '10mb' })); // logo images are base64, can be a few MB

// CORS_ORIGIN can be a single origin or a comma-separated list
// (e.g. your Render frontend URL + your own domain).
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    credentials: false,
  })
);

app.get('/', (req, res) => res.json({ ok: true, service: 'billbolt-backend' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/documents', documentsRoutes);

// Lets an external scheduler (e.g. Render's Cron Job service, or any
// uptime/cron pinger) trigger the reminder check over HTTP instead of (or
// alongside) relying on this web service's own in-process timer — more
// reliable on Render's free tier, where the service can spin down when idle
// and an in-process cron simply won't fire while it's asleep.
// Runs hourly and only actually notifies each business at the hour THEY
// chose (Settings → Daily Reminder Hour). Add ?force=true to check every
// account regardless of hour, e.g. while testing this by hand.
//
// IMPORTANT: this must be registered BEFORE `app.use('/api/push', pushRoutes)`
// below. pushRoutes applies `router.use(requireAuth)` to everything under
// /api/push with no path restriction — if that router got first crack at
// this request, it would reject it with a 401 before ever reaching this
// handler (this is exactly what happened: the JWT auth middleware's own
// error message, "Missing or invalid Authorization header", was masking
// this route's actual cron-secret check). Express matches in registration
// order, so defining this specific route first lets it handle the request
// directly instead of falling through into the pushRoutes router.
app.post('/api/push/run-daily-check', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing cron secret.' });
  }
  const result = await runDueDateReminders({ ignoreHourFilter: req.query.force === 'true' });
  res.json(result);
});

app.use('/api/push', pushRoutes);

// Centralized error handler — keeps Prisma/JS errors from leaking stack
// traces to the client while still logging them server-side for debugging.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`BillBolt backend listening on port ${PORT}`);
});

// In-process reminder check — runs every hour; runDueDateReminders() itself
// only actually notifies each business at the local hour they picked in
// Settings, so this still adds up to one notification per business per day.
// Fine for an always-on plan, or as a backup even on the free tier (it'll
// just also fire whenever the service happens to be awake).
// REMINDER_CRON overrides how often this timer runs (standard cron syntax,
// UTC) — the default is every hour, on the hour.
if (process.env.ENABLE_IN_PROCESS_CRON !== 'false') {
  const schedule = process.env.REMINDER_CRON || '0 * * * *';
  cron.schedule(schedule, () => {
    runDueDateReminders().catch((err) => console.error('[reminders] Failed:', err));
  });
  console.log(`[reminders] In-process check scheduled: "${schedule}" (UTC)`);
}
