/** Build accrual journal lines for a batch of invoices */
export function buildAccrualEntry(invoices, holderName) {
  const lines = [];
  let total = 0;

  for (const inv of invoices) {
    total += inv.total;
    lines.push({
      accountCode: '12011',
      accountName: `Purchases - ${inv.category || 'Materials'} · ${inv.referenceNumber || inv.invoiceNumber || ''}`.trim(),
      debit: inv.total,
      credit: 0,
    });
  }

  lines.push({
    accountCode: '23041',
    accountName: `Engineer custody - ${holderName}`,
    debit: 0,
    credit: total,
  });

  return { lines, total };
}

export function buildDisbursementEntry(total, holderName) {
  return [
    {
      accountCode: '23041',
      accountName: `Engineer custody - ${holderName}`,
      debit: total,
      credit: 0,
    },
    {
      accountCode: '11010',
      accountName: 'Bank',
      debit: 0,
      credit: total,
    },
  ];
}

/** Append new invoice debit lines + credit line without removing existing journal lines */
export function appendAccrualEntry(existing = [], newInvoices, holderName) {
  const { lines: batchLines } = buildAccrualEntry(newInvoices, holderName);
  return [...(existing || []), ...batchLines];
}

export function appendDisbursementEntry(existing = [], total, holderName) {
  const batchLines = buildDisbursementEntry(total, holderName);
  return [...(existing || []), ...batchLines];
}

export function accrualDebitTotal(lines = []) {
  return lines.reduce((sum, line) => sum + (line.debit || 0), 0);
}
