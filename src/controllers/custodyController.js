import Custody, { nextCustodyNumber } from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Project from '../models/Project.js';
import mongoose from 'mongoose';
import { CUSTODY_STATUS, INVOICE_STATUS, ROLES } from '../constants/roles.js';
import custodyWorkflow from '../services/custodyWorkflowService.js';
import { recordCustodyTransaction } from '../services/custodyTransactionService.js';
import { storeBase64Payload, storeMulterFile } from '../services/attachmentStorage.js';
import { createNotification } from '../services/notificationService.js';
import { resolvePaProjectIds, countPaQueueCustodies } from '../utils/paProjectAccess.js';

async function resolveProofAttachment(req) {
  if (req.file) {
    const stored = await storeMulterFile(req.file);
    return stored?.url || null;
  }
  const proof = req.body?.proof || req.body?.proofAttachment;
  if (proof) {
    const stored = await storeBase64Payload(proof);
    return stored?.url || null;
  }
  return req.body?.proofUrl || null;
}

export async function listCustodies(req, res, next) {
  try {
    const { status, projectId, holderId } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (projectId) filter.project = projectId;
    if (holderId) filter.holder = holderId;

    const { role, _id } = req.user;
    if (role === ROLES.PROJECT_MANAGER) {
      filter.holder = _id;
    } else if (role === ROLES.CHIEF_ACCOUNTANT && !status) {
      filter.status = {
        $in: [CUSTODY_STATUS.PM_APPROVED, CUSTODY_STATUS.FINANCE_PENDING, CUSTODY_STATUS.SETTLED, CUSTODY_STATUS.FINANCE_REJECTED],
      };
    } else if (role === ROLES.ADMIN && !status) {
      // Admin sees all custodies when no filter
    } else if (role === ROLES.PROJECT_ACCOUNTANT) {
      const assignedIds = await resolvePaProjectIds(_id, req.user.projects);
      if (!assignedIds.length) return res.json([]);

      const pendingPmCustodyIds = await Invoice.distinct('custody', {
        status: INVOICE_STATUS.PENDING_PM,
        project: { $in: assignedIds },
        custody: { $exists: true, $ne: null },
      });

      const paQueueOr = [
        { status: CUSTODY_STATUS.CLOSED },
        ...(pendingPmCustodyIds.length ? [{ _id: { $in: pendingPmCustodyIds } }] : []),
      ];

      if (projectId) {
        if (!assignedIds.some((id) => String(id) === String(projectId))) return res.json([]);
        filter.project = projectId;
      } else {
        filter.project = { $in: assignedIds };
      }

      if (status) {
        filter.$and = [{ status }, { $or: paQueueOr }];
        delete filter.status;
      } else {
        filter.$or = paQueueOr;
      }
    }

    const custodies = await Custody.find(filter)
      .populate('project', 'name nameEn budget spent manager')
      .populate('holder', 'name nameEn email')
      .populate('pmApprovedBy', 'name nameEn email')
      .populate({
        path: 'invoices',
        select: 'referenceNumber invoiceNumber supplier category total subtotal vatAmount status invoiceDate attachments attachmentUrl lineItems',
        populate: { path: 'uploadedBy', select: 'name nameEn email' },
      })
      .sort({ updatedAt: -1 })
      .lean({ virtuals: true });

    res.json(custodies);
  } catch (err) {
    next(err);
  }
}

export async function getCustody(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Custody not found' });
    }
    const custody = await Custody.findById(req.params.id)
      .populate('project')
      .populate('holder', 'name nameEn email')
      .populate('pmApprovedBy', 'name nameEn email')
      .populate({ path: 'invoices', populate: { path: 'uploadedBy', select: 'name' } })
      .lean({ virtuals: true });
    if (!custody) return res.status(404).json({ message: 'Custody not found' });
    res.json(custody);
  } catch (err) {
    next(err);
  }
}

export async function createCustody(req, res, next) {
  try {
    const { projectId, amount, type, purpose } = req.body;
    const proofUrl = await resolveProofAttachment(req);

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const holderId =
      req.user.role === ROLES.ADMIN
        ? req.body.holderId || project.manager
        : req.user.role === ROLES.PROJECT_ACCOUNTANT && type === 'emergency'
          ? req.body.holderId || req.user._id
          : req.user._id;

    if (req.user.role === ROLES.ADMIN && !holderId) {
      return res.status(400).json({ message: 'Project manager (holderId) is required' });
    }

    if (req.user.role === ROLES.PROJECT_ACCOUNTANT && type !== 'emergency') {
      return res.status(403).json({ message: 'Project accountants can only create emergency custody requests' });
    }

    if (req.user.role !== ROLES.ADMIN) {
      const openExists = await Custody.findOne({
        holder: holderId,
        project: projectId,
        status: CUSTODY_STATUS.OPEN,
      }).select('_id').lean();
      if (openExists && req.user.role !== ROLES.PROJECT_ACCOUNTANT) {
        return res.status(400).json({ message: 'You already have an open custody for this project' });
      }
    }

    const custody = await Custody.create({
      custodyNumber: await nextCustodyNumber(),
      project: projectId,
      holder: holderId,
      amount: amount || 0,
      type: type || 'operational',
      purpose,
      status: CUSTODY_STATUS.OPEN,
    });

    if (amount > 0) {
      await recordCustodyTransaction({
        custodyId: custody._id,
        type: 'allocation',
        amount,
        description: `تخصيص عهدة — ${custody.custodyNumber}`,
        descriptionEn: `Custody allocation — ${custody.custodyNumber}`,
        referenceType: 'Custody',
        referenceId: custody._id,
        proofUrl,
        createdBy: req.user._id,
      });
    }

    const populated = await Custody.findById(custody._id)
      .populate('project', 'name nameEn')
      .populate('holder', 'name nameEn email')
      .lean({ virtuals: true });

    if (req.user.role === ROLES.ADMIN && holderId) {
      await createNotification({
        userId: holderId,
        title: 'عهدة جديدة',
        titleEn: 'New custody assigned',
        message: `${custody.custodyNumber} — ${project.name} (${amount || 0} ريال)`,
        messageEn: `${custody.custodyNumber} — ${project.nameEn || project.name}`,
        type: 'success',
        link: `/dashboard/project-manager/custody/${custody._id}`,
      });
    }

    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function closeCustody(req, res, next) {
  try {
    const { invoiceIds } = req.body || {};
    const custody = await custodyWorkflow.closeCustody(req.params.id, req.user._id, invoiceIds);
    const populated = await Custody.findById(custody._id)
      .populate('project', 'name nameEn')
      .populate('holder', 'name nameEn email')
      .populate({
        path: 'invoices',
        select: 'referenceNumber supplier total status invoiceDate',
      })
      .lean({ virtuals: true });
    res.json(populated);
  } catch (err) {
    next(err.status ? err : Object.assign(err, { status: 500 }));
  }
}

export async function approveCustodyPM(req, res, next) {
  try {
    const { approved, reason } = req.body;
    const custody = await custodyWorkflow.approveByPM(req.params.id, req.user._id, approved !== false, reason);
    res.json(custody);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function settleCustody(req, res, next) {
  try {
    const { approved, reason } = req.body;
    const custody = await custodyWorkflow.settleCustody(req.params.id, req.user._id, approved !== false, reason);
    res.json(custody);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function disburseCustody(req, res, next) {
  try {
    const proofUrl = await resolveProofAttachment(req);
    const { amount, method, bankReference } = req.body;
    const custody = await custodyWorkflow.disburseCustody(req.params.id, req.user._id, {
      proofUrl,
      amount: amount != null && amount !== '' ? Number(amount) : undefined,
      method,
      bankReference,
    });
    res.json(custody);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function confirmDisbursement(req, res, next) {
  try {
    const { amount } = req.body;
    const custody = await custodyWorkflow.confirmDisbursement(req.params.id, req.user._id, {
      amount: amount != null ? Number(amount) : undefined,
    });
    res.json(custody);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function topUpCustody(req, res, next) {
  try {
    const proofUrl = await resolveProofAttachment(req);
    const { amount, description } = req.body;
    const custody = await custodyWorkflow.topUpCustody(req.params.id, req.user._id, {
      amount: Number(amount),
      proofUrl,
      description,
    });
    res.json(custody);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

export async function listCustodyTransactions(req, res, next) {
  try {
    const { listCustodyTransactions } = await import('../services/custodyTransactionService.js');
    const rows = await listCustodyTransactions(req.params.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

export async function listMyTransactions(req, res, next) {
  try {
    const CustodyTransaction = (await import('../models/CustodyTransaction.js')).default;

    const filter = { holder: req.user._id };
    const custodies = await Custody.find(filter).select('_id custodyNumber').lean();
    const ids = custodies.map((c) => c._id);
    if (!ids.length) return res.json([]);

    const numberById = new Map(custodies.map((c) => [String(c._id), c.custodyNumber]));

    const rows = await CustodyTransaction.find({ custody: { $in: ids } })
      .populate('createdBy', 'name nameEn')
      .sort({ createdAt: -1 })
      .lean();

    res.json(
      rows.map((row) => ({
        ...row,
        custodyNumber: numberById.get(String(row.custody)) || '',
      }))
    );
  } catch (err) {
    next(err);
  }
}

export async function listDisbursementQueue(req, res, next) {
  try {
    const filter = {
      $or: [
        { status: CUSTODY_STATUS.FINANCE_PENDING },
        { status: CUSTODY_STATUS.OPEN, $expr: { $gt: ['$spent', '$amount'] } },
      ],
    };

    const custodies = await Custody.find(filter)
      .populate('project', 'name nameEn')
      .populate('holder', 'name nameEn email')
      .populate({
        path: 'invoices',
        select: 'referenceNumber supplier total status invoiceDate',
      })
      .sort({ updatedAt: -1 })
      .lean({ virtuals: true });

    res.json(custodies);
  } catch (err) {
    next(err);
  }
}

export async function listAdminTransactions(req, res, next) {
  try {
    const CustodyTransaction = (await import('../models/CustodyTransaction.js')).default;
    const rows = await CustodyTransaction.find({})
      .populate('createdBy', 'name nameEn')
      .populate({ path: 'custody', select: 'custodyNumber project holder', populate: [{ path: 'project', select: 'name nameEn' }, { path: 'holder', select: 'name nameEn' }] })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    res.json(
      rows.map((row) => ({
        ...row,
        custodyNumber: row.custody?.custodyNumber || '',
        project: row.custody?.project,
        holder: row.custody?.holder,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateCustody(req, res, next) {
  try {
    const custody = await Custody.findById(req.params.id);
    if (!custody) return res.status(404).json({ message: 'Custody not found' });
    if (custody.status !== CUSTODY_STATUS.OPEN) {
      return res.status(400).json({ message: 'Only open custodies can be edited' });
    }

    const { amount, purpose, holderId, type, projectId } = req.body;

    if (amount != null) {
      const nextAmount = Number(amount);
      if (Number.isNaN(nextAmount) || nextAmount < (custody.spent || 0)) {
        return res.status(400).json({ message: 'Amount must be at least equal to spent total' });
      }
      custody.amount = nextAmount;
    }

    if (purpose != null) custody.purpose = purpose;
    if (type != null) custody.type = type;

    if (projectId && String(projectId) !== String(custody.project)) {
      const newProject = await Project.findById(projectId);
      if (!newProject) return res.status(404).json({ message: 'Project not found' });
      custody.project = projectId;
      if (!holderId && newProject.manager) {
        custody.holder = newProject.manager;
      }
    }

    if (holderId && String(holderId) !== String(custody.holder)) {
      custody.holder = holderId;
    }

    await custody.save();

    const populated = await Custody.findById(custody._id)
      .populate('project', 'name nameEn budget spent manager')
      .populate('holder', 'name nameEn email')
      .populate({
        path: 'invoices',
        select: 'referenceNumber invoiceNumber supplier category total subtotal vatAmount status invoiceDate attachments attachmentUrl lineItems',
        populate: { path: 'uploadedBy', select: 'name nameEn email' },
      })
      .lean({ virtuals: true });

    res.json(populated);
  } catch (err) {
    next(err);
  }
}

export async function getOpenCustody(req, res, next) {
  try {
    const custody = await Custody.findOne({
      holder: req.user._id,
      status: CUSTODY_STATUS.OPEN,
    })
      .populate('project', 'name nameEn')
      .populate('invoices')
      .lean({ virtuals: true });

    res.json(custody);
  } catch (err) {
    next(err);
  }
}

export async function cycleStats(req, res, next) {
  try {
    const [pipeline, closedCustodyIds, pendingPmCustodyIds, pmApprovedIds, pendingFinanceCustodyIds] =
      await Promise.all([
        Custody.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Custody.distinct('_id', { status: CUSTODY_STATUS.CLOSED }),
        Invoice.distinct('custody', {
          status: INVOICE_STATUS.PENDING_PM,
          custody: { $exists: true, $ne: null },
        }),
        Custody.distinct('_id', { status: CUSTODY_STATUS.PM_APPROVED }),
        Invoice.distinct('custody', {
          status: INVOICE_STATUS.PENDING_FINANCE,
          custody: { $exists: true, $ne: null },
        }),
      ]);

    const stages = {
      pm: 0,
      pa: 0,
      chief: 0,
      disbursement: 0,
      settled: 0,
    };

    for (const row of pipeline) {
      if (row._id === CUSTODY_STATUS.OPEN) stages.pm += row.count;
      else if (row._id === CUSTODY_STATUS.FINANCE_PENDING) stages.disbursement += row.count;
      else if (row._id === CUSTODY_STATUS.SETTLED) stages.settled += row.count;
    }

    stages.pa = new Set([
      ...closedCustodyIds.map(String),
      ...pendingPmCustodyIds.map(String),
    ]).size;

    stages.chief = new Set([
      ...pmApprovedIds.map(String),
      ...pendingFinanceCustodyIds.map(String),
    ]).size;

    res.json(stages);
  } catch (err) {
    next(err);
  }
}
