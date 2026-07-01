import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { ROLE_DASHBOARD } from '../constants/roles.js';
import { hashPassword } from '../utils/password.js';

function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() }).populate('projects', 'name nameEn');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'Account disabled' });
    }

    const token = signToken(user);
    res.json({
      token,
      user: user.toSafeJSON(),
      dashboard: ROLE_DASHBOARD[user.role],
    });
  } catch (err) {
    next(err);
  }
}

export async function me(req, res) {
  res.json({
    user: req.user.toSafeJSON(),
    dashboard: ROLE_DASHBOARD[req.user.role],
  });
}

export async function updateProfile(req, res, next) {
  try {
    const { name, nameEn, phone, language } = req.body;
    if (name) req.user.name = name;
    if (nameEn !== undefined) req.user.nameEn = nameEn;
    if (phone !== undefined) req.user.phone = phone;
    if (language) req.user.language = language;
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    const valid = await req.user.comparePassword(currentPassword);
    if (!valid) return res.status(400).json({ message: 'Current password incorrect' });
    req.user.password = await hashPassword(newPassword);
    await req.user.save();
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
}
