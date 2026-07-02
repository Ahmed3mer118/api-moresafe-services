import { CUSTODY_STATUS, INVOICE_STATUS, ROLES } from '../constants/roles.js';
import Custody from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import Voucher, { nextVoucherNumber } from '../models/Voucher.js';
import { createNotification, logActivity } from './notificationService.js';

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
  async closeCustody(custodyId, userId) {
    const custody = await Custody.findById(custodyId).populate('project');
    if (!custody) throw Object.assign(new Error('Custody not found'), { status: 404 });
    if (custody.status !== CUSTODY_STATUS.OPEN) {
      throw Object.assign(new Error('Custody is not open'), { status: 400 });
    }
    if (String(custody.holder) !== String(userId)) {
      throw Object.assign(new Error('Not your custody'), { status: 403 });
    }

    const invoices = await Invoice.find({
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
    if (!invoices.length) {
      throw Object.assign(new Error('Add at least one invoice before closing'), { status: 400 });
    }

    custody.status = CUSTODY_STATUS.CLOSED;
    custody.closedAt = new Date();
    custody.spent = invoices.reduce((s, i) => s + i.total, 0);
    await custody.save();

    await Invoice.updateMany(
      { custody: custodyId, status: INVOICE_STATUS.ACCUMULATED },
      { status: INVOICE_STATUS.PENDING_PM }
    );

    const project = await Project.findById(custody.project).populate('manager');
    if (project?.accountants?.length) {
      await Promise.all(
        project.accountants.map((accountantId) =>
          createNotification({
            userId: accountantId,
            title: 'عهدة مغلقة بانتظار اعتمادك',
            titleEn: 'Closed custody awaiting approval',
            message: `عهدة ${custody.custodyNumber} — ${project.name}`,
            messageEn: `Custody ${custody.custodyNumber} — ${project.nameEn || project.name}`,
            type: 'info',
            link: '/dashboard/project-accountant/approvals',
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
      await Invoice.updateMany({ custody: custodyId }, { status: INVOICE_STATUS.PENDING_FINANCE });

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

    const invoices = await Invoice.find({ custody: custodyId });

    if (approved) {
      const { lines, total } = buildAccrualEntry(invoices, custody.holder.name);
      const settlementCount = await Custody.countDocuments({ status: CUSTODY_STATUS.SETTLED });

      custody.status = CUSTODY_STATUS.SETTLED;
      custody.settledAt = new Date();
      custody.settledBy = userId;
      custody.settlementNumber = `STL-${440 + settlementCount}`;
      custody.accrualEntry = lines;
      custody.disbursementEntry = buildDisbursementEntry(total, custody.holder.name);

      await Invoice.updateMany({ custody: custodyId }, { status: INVOICE_STATUS.SETTLED });

      const project = await Project.findById(custody.project);
      if (project) {
        project.spent += total;
        if (project.spent / project.budget >= 0.9) project.status = 'near_budget';
        await project.save();
      }

      await Voucher.create({
        voucherNumber: await nextVoucherNumber(),
        beneficiary: custody.holder._id,
        project: custody.project._id,
        amount: total,
        method: 'bank_transfer',
        createdBy: userId,
        custody: custody._id,
      });
    } else {
      custody.status = CUSTODY_STATUS.FINANCE_REJECTED;
      custody.financeRejectionReason = reason;
      await Invoice.updateMany({ custody: custodyId }, {
        status: INVOICE_STATUS.FINANCE_REJECTED,
        rejectionReason: reason,
      });

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

  async syncCustodyAfterInvoiceReviews(custodyId, userId) {
    const custody = await Custody.findById(custodyId).populate('holder');
    if (!custody || custody.status !== CUSTODY_STATUS.CLOSED) return;

    const invoices = await Invoice.find({ custody: custodyId });
    const stillPending = invoices.some((i) => i.status === INVOICE_STATUS.PENDING_PM);
    if (stillPending) return;

    const hasApproved = invoices.some((i) => i.status === INVOICE_STATUS.PENDING_FINANCE);
    if (hasApproved) {
      custody.status = CUSTODY_STATUS.PM_APPROVED;
      custody.pmApprovedAt = new Date();
      custody.pmApprovedBy = userId;

      const accountants = await User.find({ role: ROLES.CHIEF_ACCOUNTANT, isActive: true });
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
      custody.pmRejectionReason = custody.pmRejectionReason || 'رفض جميع الفواتير';
    }

    await custody.save();
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
      invoice.status = INVOICE_STATUS.PENDING_FINANCE;
      invoice.rejectionReason = undefined;

      const financeUsers = await User.find({ role: ROLES.CHIEF_ACCOUNTANT, isActive: true }).select('_id').lean();
      await Promise.all(
        financeUsers.map((a) =>
          createNotification({
            userId: a._id,
            title: 'فاتورة معتمدة — بانتظار المالية',
            titleEn: 'Approved invoice — pending finance',
            message: `${invoice.referenceNumber} جاهزة للمراجعة`,
            messageEn: `${invoice.referenceNumber} ready for review`,
            type: 'info',
            link: '/dashboard/finance/review',
          })
        )
      );
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
