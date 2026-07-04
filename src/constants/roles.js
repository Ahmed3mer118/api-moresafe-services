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

/** PM may attach new invoices at any time — including after settlement */
export const PM_UPLOAD_CUSTODY_STATUSES = [
  CUSTODY_STATUS.OPEN,
  CUSTODY_STATUS.CLOSED,
  CUSTODY_STATUS.PM_REJECTED,
  CUSTODY_STATUS.PM_APPROVED,
  CUSTODY_STATUS.FINANCE_PENDING,
  CUSTODY_STATUS.FINANCE_REJECTED,
  CUSTODY_STATUS.SETTLED,
];

/** PM may submit accumulated invoices for PA review at any time */
export const PM_SUBMIT_CUSTODY_STATUSES = [
  CUSTODY_STATUS.OPEN,
  CUSTODY_STATUS.CLOSED,
  CUSTODY_STATUS.PM_REJECTED,
  CUSTODY_STATUS.PM_APPROVED,
  CUSTODY_STATUS.FINANCE_PENDING,
  CUSTODY_STATUS.FINANCE_REJECTED,
  CUSTODY_STATUS.SETTLED,
];

/** Custodies processed by project accountant — shown in PA archive */
export const PA_ARCHIVED_CUSTODY_STATUSES = [
  CUSTODY_STATUS.PM_APPROVED,
  CUSTODY_STATUS.PM_REJECTED,
  CUSTODY_STATUS.FINANCE_PENDING,
  CUSTODY_STATUS.SETTLED,
  CUSTODY_STATUS.FINANCE_REJECTED,
];

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
