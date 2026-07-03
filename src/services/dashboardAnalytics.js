import ActivityLog from '../models/ActivityLog.js';
import User from '../models/User.js';
import Custody from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Project from '../models/Project.js';
import { CUSTODY_STATUS, INVOICE_STATUS, ROLES } from '../constants/roles.js';

const AR_WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTHS = ['ينا', 'فبر', 'مار', 'أبر', 'ماي', 'يون', 'يول', 'أغس', 'سبت', 'أكت', 'نوف', 'ديس'];

function mapToSeries(items, labels, getKey, getValue = (x) => x.count) {
  const map = new Map(items.map((i) => [getKey(i), getValue(i)]));
  return labels.map((label) => map.get(label) ?? 0);
}

export async function activityLast7Days() {
  const days = [];
  const keys = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    keys.push(key);
    days.push(AR_WEEKDAYS[d.getDay()]);
  }

  const since = new Date(keys[0]);
  const rows = await ActivityLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
  ]);

  return { labels: days, data: mapToSeries(rows, keys, (r) => r._id) };
}

export async function usersByRoleChart() {
  const rows = await User.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ]);

  const roleLabels = {
    [ROLES.PROJECT_MANAGER]: 'مدير مشروع',
    [ROLES.PROJECT_ACCOUNTANT]: 'محاسب مشروع',
    [ROLES.CHIEF_ACCOUNTANT]: 'المالية',
    [ROLES.ADMIN]: 'مدير النظام',
  };

  const labels = rows.map((r) => roleLabels[r._id] || r._id);
  const data = rows.map((r) => r.count);
  return { labels, data, total: data.reduce((s, n) => s + n, 0) };
}

export async function custodyStatusChart(filter = {}) {
  const rows = await Custody.aggregate([
    { $match: filter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const statusLabels = {
    [CUSTODY_STATUS.OPEN]: 'مفتوحة',
    [CUSTODY_STATUS.CLOSED]: 'بانتظار الاعتماد',
    [CUSTODY_STATUS.PM_APPROVED]: 'بانتظار المالية',
    [CUSTODY_STATUS.PM_REJECTED]: 'مرفوضة',
    [CUSTODY_STATUS.SETTLED]: 'مسوّاة',
    [CUSTODY_STATUS.FINANCE_REJECTED]: 'رفض مالي',
  };

  return {
    labels: rows.map((r) => statusLabels[r._id] || r._id),
    data: rows.map((r) => r.count),
  };
}

export async function invoiceStatusChart(filter = {}) {
  const rows = await Invoice.aggregate([
    { $match: filter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const statusLabels = {
    [INVOICE_STATUS.ACCUMULATED]: 'مجمّعة',
    [INVOICE_STATUS.PENDING_PM]: 'بانتظار المدير',
    [INVOICE_STATUS.PENDING_FINANCE]: 'بانتظار المالية',
    [INVOICE_STATUS.PM_REJECTED]: 'مرفوضة',
    [INVOICE_STATUS.FINANCE_REJECTED]: 'رفض مالي',
    [INVOICE_STATUS.SETTLED]: 'مسوّاة',
    [INVOICE_STATUS.FINANCE_APPROVED]: 'معتمدة',
  };

  return {
    labels: rows.map((r) => statusLabels[r._id] || r._id),
    data: rows.map((r) => r.count),
  };
}

export async function monthlySettledExpense(months = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - (months - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const rows = await Custody.aggregate([
    { $match: { status: CUSTODY_STATUS.SETTLED, settledAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$settledAt' } },
        total: { $sum: '$spent' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const labels = [];
  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    keys.push(key);
    labels.push(AR_MONTHS[d.getMonth()]);
  }

  return {
    labels,
    data: mapToSeries(rows, keys, (r) => r._id, (r) => r.total),
  };
}

export async function userInvoiceExpenseTrend(userId, months = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - (months - 1));
  since.setDate(1);

  const rows = await Invoice.aggregate([
    { $match: { uploadedBy: userId, createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
        total: { $sum: '$total' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const labels = [];
  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    labels.push(AR_MONTHS[d.getMonth()]);
  }

  return {
    labels,
    data: mapToSeries(rows, keys, (r) => r._id, (r) => r.total),
  };
}

export async function allSuppliers() {
  return Invoice.aggregate([
    { $match: { supplier: { $exists: true, $nin: [null, ''] } } },
    {
      $group: {
        _id: '$supplier',
        total: { $sum: '$total' },
        count: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

export async function topSuppliers(limit = 5) {
  return Invoice.aggregate([
    { $match: { supplier: { $exists: true, $nin: [null, ''] } } },
    {
      $group: {
        _id: '$supplier',
        total: { $sum: '$total' },
        count: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
    { $limit: limit },
  ]);
}

export async function adminAnalyticsSummary() {
  const [settledCycles, expenseAgg, nearBudget, suppliers, avgSettlement] = await Promise.all([
    Custody.countDocuments({ status: CUSTODY_STATUS.SETTLED }),
    Custody.aggregate([
      { $match: { status: CUSTODY_STATUS.SETTLED } },
      { $group: { _id: null, total: { $sum: '$spent' } } },
    ]),
    Project.countDocuments({ status: 'near_budget' }),
    Invoice.distinct('supplier', { supplier: { $exists: true, $nin: [null, ''] } }),
    Custody.aggregate([
      {
        $match: {
          status: CUSTODY_STATUS.SETTLED,
          closedAt: { $exists: true },
          settledAt: { $exists: true },
        },
      },
      {
        $project: {
          hours: {
            $divide: [{ $subtract: ['$settledAt', '$closedAt'] }, 1000 * 60 * 60],
          },
        },
      },
      { $group: { _id: null, avg: { $avg: '$hours' } } },
    ]),
  ]);

  const expenseTrend = await monthlySettledExpense(6);

  return {
    settledCycles,
    totalExpense: expenseAgg[0]?.total || 0,
    activeSuppliers: suppliers.length,
    nearBudgetAlerts: nearBudget,
    avgSettlementHours: Math.round((avgSettlement[0]?.avg || 0) * 10) / 10,
    expenseTrend,
    topSuppliers: await topSuppliers(5),
  };
}

export async function projectAccountantReports(projectIds) {
  const filter = projectIds?.length ? { project: { $in: projectIds } } : {};

  const [rejectedInvoices, nearBudget, avgApprovalAgg, projects] = await Promise.all([
    Invoice.countDocuments({
      ...filter,
      status: { $in: [INVOICE_STATUS.PM_REJECTED, INVOICE_STATUS.FINANCE_REJECTED] },
    }),
    Project.countDocuments({
      ...(projectIds?.length ? { _id: { $in: projectIds } } : {}),
      status: 'near_budget',
    }),
    Custody.aggregate([
      {
        $match: {
          ...filter,
          status: CUSTODY_STATUS.SETTLED,
          closedAt: { $exists: true },
          pmApprovedAt: { $exists: true },
        },
      },
      {
        $project: {
          hours: {
            $max: [
              0,
              {
                $divide: [{ $subtract: ['$pmApprovedAt', '$closedAt'] }, 1000 * 60 * 60],
              },
            ],
          },
        },
      },
      { $group: { _id: null, avg: { $avg: '$hours' } } },
    ]),
    Project.find(projectIds?.length ? { _id: { $in: projectIds } } : {})
      .select('budget spent')
      .lean(),
  ]);

  const avgApprovalHours = Math.round((avgApprovalAgg[0]?.avg || 0) * 10) / 10;

  let budgetCompliance = 100;
  if (projects.length) {
    const within = projects.filter((p) => !p.budget || p.spent / p.budget <= 0.9).length;
    budgetCompliance = Math.round((within / projects.length) * 100);
  }

  const expenseTrend = await monthlySettledExpense(4);

  return {
    avgApprovalHours,
    budgetCompliance,
    rejectedInvoices,
    nearBudgetProjects: nearBudget,
    expenseTrend,
  };
}

export async function adminDisbursementReports(projectId) {
  const custodyMatch = {};
  if (projectId) {
    custodyMatch.project = projectId;
  }

  const managerRows = await Custody.aggregate([
    { $match: custodyMatch },
    {
      $group: {
        _id: '$holder',
        custodiesCount: { $sum: 1 },
        totalAllocated: { $sum: '$amount' },
        totalSpent: { $sum: '$spent' },
        settledCount: {
          $sum: { $cond: [{ $eq: ['$status', CUSTODY_STATUS.SETTLED] }, 1, 0] },
        },
        overBudgetCount: {
          $sum: { $cond: [{ $gt: ['$spent', '$amount'] }, 1, 0] },
        },
        openCount: {
          $sum: { $cond: [{ $eq: ['$status', CUSTODY_STATUS.OPEN] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        userId: '$_id',
        name: '$user.name',
        nameEn: '$user.nameEn',
        custodiesCount: 1,
        totalAllocated: 1,
        totalSpent: 1,
        settledCount: 1,
        overBudgetCount: 1,
        openCount: 1,
      },
    },
    { $sort: { totalSpent: -1 } },
  ]);

  const accountantRows = await Custody.aggregate([
    { $match: { ...custodyMatch, pmApprovedBy: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: '$pmApprovedBy',
        reviewedCount: { $sum: 1 },
        approvedCount: {
          $sum: {
            $cond: [
              {
                $in: [
                  '$status',
                  [CUSTODY_STATUS.PM_APPROVED, CUSTODY_STATUS.FINANCE_PENDING, CUSTODY_STATUS.SETTLED],
                ],
              },
              1,
              0,
            ],
          },
        },
        rejectedCount: {
          $sum: { $cond: [{ $eq: ['$status', CUSTODY_STATUS.PM_REJECTED] }, 1, 0] },
        },
        totalReviewedAmount: { $sum: '$spent' },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        userId: '$_id',
        name: '$user.name',
        nameEn: '$user.nameEn',
        reviewedCount: 1,
        approvedCount: 1,
        rejectedCount: 1,
        totalReviewedAmount: 1,
      },
    },
    { $sort: { reviewedCount: -1 } },
  ]);

  let custodyIds = null;
  if (projectId) {
    custodyIds = (await Custody.find(custodyMatch).select('_id').lean()).map((c) => c._id);
  }

  const logMatch = {
    entityType: 'custody',
    $or: [
      { actionEn: { $regex: /^Settled / } },
      { actionEn: { $regex: /^Finance rejected / } },
    ],
  };
  if (custodyIds) {
    logMatch.entityId = { $in: custodyIds };
  }

  const chiefRows = await ActivityLog.aggregate([
    { $match: logMatch },
    {
      $group: {
        _id: '$user',
        settledCount: {
          $sum: { $cond: [{ $regexMatch: { input: '$actionEn', regex: /^Settled / } }, 1, 0] },
        },
        rejectedCount: {
          $sum: { $cond: [{ $regexMatch: { input: '$actionEn', regex: /^Finance rejected / } }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        userId: '$_id',
        name: '$user.name',
        nameEn: '$user.nameEn',
        settledCount: 1,
        rejectedCount: 1,
      },
    },
    { $sort: { settledCount: -1 } },
  ]);

  const projectRows = await Custody.aggregate([
    { $match: custodyMatch },
    {
      $group: {
        _id: '$project',
        custodiesCount: { $sum: 1 },
        totalAllocated: { $sum: '$amount' },
        totalSpent: { $sum: '$spent' },
        settledCount: {
          $sum: { $cond: [{ $eq: ['$status', CUSTODY_STATUS.SETTLED] }, 1, 0] },
        },
        overBudgetCount: {
          $sum: { $cond: [{ $gt: ['$spent', '$amount'] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: 'projects',
        localField: '_id',
        foreignField: '_id',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        projectId: '$_id',
        name: '$project.name',
        nameEn: '$project.nameEn',
        budget: '$project.budget',
        custodiesCount: 1,
        totalAllocated: 1,
        totalSpent: 1,
        settledCount: 1,
        overBudgetCount: 1,
      },
    },
    { $sort: { totalSpent: -1 } },
  ]);

  const totalsAgg = await Custody.aggregate([
    { $match: custodyMatch },
    {
      $group: {
        _id: null,
        custodiesCount: { $sum: 1 },
        totalAllocated: { $sum: '$amount' },
        totalSpent: { $sum: '$spent' },
        settledCount: {
          $sum: { $cond: [{ $eq: ['$status', CUSTODY_STATUS.SETTLED] }, 1, 0] },
        },
        overBudgetCount: {
          $sum: { $cond: [{ $gt: ['$spent', '$amount'] }, 1, 0] },
        },
      },
    },
  ]);

  const invoiceMatch = projectId ? { project: projectId } : {};
  const invoiceCount = await Invoice.countDocuments(invoiceMatch);

  return {
    byManager: managerRows,
    byAccountant: accountantRows,
    byChief: chiefRows,
    byProject: projectRows,
    totals: {
      ...(totalsAgg[0] || {
        custodiesCount: 0,
        totalAllocated: 0,
        totalSpent: 0,
        settledCount: 0,
        overBudgetCount: 0,
      }),
      invoiceCount,
    },
  };
}
