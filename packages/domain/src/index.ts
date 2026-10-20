// Values match the Prisma `OrganizationRole` enum; RolesService asserts they never drift.
export enum APP_ROLES {
  ADMIN = "ADMIN",
  QA = "QA",
  DEVELOPER = "DEVELOPER"
}

export type OrganizationRole = `${APP_ROLES}`;
export const appRoles: APP_ROLES[] = Object.values(APP_ROLES);
// ADMIN always has full access so an organization can never lock itself out.
export const editableRoles: APP_ROLES[] = [APP_ROLES.QA, APP_ROLES.DEVELOPER];

export const permissionModules = {
  dashboard: ["view"],
  projects: ["view", "create", "edit", "delete"],
  test_cases: ["view", "create", "edit", "delete", "approve"],
  executions: ["view", "run"],
  ci_cd: ["view", "create", "edit", "delete"],
  team: ["view", "manage"],
  billing: ["view", "manage"],
  settings: ["view", "manage"],
  roles: ["view", "manage"]
} as const satisfies Record<string, readonly string[]>;

export type PermissionModule = keyof typeof permissionModules;
export enum PERMISSIONS {
  DASHBOARD_VIEW = "dashboard:view",
  PROJECTS_VIEW = "projects:view",
  PROJECTS_CREATE = "projects:create",
  PROJECTS_EDIT = "projects:edit",
  PROJECTS_DELETE = "projects:delete",
  TEST_CASES_VIEW = "test_cases:view",
  TEST_CASES_CREATE = "test_cases:create",
  TEST_CASES_EDIT = "test_cases:edit",
  TEST_CASES_DELETE = "test_cases:delete",
  TEST_CASES_APPROVE = "test_cases:approve",
  EXECUTIONS_VIEW = "executions:view",
  EXECUTIONS_RUN = "executions:run",
  CI_CD_VIEW = "ci_cd:view",
  CI_CD_CREATE = "ci_cd:create",
  CI_CD_EDIT = "ci_cd:edit",
  CI_CD_DELETE = "ci_cd:delete",
  TEAM_VIEW = "team:view",
  TEAM_MANAGE = "team:manage",
  BILLING_VIEW = "billing:view",
  BILLING_MANAGE = "billing:manage",
  SETTINGS_VIEW = "settings:view",
  SETTINGS_MANAGE = "settings:manage",
  ROLES_VIEW = "roles:view",
  ROLES_MANAGE = "roles:manage"
}

export type Permission = PERMISSIONS;
export const allPermissions: Permission[] = Object.values(PERMISSIONS);

const permissionSet = new Set<string>(allPermissions);
export const isPermission = (value: unknown): value is Permission => typeof value === "string" && permissionSet.has(value);

const viewOnly = allPermissions.filter((permission) => permission.endsWith(":view"));
const without = (...removed: Permission[]) => allPermissions.filter((permission) => !removed.includes(permission));

export const defaultRolePermissions: Record<APP_ROLES, Permission[]> = {
  [APP_ROLES.ADMIN]: allPermissions,
  [APP_ROLES.QA]: without(PERMISSIONS.PROJECTS_DELETE, PERMISSIONS.TEAM_MANAGE, PERMISSIONS.BILLING_MANAGE, PERMISSIONS.ROLES_MANAGE, PERMISSIONS.SETTINGS_MANAGE),
  // Read-only access to the working modules; billing and role configuration stay hidden.
  [APP_ROLES.DEVELOPER]: viewOnly.filter((permission) => permission !== PERMISSIONS.BILLING_VIEW && permission !== PERMISSIONS.ROLES_VIEW)
};

export const regenerationModes = ["INCREMENTAL", "FULL"] as const;
export type RegenerationMode = (typeof regenerationModes)[number];
