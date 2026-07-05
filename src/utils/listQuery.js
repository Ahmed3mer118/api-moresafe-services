import { escapeRegex } from './escapeRegex.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 15;
export const MAX_LIMIT = 100;

/**
 * Parse standard list query params: page, limit, search, sort.
 */
export function parseListQuery(query = {}, options = {}) {
  const {
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = MAX_LIMIT,
    allowedSortFields = ['createdAt'],
    defaultSort = '-createdAt',
  } = options;

  const page = Math.max(1, parseInt(query.page, 10) || DEFAULT_PAGE);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const skip = (page - 1) * limit;
  const search = String(query.search || query.q || '').trim();

  let sort = defaultSort;
  const sortRaw = query.sort;
  if (sortRaw) {
    const desc = String(sortRaw).startsWith('-');
    const field = desc ? String(sortRaw).slice(1) : String(sortRaw);
    if (allowedSortFields.includes(field)) {
      sort = desc ? `-${field}` : field;
    }
  }

  return { page, limit, skip, search, sort };
}

export function paginatedResponse(items, total, page, limit) {
  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit) || 1),
  };
}

export function emptyPaginated(page = DEFAULT_PAGE, limit = DEFAULT_LIMIT) {
  return paginatedResponse([], 0, page, limit);
}

/** Build $or regex search across string fields */
export function searchFilter(search, fields) {
  if (!search) return null;
  const safe = escapeRegex(search);
  const regex = new RegExp(safe, 'i');
  return { $or: fields.map((field) => ({ [field]: regex })) };
}

export function applySearchToFilter(filter, search, fields) {
  const clause = searchFilter(search, fields);
  if (!clause) return filter;
  if (!Object.keys(filter).length) return clause;
  return { $and: [filter, clause] };
}

/**
 * Run a Mongoose query with pagination metadata.
 * @param {import('mongoose').Query} baseQuery - query before skip/limit
 */
export async function paginateMongooseQuery(baseQuery, { page, limit, skip }) {
  const model = baseQuery.model;
  const filter = baseQuery.getFilter();

  const [items, total] = await Promise.all([
    baseQuery.clone().skip(skip).limit(limit).exec(),
    model.countDocuments(filter),
  ]);

  return paginatedResponse(items, total, page, limit);
}
