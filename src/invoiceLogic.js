// Same math BillBolt's frontend used with localStorage — now the server is
// the single source of truth, so every device sees identical numbers.

function docTotal(doc) {
  const base = doc.amount != null
    ? Math.max(0, doc.amount)
    : (() => {
        const sub = (doc.lineItems || []).reduce((s, i) => s + i.qty * i.price, 0);
        const taxAmt = sub * ((doc.tax || 0) / 100);
        return Math.max(0, sub + taxAmt - (doc.disc || 0));
      })();
  // Late fees / penalties / other charges added after the invoice was
  // created — on top of the originally billed amount, which stays as-is
  // for the record.
  const charges = (doc.charges || []).reduce((s, c) => s + c.amount, 0);
  return Math.max(0, base + charges);
}

function docPaid(doc) {
  return (doc.payments || []).reduce((s, p) => s + p.amount, 0);
}

function docBalance(doc) {
  return Math.max(0, parseFloat((docTotal(doc) - docPaid(doc)).toFixed(2)));
}

// due date defaulting to "today" unless a specific reference date is passed
// (e.g. anchor to the date a payment was recorded, for backdated entries).
function computeDueDate(overrideDay, defaultDay, terms, refDate) {
  const today = refDate ? new Date(refDate + 'T00:00:00') : new Date();
  const dayRaw = overrideDay || defaultDay;
  if (dayRaw) {
    const day = Math.min(28, Math.max(1, parseInt(dayRaw, 10)));
    let due = new Date(today.getFullYear(), today.getMonth(), day);
    if (today.getDate() > day) due = new Date(today.getFullYear(), today.getMonth() + 1, day);
    return due.toISOString().split('T')[0];
  }
  const termsDays = { 'Net 15': 15, 'Net 30': 30, 'Net 45': 45, 'Due on receipt': 0 };
  const days = Object.prototype.hasOwnProperty.call(termsDays, terms) ? termsDays[terms] : 30;
  const due = new Date(today);
  due.setDate(due.getDate() + days);
  return due.toISOString().split('T')[0];
}

// Recompute status from balance + due date. Never touches 'draft'.
function recalcStatus(doc) {
  const balance = docBalance(doc);
  const today = new Date().toISOString().split('T')[0];
  const overdue = !!(doc.due && doc.due < today);
  if (balance <= 0.004) return 'paid';
  if ((doc.payments || []).length > 0) return overdue ? 'overdue' : 'partial';
  if (doc.status !== 'draft') return overdue ? 'overdue' : 'sent';
  return doc.status;
}

// Same "is this invoice due soon?" logic the frontend's Due Dates page uses.
function upcomingDueDocs(docs) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return docs
    .filter((d) => d.status !== 'paid' && d.status !== 'draft' && d.due)
    .map((d) => {
      const due = new Date(d.due + 'T00:00:00');
      const daysLeft = Math.round((due - today) / 86400000);
      return { d, daysLeft };
    })
    .filter((x) => x.daysLeft <= 10);
}

module.exports = { docTotal, docPaid, docBalance, computeDueDate, recalcStatus, upcomingDueDocs };
