import Project from '../models/Project.js';

import User from '../models/User.js';

import Custody from '../models/Custody.js';

import { ROLES } from '../constants/roles.js';

import { logActivity, createNotification } from '../services/notificationService.js';

import { hashPassword } from '../utils/password.js';

import { escapeRegex } from '../utils/escapeRegex.js';

import { toSafeUserJSON } from '../utils/safeJson.js';



function normalizeUserProject(p) {

  if (!p || typeof p !== 'object') return null;

  const id = String(p.id || p._id || '');

  if (!id) return null;

  return {

    id,

    _id: id,

    name: p.name || '',

    nameEn: p.nameEn,

    status: p.status || 'active',

  };

}



function indexRoleProjects(roleProjects) {

  const byUserId = new Map();

  for (const p of roleProjects) {

    const normalized = normalizeUserProject(p);

    if (!normalized) continue;



    const linkedIds = new Set([

      p.manager ? String(p.manager) : '',

      ...(p.accountants || []).map((a) => String(a)),

    ].filter(Boolean));



    for (const uid of linkedIds) {

      if (!byUserId.has(uid)) byUserId.set(uid, []);

      const bucket = byUserId.get(uid);

      if (!bucket.some((item) => item.id === normalized.id)) {

        bucket.push(normalized);

      }

    }

  }

  return byUserId;

}



export async function listUsers(req, res, next) {

  try {

    const { role, search, projectId } = req.query;

    const filter = {};

    if (role) filter.role = role;

    if (search) {

      const safe = escapeRegex(search.trim());

      filter.$or = [

        { name: new RegExp(safe, 'i') },

        { email: new RegExp(safe, 'i') },

      ];

    }



    if (req.user.role === ROLES.PROJECT_ACCOUNTANT) {
      const assignedProjects = await Project.find({ accountants: req.user._id }).select('manager _id').lean();

      if (projectId) {
        const project = assignedProjects.find((p) => String(p._id) === String(projectId));
        if (!project) return res.status(404).json({ message: 'Project not found' });

        const holderIds = await Custody.distinct('holder', { project: projectId });
        const ids = [
          ...new Set([project.manager, ...holderIds].filter(Boolean).map((id) => String(id))),
        ];
        filter._id = { $in: ids.length ? ids : ['000000000000000000000000'] };
      } else if (role === ROLES.PROJECT_MANAGER) {
        const managerIds = [...new Set(assignedProjects.map((p) => String(p.manager)).filter(Boolean))];
        filter._id = { $in: managerIds.length ? managerIds : ['000000000000000000000000'] };
      }
    }



    const users = await User.find(filter)

      .select('-password')

      .populate('projects', 'name nameEn status')

      .sort({ createdAt: -1 })

      .lean();



    const userIds = users.map((u) => u._id);

    const roleProjects = userIds.length

      ? await Project.find({

        $or: [{ manager: { $in: userIds } }, { accountants: { $in: userIds } }],

      })

        .select('name nameEn status manager accountants')

        .lean()

      : [];



    const extraByUser = indexRoleProjects(roleProjects);



    res.json(

      users.map((u) => toSafeUserJSON(u, extraByUser.get(String(u._id)) || [])),

    );

  } catch (err) {

    next(err);

  }

}



export async function createUser(req, res, next) {

  try {

    const { name, nameEn, email, password, role, phone, projects, language } = req.body;



    const exists = await User.findOne({ email: email.toLowerCase() }).select('_id').lean();

    if (exists) return res.status(400).json({ message: 'Email already exists' });



    const user = await User.create({

      name,

      nameEn,

      email,

      password: await hashPassword(password),

      role,

      phone,

      projects,

      language,

    });



    await Promise.all([

      logActivity({

        userId: req.user._id,

        action: `إضافة مستخدم: ${name}`,

        actionEn: `Added user: ${name}`,

        entityType: 'User',

        entityId: user._id,

      }),

      createNotification({

        userId: req.user._id,

        title: 'تم إضافة مستخدم',

        titleEn: 'User added',

        message: `تم إنشاء حساب ${name} (${email})`,

        messageEn: `Account created for ${name}`,

        type: 'success',

      }),

    ]);



    res.status(201).json(user.toSafeJSON());

  } catch (err) {

    next(err);

  }

}



export async function updateUser(req, res, next) {

  try {

    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: 'User not found' });



    const { name, nameEn, email, role, phone, projects, language, isActive, password } = req.body;



    if (email && email.toLowerCase() !== user.email) {

      const exists = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } }).select('_id').lean();

      if (exists) return res.status(400).json({ message: 'Email already exists' });

      user.email = email.toLowerCase();

    }



    if (name) user.name = name;

    if (nameEn !== undefined) user.nameEn = nameEn;

    if (role) user.role = role;

    if (phone !== undefined) user.phone = phone;

    if (projects) user.projects = projects;

    if (language) user.language = language;

    if (typeof isActive === 'boolean') user.isActive = isActive;

    if (password) user.password = await hashPassword(password);



    await user.save();



    await logActivity({

      userId: req.user._id,

      action: `تعديل مستخدم: ${user.name}`,

      actionEn: `Updated user: ${user.name}`,

      entityType: 'User',

      entityId: user._id,

    });



    res.json(user.toSafeJSON());

  } catch (err) {

    next(err);

  }

}



export async function getUserStats(req, res, next) {

  try {

    const stats = await User.aggregate([

      { $match: { isActive: true } },

      { $group: { _id: '$role', count: { $sum: 1 } } },

    ]);

    res.json(stats);

  } catch (err) {

    next(err);

  }

}



export const ROLE_LABELS = {

  [ROLES.ADMIN]: { ar: 'مدير النظام', en: 'System Admin' },

  [ROLES.CHIEF_ACCOUNTANT]: { ar: 'مدير المحاسبين', en: 'Chief Accountant' },

  [ROLES.PROJECT_ACCOUNTANT]: { ar: 'محاسب المشروع', en: 'Project Accountant' },

  [ROLES.PROJECT_MANAGER]: { ar: 'مدير المشروع', en: 'Project Manager' },

};


