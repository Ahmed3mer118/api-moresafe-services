import mongoose from 'mongoose';

const custodyTransactionSchema = new mongoose.Schema(
  {
    custody: { type: mongoose.Schema.Types.ObjectId, ref: 'Custody', required: true },
    type: {
      type: String,
      enum: ['allocation', 'spend', 'top_up', 'disbursement', 'refund', 'adjustment'],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: Number,
    description: String,
    descriptionEn: String,
    referenceType: String,
    referenceId: mongoose.Schema.Types.ObjectId,
    proofUrl: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    journalLines: [
      {
        accountCode: String,
        accountName: String,
        debit: { type: Number, default: 0 },
        credit: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

custodyTransactionSchema.index({ custody: 1, createdAt: -1 });

export default mongoose.model('CustodyTransaction', custodyTransactionSchema);
