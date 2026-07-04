import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { ROLES } from '../constants/roles.js';
import { upload } from '../middleware/upload.js';
import * as authCtrl from '../controllers/authController.js';
import * as userCtrl from '../controllers/userController.js';
import * as projectCtrl from '../controllers/projectController.js';
import * as custodyCtrl from '../controllers/custodyController.js';
import * as invoiceCtrl from '../controllers/invoiceController.js';
import * as dashboardCtrl from '../controllers/dashboardController.js';
import * as ocrCtrl from '../controllers/ocrController.js';

const router = Router();

// Auth
router.post('/auth/login', authCtrl.login);
router.get('/auth/me', authenticate, authCtrl.me);
router.patch('/auth/profile', authenticate, authCtrl.updateProfile);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);

// Users (admin + approver role lists accountants/engineers)
// router.get('/users', authenticate, authorize(ROLES.ADMIN, ROLES.PROJECT_ACCOUNTANT, ROLES.CHIEF_ACCOUNTANT), userCtrl.listUsers);
router.get('/users', authenticate, authorize(ROLES.ADMIN), userCtrl.listUsers);
router.post('/users', authenticate, authorize(ROLES.ADMIN), userCtrl.createUser);
router.patch('/users/:id', authenticate, authorize(ROLES.ADMIN), userCtrl.updateUser);
router.get('/users/stats', authenticate, authorize(ROLES.ADMIN), userCtrl.getUserStats);

// Projects
router.get('/projects', authenticate, projectCtrl.listProjects);
router.get('/projects/budgets', authenticate, projectCtrl.projectBudgetSummary);
router.get('/projects/:id', authenticate, projectCtrl.getProject);
router.post('/projects', authenticate, authorize(ROLES.ADMIN), projectCtrl.createProject);
router.patch('/projects/:id', authenticate, authorize(ROLES.ADMIN), projectCtrl.updateProject);

// Custody
router.get('/admin/custody-transactions', authenticate, authorize(ROLES.ADMIN), custodyCtrl.listAdminTransactions);
router.get('/custodies/admin-transactions', authenticate, authorize(ROLES.ADMIN), custodyCtrl.listAdminTransactions);
router.get('/custodies', authenticate, custodyCtrl.listCustodies);
router.get('/custodies/open', authenticate, authorize(ROLES.PROJECT_MANAGER), custodyCtrl.getOpenCustody);
router.get('/custodies/disbursement-queue', authenticate, authorize(ROLES.ADMIN), custodyCtrl.listDisbursementQueue);
router.get('/custodies/my-transactions', authenticate, authorize(ROLES.PROJECT_MANAGER), custodyCtrl.listMyTransactions);
router.get('/custodies/cycle-stats', authenticate, authorize(ROLES.ADMIN), custodyCtrl.cycleStats);
router.get('/custodies/:id/transactions', authenticate, custodyCtrl.listCustodyTransactions);
router.get('/custodies/:id', authenticate, custodyCtrl.getCustody);
router.post('/custodies', authenticate, authorize(ROLES.PROJECT_MANAGER, ROLES.PROJECT_ACCOUNTANT, ROLES.ADMIN), upload.single('proof'), custodyCtrl.createCustody);
router.post('/custodies/:id/close', authenticate, authorize(ROLES.PROJECT_MANAGER), custodyCtrl.closeCustody);
router.post('/custodies/:id/pm-approve', authenticate, authorize(ROLES.PROJECT_ACCOUNTANT), custodyCtrl.approveCustodyPM);
router.post('/custodies/:id/settle', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), custodyCtrl.settleCustody);
router.post('/admin/custodies/:id/disburse', authenticate, authorize(ROLES.ADMIN), upload.single('proof'), custodyCtrl.disburseCustody);
router.post('/custodies/:id/confirm-disbursement', authenticate, authorize(ROLES.ADMIN), custodyCtrl.confirmDisbursement);
router.post('/custodies/:id/disburse', authenticate, authorize(ROLES.ADMIN), upload.single('proof'), custodyCtrl.disburseCustody);
router.patch('/custodies/:id', authenticate, authorize(ROLES.ADMIN), custodyCtrl.updateCustody);
router.post('/custodies/:id/top-up', authenticate, authorize(ROLES.ADMIN), upload.single('proof'), custodyCtrl.topUpCustody);

// Invoices
router.get('/invoices', authenticate, invoiceCtrl.listInvoices);
router.post('/invoices/batch-pm-review', authenticate, authorize(ROLES.PROJECT_ACCOUNTANT), invoiceCtrl.batchPmReviewInvoices);
router.post('/invoices/batch-review', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), invoiceCtrl.batchReviewInvoices);
router.get('/invoices/pending-finance', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), invoiceCtrl.pendingFinanceInvoices);
router.get('/invoices/rejected', authenticate, authorize(ROLES.PROJECT_MANAGER), invoiceCtrl.rejectedInvoices);
router.get('/invoices/:id', authenticate, invoiceCtrl.getInvoice);
router.post('/invoices', authenticate, authorize(ROLES.PROJECT_MANAGER), invoiceCtrl.createInvoice);
router.post('/invoices/upload', authenticate, authorize(ROLES.PROJECT_MANAGER), upload.array('files', 10), invoiceCtrl.createInvoice);
router.patch('/invoices/:id', authenticate, authorize(ROLES.PROJECT_MANAGER), invoiceCtrl.updateInvoice);
router.post('/invoices/:id/pm-review', authenticate, authorize(ROLES.PROJECT_ACCOUNTANT), invoiceCtrl.pmReviewInvoice);
router.post('/invoices/:id/review', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), invoiceCtrl.reviewInvoice);

// OCR
router.post('/ocr/scan', authenticate, authorize(ROLES.PROJECT_MANAGER), upload.single('file'), ocrCtrl.scanInvoice);
router.post('/ocr/text', authenticate, authorize(ROLES.PROJECT_MANAGER), ocrCtrl.scanInvoiceText);

// Dashboards
router.get('/dashboard/admin', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.adminDashboard);
router.get('/dashboard/finance', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), dashboardCtrl.financeDashboard);
router.get('/dashboard/project-manager', authenticate, authorize(ROLES.PROJECT_MANAGER), dashboardCtrl.projectAccountantDashboard);
router.get('/dashboard/project-accountant', authenticate, authorize(ROLES.PROJECT_ACCOUNTANT), dashboardCtrl.projectManagerDashboard);
router.get('/dashboard/project-accountant/approval-log', authenticate, authorize(ROLES.PROJECT_ACCOUNTANT), dashboardCtrl.paApprovalLog);
router.get('/dashboard/admin/analytics', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.adminAnalytics);
router.get('/dashboard/admin/reports', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.adminReports);
router.get('/dashboard/finance/reports', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), dashboardCtrl.financeReportsSummary);
router.get('/dashboard/finance/suppliers', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), dashboardCtrl.financeSuppliers);

// Finance extras
router.get('/admin/vouchers', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.listVouchers);
router.post('/admin/vouchers', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.createVoucher);
router.get('/vouchers', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.listVouchers);
router.post('/vouchers', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.createVoucher);
router.get('/archive/settled', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT, ROLES.ADMIN), dashboardCtrl.settledArchive);
router.get('/tax/compliance', authenticate, authorize(ROLES.CHIEF_ACCOUNTANT), dashboardCtrl.taxCompliance);

// Settings & notifications
router.get('/settings', authenticate, dashboardCtrl.getSettings);
router.patch('/settings', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.updateSettings);
router.get('/notifications', authenticate, dashboardCtrl.listNotifications);
router.patch('/notifications/:id/read', authenticate, dashboardCtrl.markNotificationRead);
router.get('/activity-logs', authenticate, authorize(ROLES.ADMIN), dashboardCtrl.listActivityLogs);

export default router;
