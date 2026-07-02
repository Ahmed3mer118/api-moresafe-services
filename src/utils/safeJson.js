/** Build the same shape as User.prototype.toSafeJSON() from plain or document objects. */
export function toSafeUserJSON(user, extraProjects = []) {
  const populated = (user.projects || [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const id = String(p.id || p._id || '');
      if (!id) return null;
      return {
        id,
        _id: id,
        name: p.name || '',
        nameEn: p.nameEn,
        status: p.status || 'active',
      };
    })
    .filter(Boolean);

  const seen = new Set(populated.map((p) => p.id));
  const projects = [...populated];
  for (const p of extraProjects) {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      projects.push(p);
    }
  }

  return {
    id: user._id,
    name: user.name,
    nameEn: user.nameEn,
    email: user.email,
    role: user.role,
    phone: user.phone,
    language: user.language,
    isActive: user.isActive,
    projects,
    createdAt: user.createdAt,
  };
}
