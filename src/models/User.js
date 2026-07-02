import mongoose from 'mongoose';
import { ROLES } from '../constants/roles.js';
import { comparePassword as bcryptCompare } from '../utils/password.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameEn: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true, minlength: 6 },
    role: {
      type: String,
      enum: Object.values(ROLES),
      required: true,
    },
    phone: String,
    avatar: String,
    language: { type: String, enum: ['ar', 'en'], default: 'ar' },
    isActive: { type: Boolean, default: true },
    projects: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }],
  },
  { timestamps: true }
);

userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ projects: 1 });
userSchema.index({ name: 1 });
// Note: avoid text index — User.language field conflicts with MongoDB text language_override ('ar' unsupported)

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcryptCompare(candidate, this.password);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id,
    name: this.name,
    nameEn: this.nameEn,
    email: this.email,
    role: this.role,
    phone: this.phone,
    language: this.language,
    isActive: this.isActive,
    projects: this.projects,
    createdAt: this.createdAt,
  };
};

export default mongoose.model('User', userSchema);
