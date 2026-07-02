import User from '../models/User.js';
import Project from '../models/Project.js';
import Custody from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Notification from '../models/Notification.js';
import ActivityLog from '../models/ActivityLog.js';
import Voucher, { nextVoucherNumber } from '../models/Voucher.js';
import Settings from '../models/Settings.js';
import { CUSTODY_STATUS, INVOICE_STATUS, ROLES } from '../constants/roles.js';
import {
  activityLast7Days,
  usersByRoleChart,
  custodyStatusChart,
  invoiceStatusChart,
  monthlySettledExpense,
  userInvoiceExpenseTrend,
  topSuppliers,
  allSuppliers,
  adminAnalyticsSummary,
  projectAccountantReports,
} from '../services/dashboardAnalytics.js';

export async function adminDashboard(req, res, next) {
  try {
    const [users, projects, custodies, logs, activityChart, roleChart] = await Promise.all([
      User.countDocuments({ isActive: true }),
      Project.countDocuments({ status: { $ne: 'closed' } }),
      Custody.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      ActivityLog.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('user', 'name nameEn')
        .lean(),
      activityLast7Days(),
      usersByRoleChart(),
    ]);

    res.json({
      users,
      projects,
      custodies,
      recentActivity: logs,
      activityChart,
      roleChart,
      rolesCount: roleChart.labels?.length ?? 0,
      systemStatus: 'online',
    });
  } catch (err) {
    next(err);
  }
}

export async function financeDashboard(req, res, next) {
  try {
    const [openCustodies, pendingSettlement, settled, totalExpense, pendingInvoices, expenseTrend, custodyChart] =
      await Promise.all([
        Custody.countDocuments({ status: CUSTODY_STATUS.OPEN }),
        Custody.countDocuments({ status: CUSTODY_STATUS.PM_APPROVED }),
        Custody.countDocuments({ status: CUSTODY_STATUS.SETTLED }),
        Custody.aggregate([
          { $match: { status: CUSTODY_STATUS.SETTLED } },
          { $group: { _id: null, total: { $sum: '$spent' } } },
        ]),
        Invoice.countDocuments({ status: INVOICE_STATUS.PENDING_FINANCE }),
        monthlySettledExpense(6),
        custodyStatusChart(),
      ]);

    res.json({
      openCustodies,
      pendingSettlement,
      settled,
      totalExpense: totalExpense[0]?.total || 0,
      pendingInvoices,
      expenseTrend,
      custodyChart,
    });
  } catch (err) {
    next(err);
  }
}

export async function projectManagerDashboard(req, res, next) {
  try {
    const projects = await Project.find({})
      .select('name nameEn budget spent status manager accountants')
      .populate('manager', 'name nameEn')
      .lean({ virtuals: true });
    const projectIds = projects.map((p) => p._id);

    const [pendingCustodies, managers, totalSpent, custodyChart, reports] = await Promise.all([
      Custody.countDocuments({ project: { $in: projectIds }, status: CUSTODY_STATUS.CLOSED }),
      User.countDocuments({ role: ROLES.PROJECT_MANAGER, projects: { $in: projectIds } }),
      Project.aggregate([
        { $match: { _id: { $in: projectIds } } },
        { $group: { _id: null, total: { $sum: '$spent' } } },
      ]),
      custodyStatusChart({ project: { $in: projectIds } }),
      projectAccountantReports(projectIds),
    ]);

    res.json({
      projects: projects.length,
      pendingCustodies,
      engineers: managers,
      totalSpent: totalSpent[0]?.total || 0,
      projectList: projects,
      custodyChart,
      reports,
    });
  } catch (err) {
    next(err);
  }
}

export async function projectAccountantDashboard(req, res, next) {
  try {
    const openCustody = await Custody.findOne({
      holder: req.user._id,
      status: CUSTODY_STATUS.OPEN,
    })
      .populate('project', 'name nameEn')
      .lean({ virtuals: true });

    const [openCount, rejected, draftInvoices, invoiceChart, expenseTrend, recentInvoices] =
      await Promise.all([
        Custody.countDocuments({ holder: req.user._id, status: CUSTODY_STATUS.OPEN }),
        Invoice.countDocuments({
          uploadedBy: req.user._id,
          status: { $in: [INVOICE_STATUS.PM_REJECTED, INVOICE_STATUS.FINANCE_REJECTED] },
        }),
        Invoice.countDocuments({
          uploadedBy: req.user._id,
          status: { $in: [INVOICE_STATUS.ACCUMULATED, INVOICE_STATUS.PENDING_PM, INVOICE_STATUS.DRAFT] },
        }),
        invoiceStatusChart({ uploadedBy: req.user._id }),
        userInvoiceExpenseTrend(req.user._id, 6),
        Invoice.find({ uploadedBy: req.user._id })
          .populate('project', 'name nameEn')
          .select('referenceNumber project supplier category total subtotal vatAmount status invoiceDate attachments attachmentUrl lineItems createdAt')
          .sort({ createdAt: -1 })
          .limit(8)
          .lean(),
      ]);

    res.json({
      openCustody,
      openCount,
      rejected,
      draftInvoices,
      remaining: openCustody?.remaining ?? 0,
      amount: openCustody?.amount ?? 0,
      invoiceChart,
      expenseTrend,
      recentInvoices,
    });
  } catch (err) {
    next(err);
  }
}

export async function adminAnalytics(req, res, next) {
  try {
    const summary = await adminAnalyticsSummary();
    const recentActivity = await ActivityLog.find()
      .sort({ createdAt: -1 })
      .limit(8)
      .populate('user', 'name nameEn')
      .lean();
    res.json({ ...summary, recentActivity });
  } catch (err) {
    next(err);
  }
}

export async function financeSuppliers(req, res, next) {
  try {
    const suppliers = await allSuppliers();
    const grandTotal = suppliers.reduce((sum, s) => sum + (s.total || 0), 0);
    res.json({ suppliers, grandTotal, supplierCount: suppliers.length });
  } catch (err) {
    next(err);
  }
}

export async function financeReportsSummary(req, res, next) {
  try {
    const [openCustodies, settled, invoices, expenseTrend] = await Promise.all([
      Custody.countDocuments({ status: { $nin: [CUSTODY_STATUS.SETTLED] } }),
      Custody.countDocuments({ status: CUSTODY_STATUS.SETTLED }),
      Invoice.countDocuments(),
      monthlySettledExpense(6),
    ]);
    res.json({ openCustodies, settled, invoices, expenseTrend });
  } catch (err) {
    next(err);
  }
}

export async function listVouchers(req, res, next) {
  try {
    const vouchers = await Voucher.find()
      .populate('beneficiary', 'name nameEn')
      .populate('project', 'name nameEn')
      .sort({ createdAt: -1 })
      .lean();
    res.json(vouchers);
  } catch (err) {
    next(err);
  }
}

export async function createVoucher(req, res, next) {
  try {
    const { beneficiaryId, beneficiary, amount, method, bankReference, project, projectId } = req.body;
    const beneficiaryRef = beneficiaryId || beneficiary;
    if (!beneficiaryRef) {
      return res.status(400).json({ message: 'beneficiary is required' });
    }
    if (!amount) {
      return res.status(400).json({ message: 'amount is required' });
    }

    const voucher = await Voucher.create({
      beneficiary: beneficiaryRef,
      amount: Number(amount),
      method: method || 'bank_transfer',
      bankReference,
      project: projectId || project,
      voucherNumber: await nextVoucherNumber(),
      createdBy: req.user._id,
    });

    const populated = await Voucher.findById(voucher._id).populate('beneficiary', 'name nameEn email');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function getSettings(req, res, next) {
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    res.json(settings);
  } catch (err) {
    next(err);
  }
}

export async function updateSettings(req, res, next) {
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create(req.body);
    else Object.assign(settings, req.body);
    await settings.save();
    res.json(settings);
  } catch (err) {
    next(err);
  }
}

export async function listNotifications(req, res, next) {
  try {
    const notifications = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const unread = await Notification.countDocuments({ user: req.user._id, isRead: false });
    res.json({ notifications, unread });
  } catch (err) {
    next(err);
  }
}

export async function markNotificationRead(req, res, next) {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { isRead: true }
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function listActivityLogs(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      ActivityLog.find()
        .populate('user', 'name nameEn role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments(),
    ]);

    res.json({
      items: logs,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

export async function taxCompliance(req, res, next) {
  try {
    const invoices = await Invoice.find({ taxNumber: { $exists: true } })
      .select('referenceNumber supplier taxNumber vatAmount taxVerified total status')
      .sort({ createdAt: -1 })
      .lean();
    res.json(invoices);
  } catch (err) {
    next(err);
  }
}

export async function settledArchive(req, res, next) {
  try {
    const custodies = await Custody.find({ status: CUSTODY_STATUS.SETTLED })
      .populate('holder', 'name nameEn')
      .populate('project', 'name nameEn')
      .populate('invoices')
      .sort({ settledAt: -1 })
      .lean({ virtuals: true });
    res.json(custodies);
  } catch (err) {
    next(err);
  }
}
