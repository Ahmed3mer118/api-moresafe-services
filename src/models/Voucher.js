import mongoose from 'mongoose';

const voucherSchema = new mongoose.Schema(
  {
    voucherNumber: { type: String, unique: true, sparse: true },
    beneficiary: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    amount: { type: Number, required: true },
    method: { type: String, enum: ['bank_transfer', 'check'], default: 'bank_transfer' },
    bankReference: String,
    voucherDate: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    custody: { type: mongoose.Schema.Types.ObjectId, ref: 'Custody' },
  },
  { timestamps: true }
);

export async function nextVoucherNumber() {
  const count = await mongoose.model('Voucher').countDocuments();
  return `VCH-${558 + count}`;
}

export default mongoose.model('Voucher', voucherSchema);
