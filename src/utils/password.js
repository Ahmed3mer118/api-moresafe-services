import bcrypt from 'bcryptjs';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
