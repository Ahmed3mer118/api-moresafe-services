import Invoice, { nextInvoiceReference } from '../models/Invoice.js';
import Custody from '../models/Custody.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import { CUSTODY_STATUS, INVOICE_STATUS, ROLES, PM_UPLOAD_CUSTODY_STATUSES } from '../constants/roles.js';
import custodyWorkflow from '../services/custodyWorkflowService.js';
import { createNotification, logActivity } from '../services/notificationService.js';
import { storeBase64Payload, storeMulterFile } from '../services/attachmentStorage.js';
import { recordCustodyTransaction } from '../services/custodyTransactionService.js';

async function resolvePmUploadCustody(custodyId, userId) {
  const custody = await Custody.findById(custodyId);
  if (!custody) {
    return { error: 'Custody not found', status: 404 };
  }
  if (String(custody.holder) !== String(userId)) {
    return { error: 'Custody not assigned to you', status: 403 };
  }
  if (!PM_UPLOAD_CUSTODY_STATUSES.includes(custody.status)) {
    return {
      error: 'Custody is not available for new invoices at this stage',
      status: 400,
    };
  }
  return { custody };
}

async function notifyInvoicePendingApproval(project, invoice) {
  let accountantIds = project.accountants?.length ? [...project.accountants] : [];
  if (!accountantIds.length) {
    const accountants = await User.find({ role: ROLES.PROJECT_ACCOUNTANT, isActive: true }).select('_id').lean();
    accountantIds = accountants.map((u) => u._id);
  }

  await Promise.all(
    accountantIds.map((accountantId) =>
      createNotification({
        userId: accountantId,
        title: 'فاتورة جديدة بانتظار اعتمادك',
        titleEn: 'New invoice awaiting approval',
        message: `${invoice.referenceNumber} — ${project.name}`,
        messageEn: `${invoice.referenceNumber} — ${project.nameEn || project.name}`,
        type: 'info',
        link: '/dashboard/project-accountant/approvals',
      })
    )
  );
}

function parseLineItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistUploadFiles(files) {
  if (!files?.length) return [];
  const attachments = [];
  for (const file of files) {
    const stored = await storeMulterFile(file);
    if (stored) attachments.push(stored);
  }
  return attachments;
}

async function persistBase64Attachments(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const attachments = [];
  for (const att of list) {
    const stored = await storeBase64Payload(att);
    if (stored) attachments.push(stored);
  }
  return attachments;
}

function parseInvoiceBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return {
    projectId: body.projectId || body.project,
    custodyId: body.custodyId,
    invoiceNumber: body.invoiceNumber,
    supplier: body.supplier,
    category: body.category,
    subtotal: body.subtotal,
    vatAmount: body.vatAmount,
    total: body.total,
    taxNumber: body.taxNumber,
    invoiceDate: body.invoiceDate,
    ocrData: body.ocrData,
    lineItems: parseLineItems(body.lineItems),
    attachments: body.attachments,
  };
}

const ARCHIVED_INVOICE_STATUSES = [
  INVOICE_STATUS.PM_APPROVED,
  INVOICE_STATUS.PM_REJECTED,
  INVOICE_STATUS.PENDING_FINANCE,
  INVOICE_STATUS.FINANCE_APPROVED,
  INVOICE_STATUS.FINANCE_REJECTED,
  INVOICE_STATUS.SETTLED,
];

export async function listInvoices(req, res, next) {
  try {
    const { status, projectId, custodyId, archived, managerId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (projectId) filter.project = projectId;
    if (custodyId) filter.custody = custodyId;
    if (managerId) filter.uploadedBy = managerId;
    if (req.query.supplier) filter.supplier = String(req.query.supplier);

    if (req.query.archived === 'true') {
      filter.status = { $in: ARCHIVED_INVOICE_STATUSES };
    }

    if (req.user.role === ROLES.PROJECT_MANAGER) {
      filter.uploadedBy = req.user._id;
    }

    const invoices = await Invoice.find(filter)
      .populate({
        path: 'project',
        select: 'name nameEn manager',
        populate: { path: 'manager', select: 'name nameEn' },
      })
      .populate('uploadedBy', 'name nameEn')
      .populate('custody', 'custodyNumber status')
      .select('referenceNumber invoiceNumber project uploadedBy custody supplier category lineItems subtotal vatAmount total taxNumber status invoiceDate attachments attachmentUrl rejectionReason createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json(invoices);
  } catch (err) {
    next(err);
  }
}

export async function getInvoice(req, res, next) {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate({
        path: 'project',
        populate: { path: 'manager', select: 'name nameEn email' },
      })
      .populate('uploadedBy', 'name nameEn email')
      .populate('custody');
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.json(invoice);
  } catch (err) {
    next(err);
  }
}

export async function createInvoice(req, res, next) {
  try {
    const {
      projectId,
      custodyId,
      invoiceNumber,
      supplier,
      category,
      subtotal,
      vatAmount,
      total,
      taxNumber,
      invoiceDate,
      ocrData,
      lineItems,
      attachments: attachmentsPayload,
    } = parseInvoiceBody(req);

    if (!projectId) {
      return res.status(400).json({ message: 'projectId is required' });
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (req.user.role === ROLES.PROJECT_MANAGER) {
      if (String(project.manager) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Project not assigned to you' });
      }
      if (!custodyId) {
        return res.status(400).json({ message: 'custodyId is required — upload invoices inside an open custody' });
      }
    }

    let custody = null;
    if (custodyId) {
      if (req.user.role === ROLES.PROJECT_MANAGER) {
        const resolved = await resolvePmUploadCustody(custodyId, req.user._id);
        if (resolved.error) {
          return res.status(resolved.status).json({ message: resolved.error });
        }
        custody = resolved.custody;
      } else {
        custody = await Custody.findOne({ _id: custodyId, status: CUSTODY_STATUS.OPEN });
        if (!custody) {
          return res.status(400).json({ message: 'Open custody not found' });
        }
      }
      if (String(custody.project) !== String(projectId)) {
        return res.status(400).json({ message: 'Project does not match custody' });
      }
    }

    const lineTotal = lineItems.reduce((s, i) => s + (Number(i.total) || 0), 0);
    const parsedSubtotal = Number(subtotal) || lineTotal || 0;
    const parsedVat = Number(vatAmount) || 0;
    const computedTotal = Number(total) || parsedSubtotal + parsedVat || lineTotal;

    let attachments = await persistUploadFiles(req.files);
    if (!attachments.length && attachmentsPayload) {
      attachments = await persistBase64Attachments(attachmentsPayload);
    }

    const invoice = await Invoice.create({
      referenceNumber: await nextInvoiceReference(),
      invoiceNumber: invoiceNumber || `INV-${Date.now()}`,
      project: projectId,
      custody: custody?._id,
      uploadedBy: req.user._id,
      supplier,
      category,
      lineItems,
      subtotal: parsedSubtotal,
      vatAmount: parsedVat,
      total: computedTotal,
      taxNumber,
      taxVerified: Boolean(taxNumber),
      invoiceDate: invoiceDate ? new Date(invoiceDate) : new Date(),
      status: custody ? INVOICE_STATUS.ACCUMULATED : INVOICE_STATUS.PENDING_PM,
      ocrData: ocrData ? (typeof ocrData === 'string' ? JSON.parse(ocrData) : ocrData) : undefined,
      attachments,
      attachmentUrl: attachments[0]?.url,
    });

    if (custody) {
      custody.invoices.push(invoice._id);
      custody.spent = (custody.spent || 0) + computedTotal;
      await custody.save();

      await recordCustodyTransaction({
        custodyId: custody._id,
        type: 'spend',
        amount: computedTotal,
        description: `فاتورة ${invoice.referenceNumber}`,
        descriptionEn: `Invoice ${invoice.referenceNumber}`,
        referenceType: 'Invoice',
        referenceId: invoice._id,
        createdBy: req.user._id,
      });
    }

    if (!custody) {
      await notifyInvoicePendingApproval(project, invoice);
    }

    await logActivity({
      userId: req.user._id,
      action: `رفع فاتورة ${invoice.referenceNumber}`,
      actionEn: `Uploaded invoice ${invoice.referenceNumber}`,
      entityType: 'Invoice',
      entityId: invoice._id,
    });

    const populated = await Invoice.findById(invoice._id)
      .populate('project', 'name nameEn')
      .populate('custody', 'custodyNumber');

    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function pmReviewInvoice(req, res, next) {
  try {
    const { approved, reason } = req.body;
    const invoice = await custodyWorkflow.pmReviewInvoice(
      req.params.id,
      req.user._id,
      approved !== false,
      reason
    );
    res.json(invoice);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function batchPmReviewInvoices(req, res, next) {
  try {
    const { invoiceIds, approved, reason } = req.body;
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) {
      return res.status(400).json({ message: 'invoiceIds is required' });
    }
    if (approved === false && !reason?.trim()) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    const results = [];
    const errors = [];
    for (const id of invoiceIds) {
      try {
        const invoice = await custodyWorkflow.pmReviewInvoice(
          id,
          req.user._id,
          approved !== false,
          reason
        );
        results.push(invoice);
      } catch (err) {
        errors.push({ id, message: err.message });
      }
    }

    if (!results.length) {
      return res.status(400).json({ message: errors[0]?.message || 'No invoices reviewed' });
    }

    res.json({ count: results.length, invoices: results, errors });
  } catch (err) {
    next(err);
  }
}

export async function batchReviewInvoices(req, res, next) {
  try {
    const { invoiceIds, approved, reason } = req.body;
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) {
      return res.status(400).json({ message: 'invoiceIds is required' });
    }
    if (approved === false && !reason?.trim()) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    const results = [];
    const errors = [];
    for (const id of invoiceIds) {
      try {
        const invoice = await custodyWorkflow.approveInvoice(
          id,
          req.user._id,
          approved !== false,
          reason
        );
        results.push(invoice);
      } catch (err) {
        errors.push({ id, message: err.message });
      }
    }

    if (!results.length) {
      return res.status(400).json({ message: errors[0]?.message || 'No invoices reviewed' });
    }

    res.json({ count: results.length, invoices: results, errors });
  } catch (err) {
    next(err);
  }
}

export async function reviewInvoice(req, res, next) {
  try {
    const { approved, reason } = req.body;
    const invoice = await custodyWorkflow.approveInvoice(req.params.id, req.user._id, approved !== false, reason);
    res.json(invoice);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function pendingFinanceInvoices(req, res, next) {
  try {
    const invoices = await Invoice.find({
      status: INVOICE_STATUS.PENDING_FINANCE,
    })
      .populate({
        path: 'project',
        select: 'name nameEn manager',
        populate: { path: 'manager', select: 'name nameEn' },
      })
      .populate('uploadedBy', 'name nameEn')
      .select('referenceNumber invoiceNumber project uploadedBy supplier category lineItems subtotal vatAmount total taxNumber status invoiceDate attachments attachmentUrl rejectionReason createdAt')
      .sort({ createdAt: -1 });
    res.json(invoices);
  } catch (err) {
    next(err);
  }
}

export async function rejectedInvoices(req, res, next) {
  try {
    const filter = {
      uploadedBy: req.user._id,
      status: { $in: [INVOICE_STATUS.PM_REJECTED, INVOICE_STATUS.FINANCE_REJECTED] },
    };
    const invoices = await Invoice.find(filter).populate('project', 'name nameEn').lean();
    res.json(invoices);
  } catch (err) {
    next(err);
  }
}

export async function updateInvoice(req, res, next) {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, uploadedBy: req.user._id }).populate('project');
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const wasRejected = [INVOICE_STATUS.PM_REJECTED, INVOICE_STATUS.FINANCE_REJECTED].includes(invoice.status);

    Object.assign(invoice, req.body);

    if (wasRejected || invoice.status.includes('rejected')) {
      invoice.status = INVOICE_STATUS.PENDING_PM;
      invoice.rejectionReason = undefined;
      invoice.rejectedBy = undefined;
    }

    await invoice.save();

    if (wasRejected) {
      const project = invoice.project?._id ? invoice.project : await Project.findById(invoice.project);
      if (project) await notifyInvoicePendingApproval(project, invoice);
    }

    res.json(invoice);
  } catch (err) {
    next(err);
  }
}
