require('dotenv').config();
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
app.use('/api/push', pushRoutes);

// Lets an external scheduler (e.g. Render's Cron Job service, or any
// uptime/cron pinger) trigger the daily reminder check over HTTP instead of
// relying on this web service's own in-process timer — more reliable on
// Render's free tier, where the service can spin down when idle and an
// in-process cron simply won't fire while it's asleep.
app.post('/api/push/run-daily-check', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing cron secret.' });
  }
  const result = await runDueDateReminders();
  res.json(result);
});

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

// In-process daily reminder check — fine for an always-on plan, or as a
// backup even on the free tier (it'll just also fire whenever the service
// happens to be awake). REMINDER_CRON defaults to 13:00 UTC (~9am US
// Eastern / 10am Argentina) — override with a standard cron expression.
if (process.env.ENABLE_IN_PROCESS_CRON !== 'false') {
  const schedule = process.env.REMINDER_CRON || '0 13 * * *';
  cron.schedule(schedule, () => {
    runDueDateReminders().catch((err) => console.error('[reminders] Failed:', err));
  });
  console.log(`[reminders] In-process daily check scheduled: "${schedule}" (UTC)`);
}
