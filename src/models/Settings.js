import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema(
  {
    companyName: { type: String, default: 'Moresafe' },
    companyNameEn: { type: String, default: 'Moresafe' },
    taxNumber: String,
    primaryColor: { type: String, default: '#2e9e5b' },
    currency: { type: String, default: 'SAR' },
    vatRate: { type: Number, default: 15 },
  },
  { timestamps: true }
);

export default mongoose.model('Settings', settingsSchema);
