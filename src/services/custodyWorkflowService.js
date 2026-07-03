import { CUSTODY_STATUS, INVOICE_STATUS, ROLES, PM_SUBMIT_CUSTODY_STATUSES } from '../constants/roles.js';
import Custody from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import Voucher, { nextVoucherNumber } from '../models/Voucher.js';
import { createNotification, logActivity } from './notificationService.js';
import { recordCustodyTransaction } from './custodyTransactionService.js';

function buildAccrualEntry(invoices, holderName) {
  const lines = [];
  let total = 0;

  for (const inv of invoices) {
    total += inv.total;
    lines.push({
      accountCode: '12011',
      accountName: `Purchases - ${inv.category || 'Materials'}`,
      debit: inv.total,
      credit: 0,
    });
  }

  lines.push({
    accountCode: '23041',
    accountName: `Engineer custody - ${holderName}`,
    debit: 0,
    credit: total,
  });

  return { lines, total };
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

function buildDisbursementEntry(total, holderName) {
  return [
    {
      accountCode: '23041',
      accountName: `Engineer custody - ${holderName}`,
      debit: total,
      credit: 0,
    },
    {
      accountCode: '11010',
      accountName: 'Bank',
      debit: 0,
      credit: total,
    },
  ];
}

export class CustodyWorkflowService {
  async closeCustody(custodyId, userId, invoiceIds = []) {
    const custody = await Custody.findById(custodyId).populate('project');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (!PM_SUBMIT_CUSTODY_STATUSES.includes(custody.status)) {
      throw Object.assign(new Error('Custody is not open for submission'), { status: 400 });
    }
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

    await Invoice.updateMany(
      { _id: { $in: selectedIds } },
      { status: INVOICE_STATUS.PENDING_PM }
    );

    const remainingAccumulated = await Invoice.countDocuments({
      custody: custodyId,
      status: INVOICE_STATUS.ACCUMULATED,
    });

    if (remainingAccumulated) {
      custody.status = CUSTODY_STATUS.OPEN;
    } else if (custody.status === CUSTODY_STATUS.OPEN) {
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
            INVOICE_STATUS.PENDING_PM,
            INVOICE_STATUS.PM_APPROVED,
            INVOICE_STATUS.PENDING_FINANCE,
            INVOICE_STATUS.FINANCE_APPROVED,
            INVOICE_STATUS.SETTLED,
          ],
        },
      }),
      [
        INVOICE_STATUS.PENDING_PM,
        INVOICE_STATUS.PM_APPROVED,
        INVOICE_STATUS.PENDING_FINANCE,
        INVOICE_STATUS.FINANCE_APPROVED,
        INVOICE_STATUS.SETTLED,
      ]
    );
    await custody.save();

    const project = await Project.findById(custody.project).populate('manager');
    if (project?.accountants?.length) {
      await Promise.all(
        project.accountants.map((accountantId) =>
          createNotification({
            userId: accountantId,
            title: 'فواتير عهدة بانتظار المراجعة',
            titleEn: 'Custody invoices awaiting review',
            message: `عهدة ${custody.custodyNumber} — ${project.name} (${selectedTotal} ريال)`,
            messageEn: `Custody ${custody.custodyNumber} — ${project.nameEn || project.name}`,
            type: 'info',
            link: '/dashboard/project-accountant/approvals',
          })
        )
      );
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
      custody.status = CUSTODY_STATUS.PM_APPROVED;
      custody.pmApprovedAt = new Date();
      custody.pmApprovedBy = userId;
      await Invoice.updateMany(
        { custody: custodyId, status: INVOICE_STATUS.PENDING_PM },
        { status: INVOICE_STATUS.PENDING_FINANCE }
      );

      const accountants = await User.find({ role: ROLES.CHIEF_ACCOUNTANT, isActive: true }).select('_id').lean();
      await Promise.all(
        accountants.map((a) =>
          createNotification({
            userId: a._id,
            title: 'عهدة معتمدة — بانتظار التسوية',
            titleEn: 'Approved custody — pending settlement',
            message: `${custody.custodyNumber} جاهزة للمالية`,
            messageEn: `${custody.custodyNumber} ready for finance`,
            type: 'info',
            link: '/dashboard/finance/entries',
          })
        )
      );
    } else {
      custody.status = CUSTODY_STATUS.PM_REJECTED;
      custody.pmRejectionReason = reason;
      await Invoice.updateMany({ custody: custodyId }, {
        status: INVOICE_STATUS.PM_REJECTED,
        rejectionReason: reason,
        rejectedBy: userId,
      });

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

  async settleCustody(custodyId, userId, approved = true, reason = '') {
    const custody = await Custody.findById(custodyId)
      .populate('project')
      .populate('holder', 'name nameEn');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (custody.status !== CUSTODY_STATUS.PM_APPROVED) {
      throw Object.assign(new Error('Custody not ready for settlement'), { status: 400 });
    }

    const invoices = await Invoice.find({
      custody: custodyId,
      status: { $in: [INVOICE_STATUS.PENDING_FINANCE, INVOICE_STATUS.FINANCE_APPROVED] },
    });

    if (approved) {
      const toSettle = invoices.filter(
        (i) => i.status === INVOICE_STATUS.PENDING_FINANCE || i.status === INVOICE_STATUS.FINANCE_APPROVED
      );
      if (!toSettle.length) {
        throw Object.assign(new Error('No approved invoices to settle'), { status: 400 });
      }
      const { lines, total } = buildAccrualEntry(toSettle, custody.holder.name);
      const settlementCount = await Custody.countDocuments({ status: CUSTODY_STATUS.SETTLED });

      custody.status = CUSTODY_STATUS.FINANCE_PENDING;
      custody.settlementNumber = `STL-${440 + settlementCount}`;
      custody.accrualEntry = lines;
      custody.disbursementEntry = undefined;
      custody.disbursementAmount = undefined;
      custody.disbursementConfirmedAt = undefined;
      custody.disbursementConfirmedBy = undefined;

      await Invoice.updateMany(
        { custody: custodyId, status: INVOICE_STATUS.PENDING_FINANCE },
        { status: INVOICE_STATUS.FINANCE_APPROVED }
      );

      await recordCustodyTransaction({
        custodyId: custody._id,
        type: 'adjustment',
        amount: total,
        description: `قيد استحقاق — ${custody.custodyNumber}`,
        descriptionEn: `Accrual entry — ${custody.custodyNumber}`,
        referenceType: 'Custody',
        referenceId: custody._id,
        createdBy: userId,
      });

      const admins = await User.find({ role: ROLES.ADMIN, isActive: true }).select('_id').lean();
      await Promise.all(
        admins.map((a) =>
          createNotification({
            userId: a._id,
            title: 'عهدة بانتظار الصرف',
            titleEn: 'Custody pending disbursement',
            message: `${custody.custodyNumber} — ${total} ريال`,
            messageEn: `${custody.custodyNumber} — ${total} SAR`,
            type: 'info',
            link: '/dashboard/admin/disbursement',
          })
        )
      );
    } else {
      custody.status = CUSTODY_STATUS.FINANCE_REJECTED;
      custody.financeRejectionReason = reason;
      await Invoice.updateMany(
        { custody: custodyId, status: INVOICE_STATUS.PENDING_FINANCE },
        {
          status: INVOICE_STATUS.FINANCE_REJECTED,
          rejectionReason: reason,
        }
      );

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
    custody.disbursementEntry = buildDisbursementEntry(total, custody.holder.name);
    custody.disbursementProof = proofUrl;
    custody.disbursedAt = new Date();
    custody.disbursedBy = userId;

    await Invoice.updateMany(
      { custody: custodyId, status: INVOICE_STATUS.FINANCE_APPROVED },
      { status: INVOICE_STATUS.SETTLED }
    );

    const project = await Project.findById(custody.project);
    if (project) {
      project.spent += total;
      if (project.budget && project.spent / project.budget >= 0.9) project.status = 'near_budget';
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
    const custody = await Custody.findById(custodyId).populate('holder');
    if (!custody || custody.status !== CUSTODY_STATUS.CLOSED) return;

    const invoices = await Invoice.find({ custody: custodyId });
    const stillPending = invoices.some((i) => i.status === INVOICE_STATUS.PENDING_PM);
    if (stillPending) return;

    const pmApproved = invoices.filter((i) => i.status === INVOICE_STATUS.PM_APPROVED);
    if (pmApproved.length) {
      await Invoice.updateMany(
        { custody: custodyId, status: INVOICE_STATUS.PM_APPROVED },
        { status: INVOICE_STATUS.PENDING_FINANCE }
      );

      const refreshed = await Invoice.find({ custody: custodyId });
      custody.status = CUSTODY_STATUS.PM_APPROVED;
      custody.pmApprovedAt = new Date();
      custody.pmApprovedBy = userId;
      custody.approvedSpent = sumInvoices(refreshed, FINANCE_ELIGIBLE_STATUSES);

      const approvedTotal = pmApproved.reduce((s, i) => s + (i.total || 0), 0);
      const approver = await User.findById(userId).select('name nameEn').lean();
      const approverName = approver?.name || approver?.nameEn || 'محاسب العهد';

      if (custody.holder) {
        await createNotification({
          userId: custody.holder._id,
          title: 'اعتماد العهدة من محاسب العهد',
          titleEn: 'Custody approved by custody accountant',
          message: `تم اعتماد عهدة ${custody.custodyNumber} بواسطة ${approverName} — ${pmApproved.length} فاتورة (${approvedTotal} ريال)`,
          messageEn: `Custody ${custody.custodyNumber} approved by ${approverName} — ${pmApproved.length} invoice(s) (${approvedTotal} SAR)`,
          type: 'success',
          link: '/dashboard/project-manager/custody',
        });
      }

      const accountants = await User.find({ role: ROLES.CHIEF_ACCOUNTANT, isActive: true });
      await Promise.all(
        accountants.map((a) =>
          createNotification({
            userId: a._id,
            title: 'عهدة معتمدة — بانتظار المالية',
            titleEn: 'Approved custody — pending finance',
            message: `${custody.custodyNumber} — ${pmApproved.length} فاتورة (${approvedTotal} ريال)`,
            messageEn: `${custody.custodyNumber} — ${pmApproved.length} invoice(s) (${approvedTotal} SAR)`,
            type: 'info',
            link: '/dashboard/finance/review',
          })
        )
      );
    } else {
      custody.status = CUSTODY_STATUS.PM_REJECTED;
      custody.pmRejectionReason = custody.pmRejectionReason || 'رفض جميع الفواتير';
    }

    await custody.save();
    await recalcCustodyTotals(custodyId);
  }

  async pmReviewInvoice(invoiceId, userId, approved = true, reason = '') {
    const invoice = await Invoice.findById(invoiceId).populate('uploadedBy project');
    if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    if (invoice.status !== INVOICE_STATUS.PENDING_PM) {
      throw Object.assign(new Error('Invoice is not pending approval'), { status: 400 });
    }

    const approver = await User.findById(userId).select('role').lean();
    if (!approver || approver.role !== ROLES.PROJECT_ACCOUNTANT) {
      throw Object.assign(new Error('Not authorized to review invoice'), { status: 403 });
    }

    if (approved) {
      invoice.status = INVOICE_STATUS.PM_APPROVED;
      invoice.rejectionReason = undefined;
      invoice.rejectedBy = undefined;
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
      action: approved ? `اعتماد فاتورة ${invoice.referenceNumber}` : `رفض فاتورة ${invoice.referenceNumber}`,
      actionEn: approved ? `Approved invoice ${invoice.referenceNumber}` : `Rejected invoice ${invoice.referenceNumber}`,
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
