export const ROLES = {
  ADMIN: 'admin',
  CHIEF_ACCOUNTANT: 'chief_accountant',
  PROJECT_ACCOUNTANT: 'project_accountant',
  PROJECT_MANAGER: 'project_manager',
};

export const ROLE_DASHBOARD = {
  [ROLES.ADMIN]: '/dashboard/admin',
  [ROLES.CHIEF_ACCOUNTANT]: '/dashboard/finance',
  [ROLES.PROJECT_ACCOUNTANT]: '/dashboard/project-accountant',
  [ROLES.PROJECT_MANAGER]: '/dashboard/project-manager',
};

export const CUSTODY_STATUS = {
  OPEN: 'open',
  CLOSED: 'closed',
  PM_APPROVED: 'pm_approved',
  PM_REJECTED: 'pm_rejected',
  FINANCE_PENDING: 'finance_pending',
  SETTLED: 'settled',
  FINANCE_REJECTED: 'finance_rejected',
};

export const INVOICE_STATUS = {
  DRAFT: 'draft',
  ACCUMULATED: 'accumulated',
  PENDING_PM: 'pending_pm',
  PM_APPROVED: 'pm_approved',
  PM_REJECTED: 'pm_rejected',
  PENDING_FINANCE: 'pending_finance',
  FINANCE_APPROVED: 'finance_approved',
  FINANCE_REJECTED: 'finance_rejected',
  SETTLED: 'settled',
};
