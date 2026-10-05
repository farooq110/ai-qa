export const permissions = {
  manageOrganization: "organization:manage",
  manageBilling: "billing:manage",
  manageUsers: "users:manage",
  manageProjects: "projects:manage",
  reviewTests: "tests:review",
  executeTests: "tests:execute"
} as const;

export type Permission = (typeof permissions)[keyof typeof permissions];

export type OrganizationRole = "ADMIN" | "QA" | "DEVELOPER";

export const regenerationModes = ["INCREMENTAL", "FULL"] as const;
export type RegenerationMode = (typeof regenerationModes)[number];