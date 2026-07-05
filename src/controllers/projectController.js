import Project from '../models/Project.js';
import User from '../models/User.js';
import Custody from '../models/Custody.js';
import { logActivity } from '../services/notificationService.js';
import { ROLES } from '../constants/roles.js';
import { resolvePaProjectIds } from '../utils/paProjectAccess.js';
import { parseListQuery, paginateMongooseQuery, emptyPaginated, applySearchToFilter } from '../utils/listQuery.js';

export async function listProjects(req, res, next) {
  try {
    const { page, limit, skip, search, sort } = parseListQuery(req.query, {
      allowedSortFields: ['createdAt', 'name', 'budget', 'spent'],
    });
    let filter = {};
    const { role, _id } = req.user;

    if (role === ROLES.PROJECT_MANAGER) {
      const custodyProjectIds = await Custody.distinct('project', { holder: _id });
      const or = [{ manager: _id }];
      if (custodyProjectIds.length) {
        or.push({ _id: { $in: custodyProjectIds } });
      }
      filter.$or = or;
    } else if (role === ROLES.PROJECT_ACCOUNTANT) {
      const assignedIds = await resolvePaProjectIds(_id, req.user.projects);
      if (!assignedIds.length) return res.json(emptyPaginated(page, limit));
      filter._id = { $in: assignedIds };
    }

    filter = applySearchToFilter(filter, search, ['name', 'nameEn', 'code']);

    const baseQuery = Project.find(filter)
      .populate('manager', 'name nameEn email')
      .populate('accountants', 'name nameEn email')
      .sort(sort);

    const result = await paginateMongooseQuery(baseQuery, { page, limit, skip });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getProject(req, res, next) {
  try {
    const project = await Project.findById(req.params.id)
      .populate('manager accountants engineers', 'name nameEn email role')
      .lean({ virtuals: true });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (req.user.role === ROLES.PROJECT_MANAGER) {
      if (String(project.manager) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Project not assigned to you' });
      }
    }

    res.json(project);
  } catch (err) {
    next(err);
  }
}

export async function createProject(req, res, next) {
  try {
    const { name, nameEn, code, description, budget, manager, accountants, startDate, endDate } = req.body;

    const project = await Project.create({
      name,
      nameEn,
      code,
      description,
      budget: budget || 0,
      manager,
      accountants: accountants || [],
      startDate,
      endDate,
      status: 'new',
    });

    if (manager) {
      await User.findByIdAndUpdate(manager, { $addToSet: { projects: project._id } });
    }
    if (accountants?.length) {
      await User.updateMany({ _id: { $in: accountants } }, { $addToSet: { projects: project._id } });
    }

    await logActivity({
      userId: req.user._id,
      action: `إنشاء مشروع: ${name}`,
      actionEn: `Created project: ${name}`,
      entityType: 'Project',
      entityId: project._id,
    });

    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
}

export async function updateProject(req, res, next) {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const { name, nameEn, code, description, budget, status, manager, accountants, startDate, endDate } = req.body;

    if (name !== undefined) project.name = name;
    if (nameEn !== undefined) project.nameEn = nameEn;
    if (code !== undefined) project.code = code;
    if (description !== undefined) project.description = description;
    if (budget !== undefined) project.budget = budget;
    if (status !== undefined) project.status = status;
    if (startDate !== undefined) project.startDate = startDate;
    if (endDate !== undefined) project.endDate = endDate;
    if (manager !== undefined) project.manager = manager || null;
    if (accountants !== undefined) project.accountants = accountants || [];

    await project.save();

    if (manager) {
      await User.findByIdAndUpdate(manager, { $addToSet: { projects: project._id } });
    }
    if (accountants?.length) {
      await User.updateMany({ _id: { $in: accountants } }, { $addToSet: { projects: project._id } });
    }

    await logActivity({
      userId: req.user._id,
      action: `تعديل مشروع: ${project.name}`,
      actionEn: `Updated project: ${project.name}`,
      entityType: 'Project',
      entityId: project._id,
    });

    const populated = await Project.findById(project._id)
      .populate('manager', 'name nameEn email')
      .populate('accountants', 'name nameEn email')
      .lean({ virtuals: true });

    res.json(populated);
  } catch (err) {
    next(err);
  }
}

export async function projectBudgetSummary(req, res, next) {
  try {
    const filter = {};
    const { role, _id } = req.user;

    if (role === ROLES.PROJECT_MANAGER) {
      const custodyProjectIds = await Custody.distinct('project', { holder: _id });
      const or = [{ manager: _id }];
      if (custodyProjectIds.length) {
        or.push({ _id: { $in: custodyProjectIds } });
      }
      filter.$or = or;
    } else if (role === ROLES.PROJECT_ACCOUNTANT) {
      const assignedIds = await resolvePaProjectIds(_id, req.user.projects);
      if (!assignedIds.length) {
        return res.json({
          projects: [],
          totals: { projectCount: 0, budget: 0, spent: 0, remaining: 0, overCount: 0, nearCount: 0 },
        });
      }
      filter._id = { $in: assignedIds };
    }

    const projects = await Project.find(filter)
      .select('name nameEn budget spent status manager')
      .populate('manager', 'name nameEn')
      .sort({ spent: -1 })
      .lean({ virtuals: true })
      .then((rows) =>
        rows.map((p) => ({
          ...p,
          status: p.budget > 0 && p.spent > p.budget ? 'over_budget' : p.status,
        })),
      );

    let totalBudget = 0;
    let totalSpent = 0;
    let overCount = 0;
    let nearCount = 0;

    for (const p of projects) {
      const budget = p.budget || 0;
      const spent = p.spent || 0;
      totalBudget += budget;
      totalSpent += spent;
      if (budget > 0) {
        const ratio = spent / budget;
        if (ratio > 1) overCount += 1;
        else if (ratio >= 0.9) nearCount += 1;
      }
    }

    res.json({
      projects,
      totals: {
        projectCount: projects.length,
        budget: totalBudget,
        spent: totalSpent,
        remaining: Math.max(0, totalBudget - totalSpent),
        overCount,
        nearCount,
      },
    });
  } catch (err) {
    next(err);
  }
}
