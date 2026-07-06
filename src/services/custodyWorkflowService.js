import { CUSTODY_STATUS, INVOICE_STATUS, ROLES, PM_SUBMIT_CUSTODY_STATUSES } from '../constants/roles.js';
import { repairCustodiesWithPendingInvoices, repairCustodiesAwaitingFinance, repairCustodiesAwaitingDisbursement, repairSettledCustodyStatus, promotePaApprovedInvoicesToFinance } from '../utils/paProjectAccess.js';
import Custody from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import Voucher, { nextVoucherNumber } from '../models/Voucher.js';
import { createNotification, logActivity } from './notificationService.js';
import { recordCustodyTransaction } from './custodyTransactionService.js';
import {
  buildAccrualEntry,
  buildDisbursementEntry,
  appendAccrualEntry,
  appendDisbursementEntry,
} from '../utils/journalEntries.js';

async function notifyPaForCustodySubmission(project, custody, { count, total, resubmit = false }) {
  let accountantIds = project.accountants?.length ? [...project.accountants] : [];
  if (!accountantIds.length) {
    const accountants = await User.find({ role: ROLES.PROJECT_ACCOUNTANT, isActive: true }).select('_id').lean();
    accountantIds = accountants.map((u) => u._id);
  }

  await Promise.all(
    accountantIds.map((accountantId) =>
      createNotification({
        userId: accountantId,
        title: resubmit ? 'إعادة إرسال فواتير عهدة' : 'فواتير عهدة بانتظار المراجعة',
        titleEn: resubmit ? 'Custody invoices resubmitted' : 'Custody invoices awaiting review',
        message: `عهدة ${custody.custodyNumber} — ${project.name} (${count} فاتورة · ${total} ريال)`,
        messageEn: `Custody ${custody.custodyNumber} — ${project.nameEn || project.name} (${count} invoice(s) · ${total} SAR)`,
        type: 'info',
        link: '/dashboard/project-accountant/approvals',
      })
    )
  );
}

const APPROVED_INVOICE_STATUSES = [
  INVOICE_STATUS.PM_APPROVED,
  INVOICE_STATUS.PENDING_FINANCE,
  INVOICE_STATUS.FINANCE_APPROVED,
  INVOICE_STATUS.SETTLED,
];

const FINANCE_ELIGIBLE_STATUSES = [
  INVOICE_STATUS.PENDING_FINANCE,
  INVOICE_STATUS.FINANCE_APPROVED,
  INVOICE_STATUS.SETTLED,
];

const ACTIVE_INVOICE_STATUSES = [
  INVOICE_STATUS.ACCUMULATED,
  INVOICE_STATUS.PENDING_PM,
  INVOICE_STATUS.PM_APPROVED,
  INVOICE_STATUS.PENDING_FINANCE,
  INVOICE_STATUS.FINANCE_APPROVED,
  INVOICE_STATUS.SETTLED,
];

function sumInvoices(invoices, statuses) {
  return invoices
    .filter((i) => statuses.includes(i.status))
    .reduce((s, i) => s + (i.total || 0), 0);
}

async function recalcCustodyTotals(custodyId) {
  const custody = await Custody.findById(custodyId);
  if (!custody) return null;

  const invoices = await Invoice.find({ custody: custodyId });
  custody.spent = sumInvoices(invoices, ACTIVE_INVOICE_STATUSES);
  custody.submittedSpent = sumInvoices(invoices, [
    INVOICE_STATUS.PENDING_PM,
    ...APPROVED_INVOICE_STATUSES,
  ]);
  custody.approvedSpent = sumInvoices(invoices, APPROVED_INVOICE_STATUSES);
  await custody.save();
  return custody;
}

export class CustodyWorkflowService {
  async closeCustody(custodyId, userId, invoiceIds = []) {
    const custody = await Custody.findById(custodyId).populate('project');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (!PM_SUBMIT_CUSTODY_STATUSES.includes(custody.status)) {
      throw Object.assign(new Error('Custody is not open for submission'), { status: 400 });
    }

    const resubmitting = [
      CUSTODY_STATUS.PM_REJECTED,
      CUSTODY_STATUS.FINANCE_REJECTED,
      CUSTODY_STATUS.PM_APPROVED,
      CUSTODY_STATUS.FINANCE_PENDING,
      CUSTODY_STATUS.SETTLED,
    ].includes(custody.status);
    if (String(custody.holder) !== String(userId)) {
      throw Object.assign(new Error('Not your custody'), { status: 403 });
    }

    const idList = Array.isArray(invoiceIds) ? invoiceIds.filter(Boolean) : [];
    const invoiceFilter = {
      custody: custodyId,
      status: INVOICE_STATUS.ACCUMULATED,
    };
    if (idList.length) {
      invoiceFilter._id = { $in: idList };
    }

    const invoices = await Invoice.find(invoiceFilter);
    if (!invoices.length) {
      throw Object.assign(new Error('Select at least one invoice to submit'), { status: 400 });
    }

    const selectedTotal = invoices.reduce((s, i) => s + i.total, 0);
    const selectedIds = invoices.map((i) => i._id);

    const remainingAccumulated = await Invoice.countDocuments({
      custody: custodyId,
      status: INVOICE_STATUS.ACCUMULATED,
    });

    if (resubmitting) {
      custody.pmRejectionReason = undefined;
      custody.financeRejectionReason = undefined;
    }

    if (remainingAccumulated) {
      custody.status = CUSTODY_STATUS.OPEN;
    } else {
      custody.status = CUSTODY_STATUS.CLOSED;
      custody.closedAt = new Date();
    }

    const allActive = await Invoice.find({
      custody: custodyId,
      status: {
        $nin: [
          INVOICE_STATUS.PM_REJECTED,
          INVOICE_STATUS.FINANCE_REJECTED,
          INVOICE_STATUS.SETTLED,
          INVOICE_STATUS.DRAFT,
        ],
      },
    });
    custody.spent = allActive.reduce((s, i) => s + i.total, 0);
    custody.submittedSpent = sumInvoices(
      await Invoice.find({
        custody: custodyId,
        status: {
          $in: [
            INVOICE_STATUS.ACCUMULATED,
            INVOICE_STATUS.PENDING_PM,
            INVOICE_STATUS.PM_APPROVED,
            INVOICE_STATUS.PENDING_FINANCE,
            INVOICE_STATUS.FINANCE_APPROVED,
            INVOICE_STATUS.SETTLED,
          ],
        },
      }),
      [
        INVOICE_STATUS.ACCUMULATED,
        INVOICE_STATUS.PENDING_PM,
        INVOICE_STATUS.PM_APPROVED,
        INVOICE_STATUS.PENDING_FINANCE,
        INVOICE_STATUS.FINANCE_APPROVED,
        INVOICE_STATUS.SETTLED,
      ]
    );
    await custody.save();

    const project = await Project.findById(custody.project).populate('manager');
    if (project) {
      await notifyPaForCustodySubmission(project, custody, {
        count: invoices.length,
        total: selectedTotal,
        resubmit: resubmitting,
      });
    }

    if (custody.spent > custody.amount) {
      const admins = await User.find({ role: ROLES.ADMIN, isActive: true }).select('_id').lean();
      await Promise.all(
        admins.map((a) =>
          createNotification({
            userId: a._id,
            title: 'تنبيه: تجاوز رصيد العهدة',
            titleEn: 'Alert: custody over budget',
            message: `${custody.custodyNumber} — المصروف ${custody.spent} / ${custody.amount}`,
            messageEn: `${custody.custodyNumber} — spent ${custody.spent} / ${custody.amount}`,
            type: 'warning',
            link: '/dashboard/admin/disbursement',
          })
        )
      );
    }

    await logActivity({
      userId,
      action: `إغلاق عهدة ${custody.custodyNumber}`,
      actionEn: `Closed custody ${custody.custodyNumber}`,
      entityType: 'Custody',
      entityId: custody._id,
    });

    return custody;
  }

  async approveByPM(custodyId, userId, approved = true, reason = '') {
    const custody = await Custody.findById(custodyId).populate('project holder');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (custody.status !== CUSTODY_STATUS.CLOSED) {
      throw Object.assign(new Error('Custody not pending PM approval'), { status: 400 });
    }

    const approver = await User.findById(userId).select('role').lean();
    if (!approver || approver.role !== ROLES.PROJECT_ACCOUNTANT) {
      throw Object.assign(new Error('Not authorized to approve custody'), { status: 403 });
    }

    if (approved) {
      await Invoice.updateMany(
        { custody: custodyId, status: INVOICE_STATUS.ACCUMULATED },
        { $set: { status: INVOICE_STATUS.PENDING_PM, approvedBy: userId, approvedAt: new Date() } }
      );

      const holder = custody.holder;
      if (holder?._id) {
        await createNotification({
          userId: holder._id,
          title: 'فواتير بانتظار اعتمادك',
          titleEn: 'Invoices awaiting your approval',
          message: `عهدة ${custody.custodyNumber} — بانتظار مراجعة مدير المشاريع`,
          messageEn: `Custody ${custody.custodyNumber} — awaiting project manager review`,
          type: 'info',
          link: '/dashboard/project-manager/approvals',
        });
      }
    } else {
      custody.status = CUSTODY_STATUS.PM_REJECTED;
      custody.pmRejectionReason = reason;
      await Invoice.updateMany(
        { custody: custodyId, status: INVOICE_STATUS.ACCUMULATED },
        {
          status: INVOICE_STATUS.PM_REJECTED,
          rejectionReason: reason,
          rejectedBy: userId,
        },
      );

      await createNotification({
        userId: custody.holder._id,
        title: 'رفض محاسب المشروع للعهدة',
        titleEn: 'Project accountant rejected custody',
        message: reason || 'يرجى المراجعة وإعادة الإرسال',
        messageEn: reason || 'Please review and resubmit',
        type: 'reject',
        link: '/dashboard/project-manager/rejected',
      });
    }

    await custody.save();
    await logActivity({
      userId,
      action: approved ? `اعتماد عهدة ${custody.custodyNumber}` : `رفض عهدة ${custody.custodyNumber}`,
      actionEn: approved ? `Approved ${custody.custodyNumber}` : `Rejected ${custody.custodyNumber}`,
      entityType: 'Custody',
      entityId: custody._id,
      details: { reason },
    });

    return custody;
  }

  async settleCustody(custodyId, userId, approved = true, reason = '', invoiceIds = null) {
    const custody = await Custody.findById(custodyId)
      .populate('project')
      .populate('holder', 'name nameEn');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (custody.status !== CUSTODY_STATUS.PM_APPROVED && custody.status !== CUSTODY_STATUS.FINANCE_PENDING) {
      const hasPendingFinance = await Invoice.exists({
        custody: custodyId,
        status: INVOICE_STATUS.PENDING_FINANCE,
      });
      if (!(custody.status === CUSTODY_STATUS.SETTLED && hasPendingFinance)) {
        throw Object.assign(new Error('Custody not ready for settlement'), { status: 400 });
      }
    }

    const invoices = await Invoice.find({
      custody: custodyId,
      status: { $in: [INVOICE_STATUS.PENDING_FINANCE, INVOICE_STATUS.FINANCE_APPROVED] },
    });

    const idFilter = invoiceIds?.length ? new Set(invoiceIds.map(String)) : null;

    if (approved) {
      let toAccrue = invoices.filter((i) => i.status === INVOICE_STATUS.PENDING_FINANCE);
      if (idFilter) {
        toAccrue = toAccrue.filter((i) => idFilter.has(String(i._id)));
      }
      if (!toAccrue.length) {
        throw Object.assign(new Error('No approved invoices to settle'), { status: 400 });
      }

      const { lines: batchLines, total } = buildAccrualEntry(toAccrue, custody.holder.name);
      const settlementCount = await Custody.countDocuments({ status: CUSTODY_STATUS.SETTLED });

      if (!custody.settlementNumber) {
        custody.settlementNumber = `STL-${440 + settlementCount}`;
      }
      custody.accrualEntry = appendAccrualEntry(custody.accrualEntry, toAccrue, custody.holder.name);

      await Invoice.updateMany(
        { _id: { $in: toAccrue.map((i) => i._id) }, status: INVOICE_STATUS.PENDING_FINANCE },
        { status: INVOICE_STATUS.FINANCE_APPROVED }
      );

      await recordCustodyTransaction({
        custodyId: custody._id,
        type: 'adjustment',
        amount: total,
        description: `قيد استحقاق — ${custody.custodyNumber}${toAccrue.length === 1 ? ` · ${toAccrue[0].referenceNumber}` : ` · ${toAccrue.length} فواتير`}`,
        descriptionEn: `Accrual entry — ${custody.custodyNumber}${toAccrue.length === 1 ? ` · ${toAccrue[0].referenceNumber}` : ` · ${toAccrue.length} invoice(s)`}`,
        referenceType: 'Custody',
        referenceId: custody._id,
        createdBy: userId,
        journalLines: batchLines,
      });

      const stillPendingFinance = await Invoice.exists({
        custody: custodyId,
        status: INVOICE_STATUS.PENDING_FINANCE,
      });
      if (!stillPendingFinance) {
        custody.status = CUSTODY_STATUS.FINANCE_PENDING;
        custody.settledAt = custody.settledAt || new Date();
        custody.settledBy = custody.settledBy || userId;

        const admins = await User.find({ role: ROLES.ADMIN, isActive: true }).select('_id').lean();
        const approvedTotal = await Invoice.aggregate([
          { $match: { custody: custody._id, status: INVOICE_STATUS.FINANCE_APPROVED } },
          { $group: { _id: null, total: { $sum: '$total' } } },
        ]);
        const notifyAmount = approvedTotal[0]?.total || total;
        await Promise.all(
          admins.map((a) =>
            createNotification({
              userId: a._id,
              title: 'عهدة بانتظار الصرف',
              titleEn: 'Custody pending disbursement',
              message: `${custody.custodyNumber} — ${notifyAmount} ريال`,
              messageEn: `${custody.custodyNumber} — ${notifyAmount} SAR`,
              type: 'info',
              link: '/dashboard/admin/vouchers',
            })
          )
        );
      }
    } else {
      let toReject = invoices.filter((i) => i.status === INVOICE_STATUS.PENDING_FINANCE);
      if (idFilter) {
        toReject = toReject.filter((i) => idFilter.has(String(i._id)));
      }
      if (!toReject.length) {
        throw Object.assign(new Error('No invoices selected for rejection'), { status: 400 });
      }

      await Invoice.updateMany(
        { _id: { $in: toReject.map((i) => i._id) }, status: INVOICE_STATUS.PENDING_FINANCE },
        {
          status: INVOICE_STATUS.FINANCE_REJECTED,
          rejectionReason: reason,
        }
      );

      const stillPendingFinance = await Invoice.exists({
        custody: custodyId,
        status: INVOICE_STATUS.PENDING_FINANCE,
      });
      const stillFinanceApproved = await Invoice.exists({
        custody: custodyId,
        status: INVOICE_STATUS.FINANCE_APPROVED,
      });

      if (!stillPendingFinance && !stillFinanceApproved) {
        custody.status = CUSTODY_STATUS.FINANCE_REJECTED;
        custody.financeRejectionReason = reason;
      }

      await createNotification({
        userId: custody.holder._id,
        title: 'رفض المالية للعهدة',
        titleEn: 'Finance rejected custody',
        message: reason,
        messageEn: reason,
        type: 'reject',
      });
    }

    await custody.save();
    await logActivity({
      userId,
      action: approved ? `تسوية عهدة ${custody.custodyNumber}` : `رفض مالي ${custody.custodyNumber}`,
      actionEn: approved ? `Settled ${custody.custodyNumber}` : `Finance rejected ${custody.custodyNumber}`,
      entityType: 'Custody',
      entityId: custody._id,
    });

    return custody;
  }

  async confirmDisbursement(custodyId, userId, { amount } = {}) {
    const custody = await Custody.findById(custodyId)
      .populate('holder', 'name nameEn');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (custody.status !== CUSTODY_STATUS.FINANCE_PENDING) {
      throw Object.assign(new Error('Custody not ready for disbursement confirmation'), { status: 400 });
    }

    const approvedInvoices = await Invoice.find({
      custody: custodyId,
      status: INVOICE_STATUS.FINANCE_APPROVED,
    });
    const defaultAmount = approvedInvoices.reduce((s, i) => s + (i.total || 0), 0);
    const disburseAmount = amount != null ? Number(amount) : defaultAmount;

    if (!disburseAmount || disburseAmount <= 0) {
      throw Object.assign(new Error('Disbursement amount must be positive'), { status: 400 });
    }

    custody.disbursementAmount = disburseAmount;
    custody.disbursementConfirmedAt = new Date();
    custody.disbursementConfirmedBy = userId;
    await custody.save();

    await logActivity({
      userId,
      action: `تأكيد مبلغ صرف ${custody.custodyNumber}`,
      actionEn: `Confirmed disbursement amount ${custody.custodyNumber}`,
      entityType: 'Custody',
      entityId: custody._id,
      details: { amount: disburseAmount },
    });

    return custody;
  }

  async disburseCustody(custodyId, userId, { proofUrl, amount, method = 'bank_transfer', bankReference } = {}) {
    const custody = await Custody.findById(custodyId)
      .populate('project')
      .populate('holder', 'name nameEn');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (custody.status !== CUSTODY_STATUS.FINANCE_PENDING) {
      throw Object.assign(new Error('Custody not ready for disbursement'), { status: 400 });
    }
    if (!proofUrl) {
      throw Object.assign(new Error('Payment proof is required'), { status: 400 });
    }

    const invoices = await Invoice.find({
      custody: custodyId,
      status: INVOICE_STATUS.FINANCE_APPROVED,
    });
    const defaultAmount = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const total = amount != null ? Number(amount) : custody.disbursementAmount || defaultAmount;

    if (!total || total <= 0) {
      throw Object.assign(new Error('Disbursement amount must be positive'), { status: 400 });
    }

    custody.disbursementAmount = total;
    custody.disbursementConfirmedAt = new Date();
    custody.disbursementConfirmedBy = userId;
    custody.status = CUSTODY_STATUS.SETTLED;
    custody.settledAt = new Date();
    custody.settledBy = userId;
    const batchDisbursementLines = buildDisbursementEntry(total, custody.holder.name);
    const batchAccrualLines = custody.accrualEntry?.length
      ? custody.accrualEntry
      : buildAccrualEntry(invoices, custody.holder.name).lines;
    custody.disbursementEntry = appendDisbursementEntry(custody.disbursementEntry, total, custody.holder.name);
    custody.disbursementProof = proofUrl;
    custody.disbursedAt = new Date();
    custody.disbursedBy = userId;

    await Invoice.updateMany(
      { _id: { $in: invoices.map((i) => i._id) }, status: INVOICE_STATUS.FINANCE_APPROVED },
      { status: INVOICE_STATUS.SETTLED }
    );

    const project = await Project.findById(custody.project);
    if (project) {
      project.spent += total;
      if (project.budget && project.spent > project.budget) {
        project.status = 'over_budget';
      } else if (project.budget && project.spent / project.budget >= 0.9) {
        project.status = 'near_budget';
      }
      await project.save();
    }

    await Voucher.create({
      voucherNumber: await nextVoucherNumber(),
      beneficiary: custody.holder._id,
      project: custody.project._id,
      amount: total,
      method,
      bankReference,
      proofUrl,
      createdBy: userId,
      custody: custody._id,
      invoiceIds: invoices.map((i) => i._id),
      accrualEntry: batchAccrualLines,
      disbursementEntry: batchDisbursementLines,
    });

    await recordCustodyTransaction({
      custodyId: custody._id,
      type: 'disbursement',
      amount: total,
      description: `قيد صرف — ${custody.custodyNumber}`,
      descriptionEn: `Disbursement — ${custody.custodyNumber}`,
      referenceType: 'Custody',
      referenceId: custody._id,
      proofUrl,
      createdBy: userId,
      journalLines: batchDisbursementLines,
    });

    await createNotification({
      userId: custody.holder._id,
      title: 'تم صرف العهدة',
      titleEn: 'Custody disbursed',
      message: `${custody.custodyNumber} — ${total} ريال`,
      messageEn: `${custody.custodyNumber} — ${total} SAR`,
      type: 'success',
      link: '/dashboard/project-manager/custody',
    });

    await custody.save();
    await logActivity({
      userId,
      action: `صرف عهدة ${custody.custodyNumber}`,
      actionEn: `Disbursed custody ${custody.custodyNumber}`,
      entityType: 'Custody',
      entityId: custody._id,
    });

    return custody;
  }

  async topUpCustody(custodyId, userId, { amount, proofUrl, description } = {}) {
    const custody = await Custody.findById(custodyId).populate('holder');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (!amount || amount <= 0) {
      throw Object.assign(new Error('Amount must be positive'), { status: 400 });
    }

    custody.amount = (custody.amount || 0) + amount;
    await custody.save();

    await recordCustodyTransaction({
      custodyId: custody._id,
      type: 'top_up',
      amount,
      description: description || `شحن رصيد — ${custody.custodyNumber}`,
      descriptionEn: `Top-up — ${custody.custodyNumber}`,
      referenceType: 'Custody',
      referenceId: custody._id,
      proofUrl,
      createdBy: userId,
    });

    if (custody.holder) {
      await createNotification({
        userId: custody.holder._id,
        title: 'شحن رصيد العهدة',
        titleEn: 'Custody balance topped up',
        message: `${custody.custodyNumber} +${amount} ريال`,
        messageEn: `${custody.custodyNumber} +${amount} SAR`,
        type: 'success',
        link: `/dashboard/project-manager/custody/${custody._id}`,
      });
    }

    await logActivity({
      userId,
      action: `شحن عهدة ${custody.custodyNumber}`,
      actionEn: `Topped up ${custody.custodyNumber}`,
      entityType: 'Custody',
      entityId: custody._id,
    });

    return custody;
  }

  async syncCustodyAfterInvoiceReviews(custodyId, userId) {
    await repairCustodiesWithPendingInvoices();
    await promotePaApprovedInvoicesToFinance();
    await repairCustodiesAwaitingFinance();
    await repairCustodiesAwaitingDisbursement();
    await repairSettledCustodyStatus();

    const custody = await Custody.findById(custodyId).populate('holder');
    if (!custody) return;

    const syncableStatuses = [
      CUSTODY_STATUS.CLOSED,
      CUSTODY_STATUS.OPEN,
      CUSTODY_STATUS.PM_REJECTED,
      CUSTODY_STATUS.FINANCE_REJECTED,
      CUSTODY_STATUS.SETTLED,
      CUSTODY_STATUS.PM_APPROVED,
    ];
    if (!syncableStatuses.includes(custody.status)) return;

    const invoices = await Invoice.find({ custody: custodyId });
    const stillPendingPa = invoices.some((i) => i.status === INVOICE_STATUS.ACCUMULATED);
    const stillPendingPm = invoices.some((i) => i.status === INVOICE_STATUS.PENDING_PM);

    const pmApproved = invoices.filter((i) => i.status === INVOICE_STATUS.PM_APPROVED);
    if (pmApproved.length) {
      await Invoice.updateMany(
        { _id: { $in: pmApproved.map((i) => i._id) } },
        { $set: { status: INVOICE_STATUS.PENDING_FINANCE } },
      );
    }

    const refreshed = await Invoice.find({ custody: custodyId });
    const pendingFinance = refreshed.filter((i) => i.status === INVOICE_STATUS.PENDING_FINANCE);
    const priorBatchComplete = refreshed.some((i) =>
      [
        INVOICE_STATUS.SETTLED,
        INVOICE_STATUS.FINANCE_APPROVED,
      ].includes(i.status)
    );

    if (pendingFinance.length && !stillPendingPm && !stillPendingPa) {
      const batchJustApproved = pmApproved.length ? pmApproved : pendingFinance;
      custody.status = CUSTODY_STATUS.PM_APPROVED;
      custody.pmApprovedAt = new Date();
      custody.pmApprovedBy = userId;
      custody.pmRejectionReason = undefined;
      custody.approvedSpent = sumInvoices(refreshed, FINANCE_ELIGIBLE_STATUSES);

      const approvedTotal = batchJustApproved.reduce((s, i) => s + (i.total || 0), 0);

      if (custody.holder && !stillPendingPm && !stillPendingPa) {
        await createNotification({
          userId: custody.holder._id,
          title: 'اعتماد العهدة من مدير المشاريع',
          titleEn: 'Custody approved by project manager',
          message: `تم اعتماد عهدة ${custody.custodyNumber} — ${pendingFinance.length} فاتورة (${approvedTotal} ريال) بانتظار المالية`,
          messageEn: `Custody ${custody.custodyNumber} — ${pendingFinance.length} invoice(s) (${approvedTotal} SAR) pending finance`,
          type: 'success',
          link: '/dashboard/project-manager/custody',
        });
      }

      if (!stillPendingPm && !stillPendingPa) {
        const accountants = await User.find({ role: ROLES.CHIEF_ACCOUNTANT, isActive: true });
        await Promise.all(
          accountants.map((a) =>
            createNotification({
              userId: a._id,
              title: 'فواتير معتمدة — بانتظار المالية',
              titleEn: 'Approved invoices — pending finance',
              message: `${custody.custodyNumber} — ${pendingFinance.length} فاتورة (${approvedTotal} ريال)`,
              messageEn: `${custody.custodyNumber} — ${pendingFinance.length} invoice(s) (${approvedTotal} SAR)`,
              type: 'info',
              link: '/dashboard/finance/entries',
            })
          )
        );
      }
    } else if (stillPendingPm || stillPendingPa) {
      const financeApproved = refreshed.filter((i) => i.status === INVOICE_STATUS.FINANCE_APPROVED);
      const settledInvoices = refreshed.filter((i) => i.status === INVOICE_STATUS.SETTLED);
      if (financeApproved.length) {
        custody.status = CUSTODY_STATUS.FINANCE_PENDING;
      } else if (custody.settledAt || custody.disbursementProof || settledInvoices.length) {
        custody.status = CUSTODY_STATUS.SETTLED;
      } else {
        custody.status = CUSTODY_STATUS.CLOSED;
        custody.closedAt = custody.closedAt || new Date();
      }
    } else if (!priorBatchComplete) {
      custody.status = CUSTODY_STATUS.PM_REJECTED;
      custody.pmRejectionReason = custody.pmRejectionReason || 'رفض جميع الفواتير';
    } else if (
      custody.status === CUSTODY_STATUS.CLOSED
      && refreshed.some((i) => i.status === INVOICE_STATUS.SETTLED)
    ) {
      custody.status = CUSTODY_STATUS.SETTLED;
    }

    const postSyncInvoices = await Invoice.find({ custody: custodyId });
    if (postSyncInvoices.some((i) => i.status === INVOICE_STATUS.FINANCE_APPROVED)) {
      custody.status = CUSTODY_STATUS.FINANCE_PENDING;
    }

    await custody.save();
    await recalcCustodyTotals(custodyId);
  }

  async pmReviewInvoice(invoiceId, userId, approved = true, reason = '') {
    const invoice = await Invoice.findById(invoiceId).populate('uploadedBy project');
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    if (invoice.status !== INVOICE_STATUS.ACCUMULATED) {
      throw Object.assign(new Error('Invoice is not pending PA review'), { status: 400 });
    }

    const approver = await User.findById(userId).select('role').lean();
    if (!approver || approver.role !== ROLES.PROJECT_ACCOUNTANT) {
      throw Object.assign(new Error('Not authorized to review invoice'), { status: 403 });
    }

    if (approved) {
      invoice.status = INVOICE_STATUS.PENDING_PM;
      invoice.rejectionReason = undefined;
      invoice.rejectedBy = undefined;
      invoice.approvedBy = userId;
      invoice.approvedAt = new Date();

      const custody = await Custody.findById(invoice.custody).populate('holder');
      if (custody?.holder?._id) {
        await createNotification({
          userId: custody.holder._id,
          title: 'فاتورة بانتظار اعتمادك',
          titleEn: 'Invoice awaiting your approval',
          message: `${invoice.referenceNumber} — بانتظار مراجعة مدير المشاريع`,
          messageEn: `${invoice.referenceNumber} — awaiting project manager review`,
          type: 'info',
          link: '/dashboard/project-manager/approvals',
        });
      }
    } else {
      if (!reason?.trim()) {
        throw Object.assign(new Error('Rejection reason is required'), { status: 400 });
      }
      invoice.status = INVOICE_STATUS.PM_REJECTED;
      invoice.rejectionReason = reason;
      invoice.rejectedBy = userId;

      await createNotification({
        userId: invoice.uploadedBy._id,
        title: 'رفض فاتورة من محاسب العهدة',
        titleEn: 'Invoice rejected by custody accountant',
        message: `${invoice.referenceNumber}: ${reason}`,
        messageEn: `${invoice.referenceNumber}: ${reason}`,
        type: 'reject',
        link: '/dashboard/project-manager/rejected',
      });
    }

    await invoice.save();

    if (invoice.custody) {
      await recalcCustodyTotals(invoice.custody);
      await this.syncCustodyAfterInvoiceReviews(invoice.custody, userId);
    }

    await logActivity({
      userId,
      action: approved ? `اعتماد فاتورة ${invoice.referenceNumber} (محاسب العهدة)` : `رفض فاتورة ${invoice.referenceNumber}`,
      actionEn: approved ? `PA approved invoice ${invoice.referenceNumber}` : `Rejected invoice ${invoice.referenceNumber}`,
      entityType: 'Invoice',
      entityId: invoice._id,
      details: { reason },
    });

    return invoice;
  }

  async pmApproveInvoice(invoiceId, userId, approved = true, reason = '') {
    const invoice = await Invoice.findById(invoiceId).populate('uploadedBy project');
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    if (invoice.status !== INVOICE_STATUS.PENDING_PM) {
      throw Object.assign(new Error('Invoice is not pending PM approval'), { status: 400 });
    }

    const approver = await User.findById(userId).select('role').lean();
    if (!approver || approver.role !== ROLES.PROJECT_MANAGER) {
      throw Object.assign(new Error('Not authorized to approve invoice'), { status: 403 });
    }

    const custody = await Custody.findById(invoice.custody);
    if (!custody || String(custody.holder) !== String(userId)) {
      throw Object.assign(new Error('Not your custody invoice'), { status: 403 });
    }

    if (approved) {
      invoice.status = INVOICE_STATUS.PENDING_FINANCE;
      invoice.rejectionReason = undefined;
      invoice.rejectedBy = undefined;
      invoice.approvedBy = userId;
      invoice.approvedAt = new Date();
    } else {
      if (!reason?.trim()) {
        throw Object.assign(new Error('Rejection reason is required'), { status: 400 });
      }
      invoice.status = INVOICE_STATUS.PM_REJECTED;
      invoice.rejectionReason = reason;
      invoice.rejectedBy = userId;

      await createNotification({
        userId: invoice.uploadedBy._id,
        title: 'رفض فاتورة',
        titleEn: 'Invoice rejected',
        message: `${invoice.referenceNumber}: ${reason}`,
        messageEn: `${invoice.referenceNumber}: ${reason}`,
        type: 'reject',
        link: '/dashboard/project-manager/rejected',
      });
    }

    await invoice.save();

    if (invoice.custody) {
      await recalcCustodyTotals(invoice.custody);
      await this.syncCustodyAfterInvoiceReviews(invoice.custody, userId);
    }

    await logActivity({
      userId,
      action: approved ? `اعتماد فاتورة ${invoice.referenceNumber} (مدير المشاريع)` : `رفض فاتورة ${invoice.referenceNumber}`,
      actionEn: approved ? `PM approved invoice ${invoice.referenceNumber}` : `PM rejected invoice ${invoice.referenceNumber}`,
      entityType: 'Invoice',
      entityId: invoice._id,
      details: { reason },
    });

    return invoice;
  }

  async approveInvoice(invoiceId, userId, approved = true, reason = '') {
    const invoice = await Invoice.findById(invoiceId).populate('uploadedBy project');
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    if (invoice.status !== INVOICE_STATUS.PENDING_FINANCE) {
      throw Object.assign(new Error('Invoice is not pending finance review'), { status: 400 });
    }

    if (approved) {
      invoice.status = INVOICE_STATUS.FINANCE_APPROVED;
      invoice.rejectionReason = undefined;
    } else {
      if (!reason?.trim()) {
        throw Object.assign(new Error('Rejection reason is required'), { status: 400 });
      }
      invoice.status = INVOICE_STATUS.FINANCE_REJECTED;
      invoice.rejectionReason = reason;
      invoice.rejectedBy = userId;

      await createNotification({
        userId: invoice.uploadedBy._id,
        title: 'رفض فاتورة من المالية',
        titleEn: 'Invoice rejected by finance',
        message: `${invoice.referenceNumber}: ${reason}`,
        messageEn: `${invoice.referenceNumber}: ${reason}`,
        type: 'reject',
        link: '/dashboard/project-manager/rejected',
      });
    }

    await invoice.save();

    if (invoice.custody) {
      await recalcCustodyTotals(invoice.custody);
    }

    await logActivity({
      userId,
      action: approved ? `اعتماد مالي ${invoice.referenceNumber}` : `رفض مالي ${invoice.referenceNumber}`,
      actionEn: approved ? `Finance approved ${invoice.referenceNumber}` : `Finance rejected ${invoice.referenceNumber}`,
      entityType: 'Invoice',
      entityId: invoice._id,
      details: { reason },
    });

    return invoice;
  }
}

export default new CustodyWorkflowService();
