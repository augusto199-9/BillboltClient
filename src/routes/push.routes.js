const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/push/vapid-public-key — no auth needed, this key is meant to be
// public (it's how the browser verifies pushes really came from this server).
router.get('/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.use(requireAuth);

// POST /api/push/subscribe — save (or refresh) this device's push subscription.
router.post('/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: req.userId, p256dh: keys.p256dh, auth: keys.auth },
    create: { userId: req.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });
  res.status(201).json({ ok: true });
});

// DELETE /api/push/subscribe — stop notifying this device.
router.delete('/subscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required.' });
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.userId } });
  res.json({ ok: true });
});

module.exports = router;
