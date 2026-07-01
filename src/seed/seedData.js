import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Project from '../models/Project.js';
import Settings from '../models/Settings.js';
import { connectDB } from '../config/database.js';
import { ROLES } from '../constants/roles.js';
import { hashPassword } from '../utils/password.js';

dotenv.config();

async function seed() {
  await connectDB();

  await Promise.all([
    User.deleteMany({}),
    Project.deleteMany({}),
    Settings.deleteMany({}),
  ]);

  const settings = await Settings.create({
    companyName: 'Moresafe',
    companyNameEn: 'Moresafe',
    taxNumber: '310000000000003',
    primaryColor: '#2e9e5b',
  });

  const admin = await User.create({
    name: 'إبراهيم الراشد',
    nameEn: 'Ibrahim Al-Rashid',
    email: 'admin@erp.com',
    password: await hashPassword('adminSystem'),
    role: ROLES.ADMIN,
    language: 'ar',
  });

  const chiefAccountant = await User.create({
    name: 'أ. فاطمة يوسف',
    nameEn: 'Fatima Youssef',
    email: 'mangerAccounters@erp.com',
    password: await hashPassword('manger1123456'),
    role: ROLES.CHIEF_ACCOUNTANT,
    language: 'ar',
  });

  const projectManager = await User.create({
    name: 'م. خالد عبدالله',
    nameEn: 'Khaled Abdullah',
    email: 'projectmanger@erp.com',
    password: await hashPassword('projectmanger123'),
    role: ROLES.PROJECT_MANAGER,
    language: 'ar',
  });

  const projectAccountant = await User.create({
    name: 'م. أحمد سالم',
    nameEn: 'Ahmed Salem',
    email: 'projectaccounter@erp.com',
    password: await hashPassword('projectmanger123'),
    role: ROLES.PROJECT_ACCOUNTANT,
    language: 'ar',
  });

  const projectAccountant2 = await User.create({
    name: 'سعيد ناصر',
    nameEn: 'Saeed Nasser',
    email: 'saeed@erp.com',
    password: await hashPassword('projectmanger123'),
    role: ROLES.PROJECT_ACCOUNTANT,
    language: 'ar',
    isActive: true,
  });

  const projects = await Project.insertMany([
    {
      name: 'برج الواحة',
      nameEn: 'Al-Waha Tower',
      code: 'P001',
      budget: 120000,
      spent: 78000,
      status: 'active',
      manager: projectManager._id,
      accountants: [projectAccountant._id],
    },
    {
      name: 'فيلا النخيل',
      nameEn: 'Palm Villa',
      code: 'P002',
      budget: 60000,
      spent: 42000,
      status: 'active',
      manager: projectManager._id,
      accountants: [projectAccountant2._id],
    },
    {
      name: 'مجمع الياسمين',
      nameEn: 'Jasmine Complex',
      code: 'P003',
      budget: 65000,
      spent: 61000,
      status: 'near_budget',
      manager: projectManager._id,
      accountants: [projectAccountant._id],
    },
    {
      name: 'مول الربوة',
      nameEn: 'Al-Rabwa Mall',
      code: 'P004',
      budget: 90000,
      spent: 33000,
      status: 'new',
      manager: projectManager._id,
      accountants: [projectAccountant._id],
    },
  ]);

  await User.findByIdAndUpdate(projectManager._id, {
    projects: projects.map((p) => p._id),
  });
  await User.findByIdAndUpdate(projectAccountant._id, {
    projects: [projects[0]._id, projects[2]._id, projects[3]._id],
  });
  await User.findByIdAndUpdate(projectAccountant2._id, {
    projects: [projects[1]._id],
  });

  console.log('Seed completed successfully');
  console.log('Users:');
  console.log('  admin@erp.com / adminSystem');
  console.log('  mangerAccounters@erp.com / manger1123456');
  console.log('  projectmanger@erp.com / projectmanger123');
  console.log('  projectaccounter@erp.com / projectmanger123');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
