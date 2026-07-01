import Project from '../models/Project.js';
import User from '../models/User.js';
import Custody from '../models/Custody.js';
import { logActivity } from '../services/notificationService.js';
import { ROLES } from '../constants/roles.js';

export async function listProjects(req, res, next) {
  try {
    const filter = {};
    const { role, _id } = req.user;

    // Only field project managers see their assigned projects; project accountants see all
    if (role === ROLES.PROJECT_MANAGER) filter.manager = _id;

    const projects = await Project.find(filter)
      .populate('manager', 'name nameEn email')
      .populate('accountants', 'name nameEn email')
      .sort({ createdAt: -1 });

    res.json(projects);
  } catch (err) {
    next(err);
  }
}

export async function getProject(req, res, next) {
  try {
    const project = await Project.findById(req.params.id)
      .populate('manager accountants engineers', 'name nameEn email role');
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
      .populate('accountants', 'name nameEn email');

    res.json(populated);
  } catch (err) {
    next(err);
  }
}

export async function projectBudgetSummary(req, res, next) {
  try {
    const projects = await Project.find().select('name nameEn budget spent status');
    res.json(projects);
  } catch (err) {
    next(err);
  }
}
