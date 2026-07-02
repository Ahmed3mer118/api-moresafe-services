import Custody, { nextCustodyNumber } from '../models/Custody.js';
import Invoice from '../models/Invoice.js';
import Project from '../models/Project.js';
import { CUSTODY_STATUS, INVOICE_STATUS, ROLES } from '../constants/roles.js';
import custodyWorkflow from '../services/custodyWorkflowService.js';

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
      filter.status = { $in: [CUSTODY_STATUS.PM_APPROVED, CUSTODY_STATUS.SETTLED, CUSTODY_STATUS.FINANCE_REJECTED] };
    }

    const custodies = await Custody.find(filter)
      .populate('project', 'name nameEn budget spent manager')
      .populate('holder', 'name nameEn email')
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
    const custody = await Custody.findById(req.params.id)
      .populate('project')
      .populate('holder', 'name nameEn email')
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

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const holderId =
      req.user.role === ROLES.PROJECT_ACCOUNTANT && type === 'emergency'
        ? req.body.holderId || req.user._id
        : req.user._id;

    if (req.user.role === ROLES.PROJECT_ACCOUNTANT && type !== 'emergency') {
      return res.status(403).json({ message: 'Project accountants can only create emergency custody requests' });
    }

    const openExists = await Custody.findOne({
      holder: holderId,
      project: projectId,
      status: CUSTODY_STATUS.OPEN,
    }).select('_id').lean();
    if (openExists && req.user.role !== ROLES.PROJECT_ACCOUNTANT) {
      return res.status(400).json({ message: 'You already have an open custody for this project' });
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

    const populated = await Custody.findById(custody._id)
      .populate('project', 'name nameEn')
      .lean({ virtuals: true });
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function closeCustody(req, res, next) {
  try {
    const custody = await custodyWorkflow.closeCustody(req.params.id, req.user._id);
    res.json(custody);
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
    const pipeline = await Custody.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const stages = {
      engineer: 0,
      pm: 0,
      finance: 0,
      settled: 0,
    };

    for (const row of pipeline) {
      if (row._id === CUSTODY_STATUS.OPEN) stages.engineer += row.count;
      else if (row._id === CUSTODY_STATUS.CLOSED) stages.pm += row.count;
      else if (row._id === CUSTODY_STATUS.PM_APPROVED) stages.finance += row.count;
      else if (row._id === CUSTODY_STATUS.SETTLED) stages.settled += row.count;
    }

    res.json(stages);
  } catch (err) {
    next(err);
  }
}
