import mongoose from 'mongoose';
import { CUSTODY_STATUS } from '../constants/roles.js';

const lineItemSchema = new mongoose.Schema(
  {
    description: String,
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true },
    referenceNumber: { type: String, unique: true, sparse: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    custody: { type: mongoose.Schema.Types.ObjectId, ref: 'Custody' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    supplier: { type: String, trim: true },
    category: { type: String, trim: true },
    lineItems: [lineItemSchema],
    subtotal: { type: Number, default: 0 },
    vatAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    taxNumber: String,
    taxVerified: { type: Boolean, default: false },
    invoiceDate: Date,
    status: {
      type: String,
      default: 'draft',
    },
    rejectionReason: String,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    attachmentUrl: String,
    attachments: [
      {
        filename: String,
        mimeType: String,
        url: String,
      },
    ],
    ocrData: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

invoiceSchema.index({ uploadedBy: 1, status: 1, createdAt: -1 });
invoiceSchema.index({ project: 1, status: 1 });
invoiceSchema.index({ custody: 1 });
invoiceSchema.index({ status: 1, custody: 1 });
invoiceSchema.index({ status: 1, project: 1, custody: 1 });
invoiceSchema.index({ status: 1, createdAt: -1 });
invoiceSchema.index({ supplier: 1, total: -1 });
invoiceSchema.index({ createdAt: -1 });

export async function nextInvoiceReference() {
  const [row] = await mongoose.model('Invoice').aggregate([
    { $match: { referenceNumber: { $regex: /^INV-\d+$/ } } },
    {
      $project: {
        n: {
          $convert: {
            input: { $arrayElemAt: [{ $split: ['$referenceNumber', '-'] }, 1] },
            to: 'int',
            onError: 0,
            onNull: 0,
          },
        },
      },
    },
    { $group: { _id: null, maxNum: { $max: '$n' } } },
  ]);
  const nextNum = Math.max(1040, (row?.maxNum ?? 1039) + 1);
  return `INV-${nextNum}`;
}

export default mongoose.model('Invoice', invoiceSchema);

export { lineItemSchema };
