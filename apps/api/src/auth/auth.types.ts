import type { OrganizationRole } from "@prisma/client";

export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
}

export interface AccessTokenPayload extends AuthenticatedUser {
  sub: string;
}