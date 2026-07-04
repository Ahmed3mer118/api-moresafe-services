import Invoice from '../models/Invoice.js';
import CustodyTransaction from '../models/CustodyTransaction.js';
import {
  buildAccrualEntry,
  buildDisbursementEntry,
  accrualDebitTotal,
} from './journalEntries.js';

function holderNameFromVoucher(voucher) {
  return (
    voucher.beneficiary?.name
    || voucher.beneficiary?.nameEn
    || voucher.custody?.holder?.name
    || voucher.custody?.holder?.nameEn
    || ''
  );
}

function snapshotsMatchAmount(voucher) {
  if (!voucher.accrualEntry?.length || !voucher.disbursementEntry?.length) return false;
  const accrualTotal = accrualDebitTotal(voucher.accrualEntry);
  return Math.abs(accrualTotal - Number(voucher.amount || 0)) < 0.01;
}

/** Resolve journal lines for a single voucher batch (never cumulative custody totals). */
export async function resolveVoucherJournalEntries(voucher) {
  const holderName = holderNameFromVoucher(voucher);
  const amount = Number(voucher.amount || 0);

  if (snapshotsMatchAmount(voucher)) {
    return {
      accrualEntry: voucher.accrualEntry,
      disbursementEntry: voucher.disbursementEntry,
    };
  }

  const invoiceIds = (voucher.invoiceIds || []).map((id) => id?._id || id).filter(Boolean);
  if (invoiceIds.length && holderName && amount > 0) {
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } }).lean();
    if (invoices.length) {
      const { lines: accrualEntry } = buildAccrualEntry(invoices, holderName);
      const disbursementEntry = buildDisbursementEntry(amount, holderName);
      return { accrualEntry, disbursementEntry };
    }
  }

  const custodyId = voucher.custody?._id || voucher.custody;
  if (!custodyId || !amount) {
    return {
      accrualEntry: voucher.accrualEntry || [],
      disbursementEntry: voucher.disbursementEntry || [],
    };
  }

  const voucherTime = new Date(voucher.voucherDate || voucher.createdAt || Date.now());

  const disburseTx = await CustodyTransaction.findOne({
    custody: custodyId,
    type: 'disbursement',
    amount,
    createdAt: { $lte: new Date(voucherTime.getTime() + 60_000) },
  })
    .sort({ createdAt: -1 })
    .lean();

  const accrualTx = await CustodyTransaction.findOne({
    custody: custodyId,
    type: 'adjustment',
    amount,
    createdAt: { $lte: disburseTx?.createdAt || voucherTime },
  })
    .sort({ createdAt: -1 })
    .lean();

  return {
    accrualEntry: accrualTx?.journalLines?.length ? accrualTx.journalLines : voucher.accrualEntry || [],
    disbursementEntry: disburseTx?.journalLines?.length ? disburseTx.journalLines : voucher.disbursementEntry || [],
  };
}
