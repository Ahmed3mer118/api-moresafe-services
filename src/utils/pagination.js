const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Optional pagination — when omitted, returns null (caller keeps legacy full-array behavior). */
export function parsePagination(query = {}) {
  const pageRaw = query.page;
  const limitRaw = query.limit;
  if (pageRaw == null && limitRaw == null) return null;

  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}
