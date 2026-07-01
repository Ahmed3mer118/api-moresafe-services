import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true },
    code: { type: String, unique: true, sparse: true },
    description: String,
    budget: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'near_budget', 'new', 'closed'],
      default: 'active',
    },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    accountants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    engineers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    startDate: Date,
    endDate: Date,
  },
  { timestamps: true }
);

projectSchema.virtual('remaining').get(function remaining() {
  return Math.max(0, this.budget - this.spent);
});

projectSchema.set('toJSON', { virtuals: true });
projectSchema.set('toObject', { virtuals: true });

export default mongoose.model('Project', projectSchema);
