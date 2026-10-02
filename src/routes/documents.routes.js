const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');
const { docTotal, docBalance, computeDueDate, recalcStatus } = require('../invoiceLogic');

const router = express.Router();
router.use(requireAuth);

// Shape a DB document (+ payments) into what the frontend already expects
// (it was designed around the old localStorage record shape).
function toDocShape(doc) {
  return {
    id: doc.docNumber,
    client: doc.clientName,
    clientEmail: doc.clientEmail,
    clientAddr: doc.clientAddr,
    type: doc.type,
    status: doc.status,
    date: doc.date,
    due: doc.due,
    amount: doc.amount,
    currency: doc.currency,
    tax: doc.tax,
    disc: doc.disc,
    notes: doc.notes,
    from: doc.fromName,
    fromEmail: doc.fromEmail,
    fromAddr: doc.fromAddr,
    fromPhone: doc.fromPhone,
    fromWeb: doc.fromWeb,
    lineItems: doc.lineItems,
    monthlyPayment: doc.monthlyPayment,
    payments: (doc.payments || [])
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt))
      .map((p) => ({ id: p.id, date: p.date, amount: p.amount, method: p.method, note: p.note })),
    charges: (doc.charges || [])
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt))
      .map((c) => ({ id: c.id, date: c.date, amount: c.amount, reason: c.reason })),
  };
}

async function loadDoc(userId, docNumber) {
  return prisma.document.findFirst({
    where: { userId, docNumber },
    include: { payments: true, charges: true },
  });
}

// GET /api/documents
router.get('/', async (req, res) => {
  const docs = await prisma.document.findMany({
    where: { userId: req.userId },
    include: { payments: true, charges: true },
    orderBy: { createdAt: 'desc' },
  });
  // Recompute status fresh on every read (not just right after a payment) so
  // an invoice that quietly crossed its due date shows as "overdue" the next
  // time anyone loads the list, on any device — no separate sweep needed.
  res.json(
    docs.map((doc) => {
      const shaped = toDocShape(doc);
      shaped.status = recalcStatus(doc);
      return shaped;
    })
  );
});

// POST /api/documents — create a new invoice/quote. Upserts the client, and
// (if recurringDueDay is set) saves that day onto the client record so
// future invoices for them default to it automatically.
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.client) {
    return res.status(400).json({ error: 'Document number and client name are required.' });
  }
  const dup = await prisma.document.findFirst({
    where: { userId: req.userId, docNumber: b.id },
  });
  if (dup) {
    return res.status(409).json({ error: 'Document number already exists.' });
  }

  const amount = docTotal({ lineItems: b.lineItems, tax: b.tax, disc: b.disc, amount: null });

  let client = await prisma.client.findFirst({
    where: { userId: req.userId, name: { equals: b.client.trim(), mode: 'insensitive' } },
  });
  if (!client) {
    client = await prisma.client.create({
      data: { userId: req.userId, name: b.client.trim(), email: b.clientEmail || null, invoices: 0, total: 0 },
    });
  }
  const clientData = {
    invoices: client.invoices + 1,
    total: parseFloat((client.total + amount).toFixed(2)),
  };
  if (b.recurringDueDay && b.due) {
    clientData.dueDay = Math.min(28, Math.max(1, parseInt(b.due.split('-')[2], 10)));
  }
  client = await prisma.client.update({ where: { id: client.id }, data: clientData });

  const doc = await prisma.document.create({
    data: {
      userId: req.userId,
      docNumber: b.id,
      clientId: client.id,
      clientName: b.client.trim(),
      clientEmail: b.clientEmail || null,
      clientAddr: b.clientAddr || null,
      type: b.type === 'quote' ? 'quote' : 'invoice',
      status: 'sent',
      date: b.date || new Date().toISOString().split('T')[0],
      due: b.due || null,
      amount,
      currency: b.currency || null,
      tax: parseFloat(b.tax) || 0,
      disc: parseFloat(b.disc) || 0,
      notes: b.notes || null,
      fromName: b.from || null,
      fromEmail: b.fromEmail || null,
      fromAddr: b.fromAddr || null,
      fromPhone: b.fromPhone || null,
      fromWeb: b.fromWeb || null,
      lineItems: b.lineItems || [],
      monthlyPayment: b.monthlyPayment != null && b.monthlyPayment !== '' ? parseFloat(b.monthlyPayment) : null,
    },
    include: { payments: true },
  });
  res.status(201).json(toDocShape(doc));
});

// PUT /api/documents/:docNumber/status — mark paid (adds a payment for the
// remaining balance so the numbers stay consistent, same as before).
router.put('/:docNumber/status', async (req, res) => {
  const doc = await loadDoc(req.userId, req.params.docNumber);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const { status } = req.body || {};
  if (status === 'paid') {
    const balance = docBalance({ ...doc, payments: doc.payments });
    if (balance > 0.004) {
      await prisma.payment.create({
        data: {
          documentId: doc.id,
          date: new Date().toISOString().split('T')[0],
          amount: balance,
          method: 'Other',
          note: 'Marked as paid in full',
        },
      });
    }
    await prisma.document.update({ where: { id: doc.id }, data: { status: 'paid' } });
  }
  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.json(toDocShape(fresh));
});

// PUT /api/documents/:docNumber/due — manually set the due date. Separate
// from the automatic recurring roll-forward so a business can correct it
// (e.g. a partial payment shouldn't always push the date a full cycle out).
router.put('/:docNumber/due', async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { userId: req.userId, docNumber: req.params.docNumber },
  });
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const { due } = req.body || {};
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return res.status(400).json({ error: 'due must be a date in YYYY-MM-DD format.' });
  }
  await prisma.document.update({ where: { id: doc.id }, data: { due } });
  const fresh = await loadDoc(req.userId, req.params.docNumber);
  const shaped = toDocShape(fresh);
  shaped.status = recalcStatus(fresh);
  res.json(shaped);
});

// PUT /api/documents/:docNumber/monthly-payment — set/edit/clear the
// explicit expected monthly payment (independent of payment history).
router.put('/:docNumber/monthly-payment', async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { userId: req.userId, docNumber: req.params.docNumber },
  });
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const { monthlyPayment } = req.body || {};
  const value = monthlyPayment === '' || monthlyPayment === null || monthlyPayment === undefined
    ? null
    : parseFloat(monthlyPayment);
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    return res.status(400).json({ error: 'Enter a valid amount, or leave it blank to clear it.' });
  }
  await prisma.document.update({ where: { id: doc.id }, data: { monthlyPayment: value } });
  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.json(toDocShape(fresh));
});

// PUT /api/documents/:docNumber/sync-business-info — re-stamps this one
// invoice's business name/email/address/phone/website from the account's
// CURRENT Settings. Invoices snapshot this info at creation time so old
// invoices don't silently change on their own — this is the explicit,
// one-invoice-at-a-time way to pull in an update made since (e.g. added a
// phone number) onto an invoice that predates it.
router.put('/:docNumber/sync-business-info', async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { userId: req.userId, docNumber: req.params.docNumber },
  });
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  await prisma.document.update({
    where: { id: doc.id },
    data: {
      fromName: user.businessName || null,
      fromEmail: user.email || null,
      fromAddr: user.addr || null,
      fromPhone: user.phone || null,
      fromWeb: user.web || null,
    },
  });
  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.json(toDocShape(fresh));
});

// POST /api/documents/sync-business-info-all — same re-stamp as above, but
// for every invoice this account has, in one go. For catching up a backlog
// of old invoices after a Settings change (e.g. just added a phone number),
// instead of opening each one individually.
router.post('/sync-business-info-all', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  const result = await prisma.document.updateMany({
    where: { userId: req.userId },
    data: {
      fromName: user.businessName || null,
      fromEmail: user.email || null,
      fromAddr: user.addr || null,
      fromPhone: user.phone || null,
      fromWeb: user.web || null,
    },
  });
  res.json({ updated: result.count });
});

// DELETE /api/documents/:docNumber
router.delete('/:docNumber', async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { userId: req.userId, docNumber: req.params.docNumber },
  });
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  await prisma.document.delete({ where: { id: doc.id } });
  res.json({ ok: true });
});

// POST /api/documents/:docNumber/payments — record a payment. Recomputes
// status and, if this client has a recurring due day, rolls the due date
// forward to the next occurrence anchored to the payment's date.
router.post('/:docNumber/payments', async (req, res) => {
  const doc = await loadDoc(req.userId, req.params.docNumber);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const { amount, date, method, note } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: 'Enter a valid payment amount.' });
  }
  const balance = docBalance(doc);
  if (amt > balance + 0.01) {
    return res.status(400).json({ error: `Payment can't exceed the balance due ($${balance.toFixed(2)}).` });
  }
  const payDate = date || new Date().toISOString().split('T')[0];

  await prisma.payment.create({
    data: { documentId: doc.id, date: payDate, amount: amt, method: method || 'Other', note: note || null },
  });

  const docWithPayment = await loadDoc(req.userId, req.params.docNumber);
  const newStatus = recalcStatus(docWithPayment);

  const updateData = { status: newStatus };
  // Learn the recurring monthly payment from the very first payment ever
  // recorded on this invoice, if one wasn't already set explicitly — so a
  // business doesn't have to separately type in "$200/month" by hand when
  // the client is already paying exactly that. Once established (either
  // way), later payments never silently overwrite it — a one-off partial
  // or extra payment shouldn't change the standing monthly figure.
  if (doc.monthlyPayment == null) {
    updateData.monthlyPayment = amt;
  }
  const client = doc.clientId ? await prisma.client.findUnique({ where: { id: doc.clientId } }) : null;
  const recurringDay = (client && client.dueDay) || null;
  if (recurringDay || (await prisma.user.findUnique({ where: { id: req.userId } })).dueDay) {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    updateData.due = computeDueDate(recurringDay, user.dueDay, user.terms, payDate);
  }
  await prisma.document.update({ where: { id: doc.id }, data: updateData });

  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.status(201).json(toDocShape(fresh));
});

// PUT /api/documents/:docNumber/payments/:paymentId — edit a previously
// recorded payment (amount, date, method, note), e.g. to fix a mistake.
router.put('/:docNumber/payments/:paymentId', async (req, res) => {
  const doc = await loadDoc(req.userId, req.params.docNumber);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const payment = doc.payments.find((p) => p.id === req.params.paymentId);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });

  const { amount, date, method, note } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: 'Enter a valid payment amount.' });
  }
  // Balance available to this payment = total - every OTHER payment (not
  // counting the one being edited), so editing a payment up to the full
  // remaining balance is allowed, same rule as recording a new one.
  const totalExcludingThis = docTotal(doc) - doc.payments.filter((p) => p.id !== payment.id).reduce((s, p) => s + p.amount, 0);
  if (amt > totalExcludingThis + 0.01) {
    return res.status(400).json({ error: `Amount can't exceed the available balance ($${Math.max(0, totalExcludingThis).toFixed(2)}).` });
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      amount: amt,
      date: date || payment.date,
      method: method !== undefined ? method : payment.method,
      note: note !== undefined ? note : payment.note,
    },
  });

  const docWithEdit = await loadDoc(req.userId, req.params.docNumber);
  const newStatus = recalcStatus(docWithEdit);
  await prisma.document.update({ where: { id: doc.id }, data: { status: newStatus } });

  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.json(toDocShape(fresh));
});

// DELETE /api/documents/:docNumber/payments/:paymentId
router.delete('/:docNumber/payments/:paymentId', async (req, res) => {
  const doc = await loadDoc(req.userId, req.params.docNumber);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const payment = doc.payments.find((p) => p.id === req.params.paymentId);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });

  await prisma.payment.delete({ where: { id: payment.id } });
  const docWithout = await loadDoc(req.userId, req.params.docNumber);
  const newStatus = recalcStatus(docWithout);
  await prisma.document.update({ where: { id: doc.id }, data: { status: newStatus } });

  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.json(toDocShape(fresh));
});

// POST /api/documents/:docNumber/charges — add an extra charge (late fee,
// penalty, rush fee, etc.) on top of the original invoice amount.
router.post('/:docNumber/charges', async (req, res) => {
  const doc = await loadDoc(req.userId, req.params.docNumber);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const { amount, date, reason } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: 'Enter a valid charge amount.' });
  }
  const chargeDate = date || new Date().toISOString().split('T')[0];

  await prisma.charge.create({
    data: { documentId: doc.id, date: chargeDate, amount: amt, reason: reason || null },
  });

  const docWithCharge = await loadDoc(req.userId, req.params.docNumber);
  const newStatus = recalcStatus(docWithCharge);
  await prisma.document.update({ where: { id: doc.id }, data: { status: newStatus } });

  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.status(201).json(toDocShape(fresh));
});

// DELETE /api/documents/:docNumber/charges/:chargeId
router.delete('/:docNumber/charges/:chargeId', async (req, res) => {
  const doc = await loadDoc(req.userId, req.params.docNumber);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const charge = doc.charges.find((c) => c.id === req.params.chargeId);
  if (!charge) return res.status(404).json({ error: 'Charge not found.' });

  await prisma.charge.delete({ where: { id: charge.id } });
  const docWithout = await loadDoc(req.userId, req.params.docNumber);
  const newStatus = recalcStatus(docWithout);
  await prisma.document.update({ where: { id: doc.id }, data: { status: newStatus } });

  const fresh = await loadDoc(req.userId, req.params.docNumber);
  res.json(toDocShape(fresh));
});

module.exports = router;
