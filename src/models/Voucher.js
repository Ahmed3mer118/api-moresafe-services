import mongoose from 'mongoose';

const journalLineSchema = new mongoose.Schema(
  {
    accountCode: String,
    accountName: String,
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
  },
  { _id: false }
);

const voucherSchema = new mongoose.Schema(
  {
    voucherNumber: { type: String, unique: true, sparse: true },
    beneficiary: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    amount: { type: Number, required: true },
    method: { type: String, enum: ['bank_transfer', 'check'], default: 'bank_transfer' },
    bankReference: String,
    proofUrl: String,
    voucherDate: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    custody: { type: mongoose.Schema.Types.ObjectId, ref: 'Custody' },
    invoiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
    accrualEntry: [journalLineSchema],
    disbursementEntry: [journalLineSchema],
  },
  { timestamps: true }
);

voucherSchema.index({ createdAt: -1 });
voucherSchema.index({ beneficiary: 1, createdAt: -1 });

export async function nextVoucherNumber() {
  const count = await mongoose.model('Voucher').countDocuments();
  return `VCH-${558 + count}`;
}

export default mongoose.model('Voucher', voucherSchema);
