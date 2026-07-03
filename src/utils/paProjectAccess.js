import Project from '../models/Project.js';
import Custody from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import { CUSTODY_STATUS, INVOICE_STATUS } from '../constants/roles.js';

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/** Extract a valid MongoDB id string from a project ref or populated document. */
export function normalizeProjectRef(ref) {
  if (ref == null) return null;
  if (typeof ref === 'object') {
    const id = ref._id ?? ref.id;
    if (id != null) {
      const s = String(id);
      return OBJECT_ID_RE.test(s) ? s : null;
    }
  }
  const s = String(ref);
  return OBJECT_ID_RE.test(s) ? s : null;
}

export function normalizeProjectIds(refs = []) {
  return [...new Set(refs.map(normalizeProjectRef).filter(Boolean))];
}

/** Project IDs a custody accountant (PA) may access for reviews. */
export async function resolvePaProjectIds(userId, userProjects = []) {
  const fromAccountants = await Project.find({ accountants: userId }).distinct('_id');
  const ids = new Set([
    ...normalizeProjectIds(fromAccountants),
    ...normalizeProjectIds(userProjects),
  ]);

  if (!ids.size) {
    const [closedProjects, pendingInvoiceProjects] = await Promise.all([
      Custody.distinct('project', { status: CUSTODY_STATUS.CLOSED }),
      Invoice.distinct('project', { status: INVOICE_STATUS.PENDING_PM }),
    ]);
    for (const id of normalizeProjectIds([...closedProjects, ...pendingInvoiceProjects])) {
      ids.add(id);
    }
  }

  return [...ids];
}

export async function countPaQueueCustodies(projectIds) {
  const normalized = normalizeProjectIds(projectIds);
  if (!normalized.length) return 0;

  const [closedIds, pendingPmCustodyIds] = await Promise.all([
    Custody.distinct('_id', { project: { $in: normalized }, status: CUSTODY_STATUS.CLOSED }),
    Invoice.distinct('custody', {
      status: INVOICE_STATUS.PENDING_PM,
      project: { $in: normalized },
      custody: { $exists: true, $ne: null },
    }),
  ]);

  return new Set([...closedIds.map(String), ...pendingPmCustodyIds.map(String)]).size;
}
