const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/clients
router.get('/', async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(clients);
});

// PUT /api/clients/:id — rename / update email, phone / recurring due day
router.put('/:id', async (req, res) => {
  const { name, email, phone, dueDay } = req.body || {};
  const existing = await prisma.client.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!existing) return res.status(404).json({ error: 'Client not found.' });
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Client name is required.' });
  }
  try {
    const updated = await prisma.client.update({
      where: { id: existing.id },
      data: {
        name: name.trim(),
        email: email ?? existing.email,
        phone: phone ?? existing.phone,
        dueDay: dueDay === '' || dueDay === null || dueDay === undefined ? null : parseInt(dueDay, 10),
      },
    });
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Another client already has that name.' });
    }
    throw err;
  }
});

// DELETE /api/clients/:id
router.delete('/:id', async (req, res) => {
  const existing = await prisma.client.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!existing) return res.status(404).json({ error: 'Client not found.' });
  await prisma.client.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

module.exports = router;
