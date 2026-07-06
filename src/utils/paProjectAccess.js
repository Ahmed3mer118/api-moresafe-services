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

/**
 * Project IDs a custody accountant (PA) may access.
 * No explicit assignment → all projects.
 * One or more assigned projects → only those projects.
 */
export async function resolvePaProjectIds(userId, userProjects = []) {
  const fromAccountants = await Project.find({ accountants: userId }).distinct('_id');
  const assigned = normalizeProjectIds([...fromAccountants, ...userProjects]);

  if (!assigned.length) {
    const all = await Project.distinct('_id');
    return all.map(String);
  }

  return assigned;
}

/** Custodies with accumulated invoices stuck in rejected/open — move back to PA queue (closed) */
export async function repairCustodiesWithPendingInvoices() {
  const pendingCustodyIds = await Invoice.distinct('custody', {
    status: INVOICE_STATUS.ACCUMULATED,
    custody: { $exists: true, $ne: null },
  });
  if (!pendingCustodyIds.length) return;

  const [financePipelineIds, disbursementIds] = await Promise.all([
    Invoice.distinct('custody', {
      custody: { $in: pendingCustodyIds },
      status: {
        $in: [
          INVOICE_STATUS.PENDING_FINANCE,
          INVOICE_STATUS.FINANCE_APPROVED,
          INVOICE_STATUS.SETTLED,
        ],
      },
    }),
    Custody.distinct('_id', {
      _id: { $in: pendingCustodyIds },
      status: CUSTODY_STATUS.FINANCE_PENDING,
    }),
  ]);
  const skip = new Set([
    ...financePipelineIds.map(String),
    ...disbursementIds.map(String),
  ]);
  const repairIds = pendingCustodyIds.filter((id) => !skip.has(String(id)));
  if (!repairIds.length) return;

  await Custody.updateMany(
    {
      _id: { $in: repairIds },
      status: {
        $in: [
          CUSTODY_STATUS.PM_REJECTED,
          CUSTODY_STATUS.FINANCE_REJECTED,
          CUSTODY_STATUS.OPEN,
          CUSTODY_STATUS.PM_APPROVED,
        ],
      },
    },
    { $set: { status: CUSTODY_STATUS.CLOSED, closedAt: new Date() } },
  );
}

/**
 * PA finished but invoices stuck at pm_approved — move to pending_finance
 * (skip custodies that still have pending_pm invoices).
 */
export async function promotePaApprovedInvoicesToFinance() {
  await Invoice.updateMany(
    {
      status: INVOICE_STATUS.PM_APPROVED,
      custody: { $exists: true, $ne: null },
    },
    { $set: { status: INVOICE_STATUS.PENDING_FINANCE } },
  );
}

/**
 * Custodies with pending_finance invoices (PA done) stuck in closed/rejected —
 * promote to pm_approved so chief accountant can settle.
 */
export async function repairCustodiesAwaitingFinance() {
  await promotePaApprovedInvoicesToFinance();

  const pendingFinanceCustodyIds = await Invoice.distinct('custody', {
    status: INVOICE_STATUS.PENDING_FINANCE,
    custody: { $exists: true, $ne: null },
  });
  if (!pendingFinanceCustodyIds.length) return;

  await Custody.updateMany(
    {
      _id: { $in: pendingFinanceCustodyIds },
      status: {
        $in: [
          CUSTODY_STATUS.CLOSED,
          CUSTODY_STATUS.OPEN,
          CUSTODY_STATUS.PM_REJECTED,
          CUSTODY_STATUS.FINANCE_REJECTED,
          CUSTODY_STATUS.SETTLED,
        ],
      },
    },
    { $set: { status: CUSTODY_STATUS.PM_APPROVED } },
  );
}

/** Custodies with finance_approved invoices awaiting bank disbursement */
export async function resolveDisbursementQueueCustodyIds() {
  return Invoice.distinct('custody', {
    status: INVOICE_STATUS.FINANCE_APPROVED,
    custody: { $exists: true, $ne: null },
  }).then((ids) => ids.map(String));
}

/** Custodies settled by finance (finance_approved invoices) stuck in closed/settled — restore disbursement queue */
export async function repairCustodiesAwaitingDisbursement() {
  const custodyIds = await Invoice.distinct('custody', {
    status: INVOICE_STATUS.FINANCE_APPROVED,
    custody: { $exists: true, $ne: null },
  });
  if (!custodyIds.length) return;

  await Custody.updateMany(
    {
      _id: { $in: custodyIds },
      status: {
        $in: [
          CUSTODY_STATUS.CLOSED,
          CUSTODY_STATUS.OPEN,
          CUSTODY_STATUS.PM_APPROVED,
          CUSTODY_STATUS.PM_REJECTED,
          CUSTODY_STATUS.FINANCE_REJECTED,
          CUSTODY_STATUS.SETTLED,
        ],
      },
    },
    { $set: { status: CUSTODY_STATUS.FINANCE_PENDING } },
  );
}

/** Custodies that finished disbursement but status was downgraded (e.g. by repair) */
export async function repairSettledCustodyStatus() {
  const awaitingDisbursementIds = await Invoice.distinct('custody', {
    status: INVOICE_STATUS.FINANCE_APPROVED,
    custody: { $exists: true, $ne: null },
  });

  const filter = {
    $or: [
      { settledAt: { $exists: true, $ne: null } },
      { disbursementProof: { $exists: true, $ne: null } },
    ],
    status: { $ne: CUSTODY_STATUS.SETTLED },
  };
  if (awaitingDisbursementIds.length) {
    filter._id = { $nin: awaitingDisbursementIds };
  }

  await Custody.updateMany(filter, { $set: { status: CUSTODY_STATUS.SETTLED } });
}

/** Custody IDs chief accountant must see (pending finance invoices) */
export async function resolveFinanceQueueCustodyIds() {
  return Invoice.distinct('custody', {
    status: INVOICE_STATUS.PENDING_FINANCE,
    custody: { $exists: true, $ne: null },
  }).then((ids) => ids.map(String));
}

/** Custody IDs visible in the PA approval queue for given project scope */
export async function resolvePaQueueCustodyIds(projectIds) {
  const normalized = normalizeProjectIds(projectIds);
  if (!normalized.length) return [];

  const pendingPaCustodyIds = await Invoice.distinct('custody', {
    status: INVOICE_STATUS.ACCUMULATED,
    project: { $in: normalized },
    custody: { $exists: true, $ne: null },
  });

  return pendingPaCustodyIds.map(String);
}

export async function countPaQueueCustodies(projectIds) {
  const normalized = normalizeProjectIds(projectIds);
  if (!normalized.length) return 0;

  const pendingPaCustodyIds = await Invoice.distinct('custody', {
    status: INVOICE_STATUS.ACCUMULATED,
    project: { $in: normalized },
    custody: { $exists: true, $ne: null },
  });
  if (!pendingPaCustodyIds.length) return 0;

  const ids = await Custody.distinct('_id', {
    _id: { $in: pendingPaCustodyIds },
    project: { $in: normalized },
  });

  return ids.length;
}

/** Invoice count awaiting PM review on a holder's custodies */
export async function countPmQueueInvoices(holderId) {
  if (!holderId) {
    return Invoice.countDocuments({
      status: INVOICE_STATUS.PENDING_PM,
      custody: { $exists: true, $ne: null },
    });
  }
  const custodyIds = await Custody.distinct('_id', { holder: holderId });
  if (!custodyIds.length) return 0;
  return Invoice.countDocuments({
    status: INVOICE_STATUS.PENDING_PM,
    custody: { $in: custodyIds },
  });
}
