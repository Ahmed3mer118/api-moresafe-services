import mongoose from 'mongoose';
import { CUSTODY_STATUS } from '../constants/roles.js';

const journalLineSchema = new mongoose.Schema(
  {
    accountCode: String,
    accountName: String,
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
  },
  { _id: false }
);

const custodySchema = new mongoose.Schema(
  {
    custodyNumber: { type: String, unique: true, sparse: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    holder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    submittedSpent: { type: Number, default: 0 },
    approvedSpent: { type: Number, default: 0 },
    disbursementAmount: { type: Number },
    disbursementConfirmedAt: Date,
    disbursementConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: ['operational', 'emergency'], default: 'operational' },
    purpose: String,
    status: {
      type: String,
      enum: Object.values(CUSTODY_STATUS),
      default: CUSTODY_STATUS.OPEN,
    },
    invoices: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
    closedAt: Date,
    pmApprovedAt: Date,
    pmApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    pmRejectionReason: String,
    settledAt: Date,
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    settlementNumber: String,
    accrualEntry: [journalLineSchema],
    disbursementEntry: [journalLineSchema],
    financeRejectionReason: String,
    disbursementProof: String,
    disbursedAt: Date,
    disbursedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

custodySchema.virtual('remaining').get(function remaining() {
  return (this.amount || 0) - (this.spent || 0);
});

custodySchema.virtual('overBudget').get(function overBudget() {
  return (this.spent || 0) > (this.amount || 0);
});

custodySchema.set('toJSON', { virtuals: true });
custodySchema.set('toObject', { virtuals: true });

custodySchema.index({ holder: 1, status: 1 });
custodySchema.index({ project: 1, status: 1 });
custodySchema.index({ status: 1, updatedAt: -1 });
custodySchema.index({ settledAt: -1 });
custodySchema.index({ closedAt: 1, pmApprovedAt: 1 });

export async function nextCustodyNumber() {
  const count = await mongoose.model('Custody').countDocuments();
  return `CST-${1001 + count}`;
}

export default mongoose.model('Custody', custodySchema);
