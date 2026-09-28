// Validates the SAME business logic the Express/Prisma routes implement
// (invoiceLogic.js is imported unmodified — the real, delivered file).
// Data access here uses raw `pg` only because this sandbox can't download
// the Prisma engine binary; the delivered backend itself uses Prisma.
const { Client } = require('pg');
const crypto = require('crypto');
const { docTotal, docBalance, computeDueDate, recalcStatus } = require('../src/invoiceLogic');

const id = () => crypto.randomBytes(12).toString('hex');
const isoDaysFromNow = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().split('T')[0]; };

async function main() {
  const db = new Client({ connectionString: 'postgresql://postgres:billbolt_test@localhost:5432/billbolt_test' });
  await db.connect();
  const fail = (msg) => { console.error('❌ FAIL:', msg); process.exitCode = 1; };
  const ok = (msg) => console.log('✅', msg);

  // ── Part A: pure function checks (no DB) — the exact user-reported
  // scenario: recurring due day = 10, paid Feb 6 -> due Feb 10; paid Mar 9
  // -> due Mar 10. These use an explicit reference date, so they're
  // independent of whatever "today" actually is when this test runs.
  let due = computeDueDate(10, null, 'Net 30', '2026-02-06');
  if (due !== '2026-02-10') fail(`Expected 2026-02-10, got ${due}`); else ok(`Paid Feb 6 (day=10) -> due ${due}`);
  due = computeDueDate(10, null, 'Net 30', '2026-03-09');
  if (due !== '2026-03-10') fail(`Expected 2026-03-10, got ${due}`); else ok(`Paid Mar 9 (day=10) -> due ${due}`);
  due = computeDueDate(10, null, 'Net 30', '2026-03-15'); // past the 10th -> rolls to next month
  if (due !== '2026-04-10') fail(`Expected 2026-04-10, got ${due}`); else ok(`Paid Mar 15, past day 10 -> rolls to ${due}`);

  // ── Part B: full flow against a real Postgres database, with dates
  // relative to right now (so overdue/partial/paid come out as a genuine
  // future invoice would, regardless of what day this test happens to run).
  await db.query('TRUNCATE "Payment","Document","Client","User" CASCADE');

  const userId = id();
  await db.query(
    `INSERT INTO "User" (id, username, "passwordHash", "dueDay", terms) VALUES ($1,$2,$3,$4,$5)`,
    [userId, 'ajp', 'hashed:demo', null, 'Net 30']
  );
  ok('Created business account');

  const clientId = id();
  await db.query(
    `INSERT INTO "Client" (id,"userId",name,email,invoices,total) VALUES ($1,$2,$3,$4,0,0)`,
    [clientId, userId, 'Ironclad Security', 'billing@ironcladsec.com']
  );
  const invoiceAmount = docTotal({ lineItems: [{ qty: 1, price: 1500 }], tax: 0, disc: 0, amount: null });
  if (invoiceAmount !== 1500) fail(`Expected invoice amount 1500, got ${invoiceAmount}`);
  else ok(`Invoice total computed correctly: $${invoiceAmount}`);

  const docId = id();
  const recurringDay = parseInt(isoDaysFromNow(20).split('-')[2], 10); // a day-of-month ~20 days out
  await db.query(
    `INSERT INTO "Document" (id,"docNumber","userId","clientId","clientName",type,status,date,due,amount,tax,disc,"lineItems")
     VALUES ($1,$2,$3,$4,$5,'invoice','sent',$6,$7,$8,0,0,$9)`,
    [docId, 'INV-100', userId, clientId, 'Ironclad Security', isoDaysFromNow(-10), isoDaysFromNow(20), invoiceAmount, JSON.stringify([{ qty: 1, price: 1500 }])]
  );
  await db.query(`UPDATE "Client" SET "dueDay"=$1, invoices=1, total=$2 WHERE id=$3`, [recurringDay, invoiceAmount, clientId]);
  ok(`Created $1500 invoice, client recurring due day set to ${recurringDay}`);

  async function loadDocWithPayments() {
    const docRes = await db.query(`SELECT * FROM "Document" WHERE id=$1`, [docId]);
    const paysRes = await db.query(`SELECT * FROM "Payment" WHERE "documentId"=$1 ORDER BY date`, [docId]);
    return { ...docRes.rows[0], payments: paysRes.rows };
  }

  async function recordPayment(amount, date) {
    const doc = await loadDocWithPayments();
    const balance = docBalance(doc);
    if (amount > balance + 0.01) throw new Error(`Payment ${amount} exceeds balance ${balance}`);
    await db.query(`INSERT INTO "Payment" (id,"documentId",date,amount,method) VALUES ($1,$2,$3,$4,'Cash')`, [id(), docId, date, amount]);
    const updated = await loadDocWithPayments();
    const newStatus = recalcStatus(updated);
    const clientRes = await db.query(`SELECT * FROM "Client" WHERE id=$1`, [clientId]);
    const userRes = await db.query(`SELECT * FROM "User" WHERE id=$1`, [userId]);
    const newDue = computeDueDate(clientRes.rows[0].dueDay, userRes.rows[0].dueDay, userRes.rows[0].terms, date);
    await db.query(`UPDATE "Document" SET status=$1, due=$2 WHERE id=$3`, [newStatus, newDue, docId]);
    return { balance: docBalance(updated), status: newStatus, due: newDue };
  }

  let r = await recordPayment(100, isoDaysFromNow(0));
  if (Math.abs(r.balance - 1400) > 0.001) fail(`Expected balance 1400, got ${r.balance}`);
  else ok(`Balance after $100 payment: $${r.balance}`);
  if (r.status !== 'partial') fail(`Expected status 'partial', got '${r.status}'`);
  else ok(`Status correctly set to 'partial' (due date ${r.due} is in the future)`);

  r = await recordPayment(1400, isoDaysFromNow(1));
  if (Math.abs(r.balance - 0) > 0.001) fail(`Expected balance 0, got ${r.balance}`);
  else ok(`Balance after paying off the rest: $${r.balance}`);
  if (r.status !== 'paid') fail(`Expected status 'paid', got '${r.status}'`);
  else ok(`Status correctly flipped to 'paid'`);

  const lastPay = await db.query(`SELECT * FROM "Payment" WHERE "documentId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [docId]);
  await db.query(`DELETE FROM "Payment" WHERE id=$1`, [lastPay.rows[0].id]);
  const afterRemoval = await loadDocWithPayments();
  const revertStatus = recalcStatus(afterRemoval);
  const revertBalance = docBalance(afterRemoval);
  await db.query(`UPDATE "Document" SET status=$1 WHERE id=$2`, [revertStatus, docId]);
  if (Math.abs(revertBalance - 1400) > 0.001) fail(`Expected balance back to 1400, got ${revertBalance}`);
  else ok(`Balance correctly reverted to $${revertBalance} after removing the payment`);
  if (revertStatus !== 'partial') fail(`Expected status back to 'partial', got '${revertStatus}'`);
  else ok(`Status correctly reverted to 'partial'`);

  try {
    await recordPayment(99999, isoDaysFromNow(2));
    fail('Overpayment was NOT rejected — this should have thrown');
  } catch (e) {
    ok('Overpayment correctly rejected: ' + e.message);
  }

  const clientCheck = await db.query(`SELECT invoices, total FROM "Client" WHERE id=$1`, [clientId]);
  if (clientCheck.rows[0].invoices !== 1) fail(`Expected client.invoices=1, got ${clientCheck.rows[0].invoices}`);
  else ok(`Client invoice count correct: ${clientCheck.rows[0].invoices}`);

  await db.end();
  console.log(process.exitCode ? '\n❌ SOME TESTS FAILED' : '\n✅ ALL TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
