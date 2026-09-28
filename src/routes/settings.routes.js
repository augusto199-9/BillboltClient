const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function toSettingsShape(user) {
  return {
    bname: user.businessName || '',
    email: user.email || '',
    addr: user.addr || '',
    phone: user.phone || '',
    web: user.web || '',
    tax: String(user.taxRate ?? 0),
    terms: user.terms || 'Net 30',
    dueDay: user.dueDay ?? null,
    currency: user.currency || 'USD ($)',
    prefix: user.prefix || 'INV-',
    payNotes: user.payNotes || '',
    apiKey: user.apiKey || '',
    logoData: user.logoData || '',
  };
}

// GET /api/settings
router.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json(toSettingsShape(user));
});

// PUT /api/settings — full replace of the business profile fields.
router.put('/', async (req, res) => {
  const b = req.body || {};
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: {
      businessName: b.bname ?? undefined,
      email: b.email ?? undefined,
      addr: b.addr ?? undefined,
      phone: b.phone ?? undefined,
      web: b.web ?? undefined,
      taxRate: b.tax !== undefined ? parseFloat(b.tax) || 0 : undefined,
      terms: b.terms ?? undefined,
      dueDay: b.dueDay === '' || b.dueDay === null || b.dueDay === undefined
        ? null
        : parseInt(b.dueDay, 10),
      currency: b.currency ?? undefined,
      prefix: b.prefix ?? undefined,
      payNotes: b.payNotes ?? undefined,
      apiKey: b.apiKey ?? undefined,
    },
  });
  res.json(toSettingsShape(user));
});

// PUT /api/settings/logo — separate endpoint since the logo (base64 image)
// is much larger than the rest of the settings and changes far less often.
router.put('/logo', async (req, res) => {
  const { logoData } = req.body || {};
  await prisma.user.update({
    where: { id: req.userId },
    data: { logoData: logoData || null },
  });
  res.json({ ok: true });
});

module.exports = router;
