import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    actionEn: String,
    entityType: String,
    entityId: mongoose.Schema.Types.ObjectId,
    details: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

export default mongoose.model('ActivityLog', activityLogSchema);
