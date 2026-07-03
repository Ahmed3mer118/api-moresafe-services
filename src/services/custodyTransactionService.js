import CustodyTransaction from '../models/CustodyTransaction.js';
import Custody from '../models/Custody.js';

export async function recordCustodyTransaction({
  custodyId,
  type,
  amount,
  description,
  descriptionEn,
  referenceType,
  referenceId,
  proofUrl,
  createdBy,
}) {
  const custody = await Custody.findById(custodyId).select('amount spent').lean();
  if (!custody) return null;

  const balanceAfter = (custody.amount || 0) - (custody.spent || 0);

  return CustodyTransaction.create({
    custody: custodyId,
    type,
    amount,
    balanceAfter,
    description,
    descriptionEn,
    referenceType,
    referenceId,
    proofUrl,
    createdBy,
  });
}

export async function listCustodyTransactions(custodyId) {
  return CustodyTransaction.find({ custody: custodyId })
    .populate('createdBy', 'name nameEn')
    .sort({ createdAt: -1 })
    .lean();
}
